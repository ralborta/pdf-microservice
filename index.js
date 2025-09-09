// CloudConvert → PDF→XLSX microservicio ROBUSTO y PROFESIONAL
const express = require('express');
const cors = require('cors');
const CloudConvert = require('cloudconvert');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ========== CONFIGURACIÓN ==========
const config = {
  maxFileSize: process.env.MAX_FILE_SIZE || '10MB',
  jobTimeout: parseInt(process.env.JOB_TIMEOUT) || 120000,
  rateLimit: {
    window: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 10
  },
  cloudconvert: {
    engine: process.env.CLOUDCONVERT_ENGINE || 'advanced',
    ocr: process.env.CLOUDCONVERT_OCR === 'true',
    ocrLanguage: process.env.CLOUDCONVERT_OCR_LANG || 'es'
  }
};

// ========== MÉTRICAS Y MONITOREO ==========
const metrics = {
  totalRequests: 0,
  successfulConversions: 0,
  failedConversions: 0,
  averageProcessingTime: 0,
  startTime: Date.now()
};

// ========== RATE LIMITING ==========
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = config.rateLimit.window;
const MAX_REQUESTS = config.rateLimit.max;

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = rateLimit.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS) {
    throw new Error('Rate limit exceeded - demasiadas peticiones');
  }
  
  recentRequests.push(now);
  rateLimit.set(ip, recentRequests);
}

// ========== VALIDACIÓN DE PDF ==========
function validatePdfBase64(base64) {
  if (!base64 || base64.length < 100) {
    throw new Error('Base64 muy corto o vacío');
  }
  
  // Verificar que sea PDF válido
  try {
    const pdfHeader = Buffer.from(base64.substring(0, 4), 'base64').toString();
    if (!pdfHeader.startsWith('%PDF')) {
      throw new Error('No es un PDF válido - debe empezar con %PDF');
    }
  } catch (e) {
    throw new Error('Base64 inválido');
  }
  
  // Verificar tamaño (máximo 10MB)
  const sizeInBytes = (base64.length * 3) / 4;
  if (sizeInBytes > 10 * 1024 * 1024) {
    throw new Error('PDF muy grande (máximo 10MB)');
  }
  
  return sizeInBytes;
}

// ========== LOGGING MEJORADO ==========
function logRequest(req, startTime, result, error = null) {
  const duration = Date.now() - startTime;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const status = error ? 'ERROR' : 'SUCCESS';
  const level = error ? '❌' : '✅';
  
  console.log(`${level} [${new Date().toISOString()}] ${req.method} ${req.path} - ${status} - ${duration}ms - IP: ${ip}`);
  
  if (error) {
    console.error(`   Error: ${error.message}`);
  }
}

// ========== MÉTRICAS ==========
function updateMetrics(success, processingTime) {
  metrics.totalRequests++;
  if (success) {
    metrics.successfulConversions++;
  } else {
    metrics.failedConversions++;
  }
  
  metrics.averageProcessingTime = 
    (metrics.averageProcessingTime + processingTime) / 2;
}

// ========== CLOUDCONVERT SETUP ==========
if (!process.env.CLOUDCONVERT_API_KEY) {
  console.warn('⚠️  Falta CLOUDCONVERT_API_KEY en .env');
}
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// ========== HELPER FUNCTIONS ==========
function cleanBase64(input) {
  if (!input) return '';
  return input.includes('base64,') ? input.split('base64,').pop() : input;
}

function safePdfName(name = 'documento.pdf') {
  const n = (name || 'documento').trim();
  return n.toLowerCase().endsWith('.pdf') ? n : `${n}.pdf`;
}

function assertJobOk(job) {
  const failed = (job.tasks || []).filter(t => t.status === 'error');
  if (failed.length) {
    const why = failed
      .map(t => `[${t.name || t.operation}] ${t.message || t.code || 'error'}`)
      .join(' | ');
    const err = new Error(`CloudConvert job failed: ${why}`);
    err.cc_details = failed;
    throw err;
  }
}

async function waitJobWithTimeout(jobId, timeout = config.jobTimeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const job = await cloudConvert.jobs.get(jobId);
    if (job.status === 'finished') return job;
    if (job.status === 'error') throw new Error('Job failed');
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s entre checks
  }
  throw new Error(`Job timeout después de ${timeout}ms`);
}

async function downloadToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Descarga falló (${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return { base64: buf.toString('base64'), bytes: buf.length };
}

// ========== MIDDLEWARE DE SEGURIDAD ==========
app.use('/extract-pdf', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(400).json({ 
      success: false,
      error: 'Content-Type debe ser application/json' 
    });
  }
  next();
});

// ========== ENDPOINT PRINCIPAL: devuelve XLSX en base64 ==========
app.post('/extract-pdf', async (req, res) => {
  const startTime = Date.now();
  let success = false;
  
  try {
    // Rate limiting
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    checkRateLimit(ip);
    
    const { pdfBase64, filename } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ 
        success: false, 
        error: 'pdfBase64 requerido' 
      });
    }

    // Validar PDF
    const fileSize = validatePdfBase64(pdfBase64);
    const base64Clean = cleanBase64(pdfBase64);
    const safeName = safePdfName(filename);

    console.log(`[CloudConvert] Procesando ${safeName} (${(fileSize/1024).toFixed(2)} KB)...`);

    // 1) Crear Job: import(base64) -> convert(pdf→xlsx) -> export(url)
    let job = await cloudConvert.jobs.create({
      tasks: {
        'import-file': {
          operation: 'import/base64',
          file: base64Clean,
          filename: safeName
        },
        'convert-to-xlsx': {
          operation: 'convert',
          input: 'import-file',
          input_format: 'pdf',
          output_format: 'xlsx',
          engine: config.cloudconvert.engine,
          ...(config.cloudconvert.ocr && {
            ocr: true,
            ocr_language: config.cloudconvert.ocrLanguage
          })
        },
        'export-file': {
          operation: 'export/url',
          input: 'convert-to-xlsx'
        }
      }
    });

    console.log(`[CloudConvert] Job creado: ${job.id}`);

    // 2) Esperar job con timeout + validar tareas
    job = await waitJobWithTimeout(job.id);
    assertJobOk(job);
    console.log(`[CloudConvert] Job completado en ${(Date.now() - startTime)/1000}s`);

    // 3) Tomar export/url
    const exportTask = (job.tasks || []).find(
      t => t.operation === 'export/url' && t.status === 'finished'
    );
    if (!exportTask?.result?.files?.length) {
      throw new Error('export/url sin archivos');
    }

    const file = exportTask.result.files[0]; // { url, filename, size }
    
    // 4) Descargar XLSX y convertir a base64
    const { base64, bytes } = await downloadToBase64(file.url);

    success = true;
    updateMetrics(true, Date.now() - startTime);
    logRequest(req, startTime, { status: 'SUCCESS' });

    return res.json({
      success: true,
      excel: base64,
      downloadUrl: file.url, // por si prefieres no base64 en front
      filename: safeName.replace(/\.pdf$/i, '.xlsx'),
      stats: { 
        bytes, 
        remoteName: file.filename,
        processingTime: `${((Date.now() - startTime)/1000).toFixed(2)}s`,
        fileSize: `${(fileSize/1024).toFixed(2)} KB`
      },
      jobId: job.id,
      credits: job.credits || 0
    });
    
  } catch (err) {
    success = false;
    updateMetrics(false, Date.now() - startTime);
    logRequest(req, startTime, { status: 'ERROR' }, err);
    
    const status = err?.status || err?.statusCode || 500;
    const isRateLimit = err.message.includes('Rate limit');
    const isValidation = err.message.includes('PDF') || err.message.includes('Base64');
    
    return res.status(isRateLimit ? 429 : isValidation ? 400 : status === 422 ? 422 : 500).json({
      success: false,
      error: isRateLimit ? 'Demasiadas peticiones - intenta más tarde' :
             isValidation ? err.message :
             status === 422 ? 'CloudConvert 422 - parámetros inválidos' : 
             'Error procesando PDF',
      details: err.message || err,
      ...(err.cc_details && { cloudconvert_details: err.cc_details })
    });
  }
});

// ========== ALTERNATIVO: devuelve XLSX + JSON de TODAS las hojas ==========
app.post('/extract-pdf-with-processing', async (req, res) => {
  const startTime = Date.now();
  let success = false;
  
  try {
    // Rate limiting
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    checkRateLimit(ip);
    
    const { pdfBase64, filename } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ 
        success: false, 
        error: 'pdfBase64 requerido' 
      });
    }

    // Validar PDF
    const fileSize = validatePdfBase64(pdfBase64);
    const base64Clean = cleanBase64(pdfBase64);
    const safeName = safePdfName(filename);

    console.log(`[CloudConvert] Procesando ${safeName} con parsing (${(fileSize/1024).toFixed(2)} KB)...`);

    let job = await cloudConvert.jobs.create({
      tasks: {
        'import-file': { 
          operation: 'import/base64', 
          file: base64Clean, 
          filename: safeName 
        },
        'convert-to-xlsx': {
          operation: 'convert',
          input: 'import-file',
          input_format: 'pdf',
          output_format: 'xlsx',
          engine: config.cloudconvert.engine,
          ...(config.cloudconvert.ocr && {
            ocr: true,
            ocr_language: config.cloudconvert.ocrLanguage
          })
        },
        'export-file': { 
          operation: 'export/url', 
          input: 'convert-to-xlsx' 
        }
      }
    });

    job = await waitJobWithTimeout(job.id);
    assertJobOk(job);

    const exportTask = (job.tasks || []).find(
      t => t.operation === 'export/url' && t.status === 'finished'
    );
    if (!exportTask?.result?.files?.length) throw new Error('export/url sin archivos');

    const file = exportTask.result.files[0];
    const resp = await fetch(file.url);
    if (!resp.ok) throw new Error(`Descarga falló (${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const excelBase64 = buf.toString('base64');

    // Parsear TODAS las hojas
    const XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const productos = [];
    for (const sheetName of wb.SheetNames) {
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      for (const r of rows) productos.push({ ...r, _sheet: sheetName });
    }

    success = true;
    updateMetrics(true, Date.now() - startTime);
    logRequest(req, startTime, { status: 'SUCCESS' });

    return res.json({
      success: true,
      excel: excelBase64,
      productos,
      filename: safeName.replace(/\.pdf$/i, '.xlsx'),
      jobId: job.id,
      sheetCount: wb.SheetNames.length,
      stats: {
        totalRows: productos.length,
        processingTime: `${((Date.now() - startTime)/1000).toFixed(2)}s`,
        fileSize: `${(fileSize/1024).toFixed(2)} KB`
      },
      credits: job.credits || 0
    });
    
  } catch (err) {
    success = false;
    updateMetrics(false, Date.now() - startTime);
    logRequest(req, startTime, { status: 'ERROR' }, err);
    
    const status = err?.status || err?.statusCode || 500;
    const isRateLimit = err.message.includes('Rate limit');
    const isValidation = err.message.includes('PDF') || err.message.includes('Base64');
    
    return res.status(isRateLimit ? 429 : isValidation ? 400 : status === 422 ? 422 : 500).json({
      success: false,
      error: isRateLimit ? 'Demasiadas peticiones - intenta más tarde' :
             isValidation ? err.message :
             status === 422 ? 'CloudConvert 422 - parámetros inválidos' : 
             'Error procesando PDF',
      details: err.message || err,
      ...(err.cc_details && { cloudconvert_details: err.cc_details })
    });
  }
});

// ========== HEALTH CHECK CON MÉTRICAS ==========
app.get('/health', async (_req, res) => {
  try {
    const user = await cloudConvert.users.me();
    const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
    
    res.json({
      ok: true,
      uptime: `${uptime}s`,
      user: { 
        email: user.email, 
        credits: user.credits, 
        minutes: user.minutes 
      },
      metrics: {
        totalRequests: metrics.totalRequests,
        successfulConversions: metrics.successfulConversions,
        failedConversions: metrics.failedConversions,
        successRate: metrics.totalRequests > 0 ? 
          `${((metrics.successfulConversions / metrics.totalRequests) * 100).toFixed(2)}%` : '0%',
        averageProcessingTime: `${metrics.averageProcessingTime.toFixed(2)}ms`
      },
      config: {
        maxFileSize: config.maxFileSize,
        jobTimeout: `${config.jobTimeout/1000}s`,
        rateLimit: `${MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW/1000}s`,
        engine: config.cloudconvert.engine,
        ocr: config.cloudconvert.ocr
      },
      endpoints: {
        'POST /extract-pdf': 'Excel en base64 + downloadUrl',
        'POST /extract-pdf-with-processing': 'Excel + JSON de todas las hojas',
        'GET /metrics': 'Métricas detalladas'
      }
    });
  } catch (e) {
    res.status(503).json({ 
      ok: false, 
      error: 'CloudConvert no conectado',
      details: e.message 
    });
  }
});

// ========== ENDPOINT DE MÉTRICAS ==========
app.get('/metrics', (_req, res) => {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  
  res.json({
    timestamp: new Date().toISOString(),
    uptime: `${uptime}s`,
    metrics: {
      ...metrics,
      successRate: metrics.totalRequests > 0 ? 
        ((metrics.successfulConversions / metrics.totalRequests) * 100).toFixed(2) + '%' : '0%'
    },
    rateLimit: {
      activeUsers: rateLimit.size,
      window: `${RATE_LIMIT_WINDOW/1000}s`,
      maxRequests: MAX_REQUESTS
    }
  });
});

// ========== INICIAR SERVIDOR ==========
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   🚀 CloudConvert Microservice ROBUSTO y PROFESIONAL      ║
╠════════════════════════════════════════════════════════════╣
║   Puerto: ${PORT}                                              ║
║   Engine: ${config.cloudconvert.engine}                              ║
║   OCR: ${config.cloudconvert.ocr ? 'Habilitado' : 'Deshabilitado'}                    ║
║   Rate Limit: ${MAX_REQUESTS} req/${RATE_LIMIT_WINDOW/1000}s                    ║
║   Max File: ${config.maxFileSize}                              ║
╠════════════════════════════════════════════════════════════╣
║   Endpoints:                                               ║
║   • POST /extract-pdf (Excel base64)                      ║
║   • POST /extract-pdf-with-processing (Excel + JSON)      ║
║   • GET /health (Estado + métricas)                       ║
║   • GET /metrics (Métricas detalladas)                    ║
╚════════════════════════════════════════════════════════════╝
  `);
});