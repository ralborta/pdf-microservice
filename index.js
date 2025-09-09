// CloudConvert → PDF→XLSX microservicio HÍBRIDO (Elegante + Esencial)
const express = require('express');
const cors = require('cors');
const CloudConvert = require('cloudconvert');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ========== CONFIGURACIÓN ESENCIAL ==========
const config = {
  jobTimeout: parseInt(process.env.JOB_TIMEOUT) || 120000,
  rateLimit: {
    window: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 10
  }
};

// ========== MÉTRICAS BÁSICAS ==========
const metrics = {
  totalRequests: 0,
  successfulConversions: 0,
  failedConversions: 0,
  startTime: Date.now()
};

// ========== RATE LIMITING SIMPLE ==========
const rateLimit = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = rateLimit.get(ip) || [];
  const recentRequests = userRequests.filter(time => now - time < config.rateLimit.window);
  
  if (recentRequests.length >= config.rateLimit.max) {
    throw new Error('Rate limit exceeded - demasiadas peticiones');
  }
  
  recentRequests.push(now);
  rateLimit.set(ip, recentRequests);
}

// ========== CLOUDCONVERT SETUP ==========
if (!process.env.CLOUDCONVERT_API_KEY) {
  console.warn('⚠️ Falta CLOUDCONVERT_API_KEY en .env');
}
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

/* ---------------- Helpers Elegantes ---------------- */

// Acepta data URL o base64 plano; remueve espacios/line breaks
function cleanBase64(input) {
  if (!input) return '';
  let s = input.includes('base64,') ? input.split('base64,').pop() : input;
  s = s.replace(/\s+/g, '');
  return s;
}

// Verifica alfabeto y padding de base64
function isValidBase64(s) {
  if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  return true;
}

// Heurística: PDFs suelen empezar con %PDF, que en base64 es "JVBERi0"
function looksLikePdf(base64) {
  return base64.startsWith('JVBERi0');
}

// Lanza error claro si el base64 no es decodificable o no parece PDF
function ensurePdfBase64OrThrow(b64) {
  if (!b64 || b64.length < 64) throw new Error('Base64 demasiado corto');
  if (!isValidBase64(b64)) throw new Error('Base64 contiene caracteres inválidos o padding incorrecto');
  try {
    const headAscii = Buffer.from(b64.slice(0, 64), 'base64').toString('ascii');
    if (!headAscii.startsWith('%PDF') && !looksLikePdf(b64)) {
      throw new Error('No parece un PDF (falta cabecera %PDF)');
    }
  } catch {
    throw new Error('Base64 no decodifica correctamente');
  }
}

// Asegura extensión .pdf para ayudar a CloudConvert
function safePdfName(name = 'documento.pdf') {
  const n = (name || 'documento').trim();
  return n.toLowerCase().endsWith('.pdf') ? n : `${n}.pdf`;
}

// Revisa tasks del job y arroja detalle si alguna falló
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

// Timeout personalizable para jobs
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

// Descarga a buffer y devuelve base64 + tamaño
async function downloadToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Descarga falló (${resp.status})`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return { base64: buf.toString('base64'), bytes: buf.length, buf };
}

// Logging simple pero efectivo
function logRequest(req, startTime, success, error = null) {
  const duration = Date.now() - startTime;
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const status = success ? '✅' : '❌';
  console.log(`${status} [${new Date().toISOString()}] ${req.method} ${req.path} - ${duration}ms - IP: ${ip}`);
  if (error) console.error(`   Error: ${error.message}`);
}

// Actualizar métricas
function updateMetrics(success) {
  metrics.totalRequests++;
  if (success) {
    metrics.successfulConversions++;
  } else {
    metrics.failedConversions++;
  }
}

/* ---------------- Endpoints ---------------- */

// 1) Devuelve XLSX en base64 + downloadUrl
app.post('/extract-pdf', async (req, res) => {
  const startTime = Date.now();
  let success = false;
  
  try {
    // Rate limiting
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    checkRateLimit(ip);
    
    const { pdfBase64, filename } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ success: false, error: 'pdfBase64 requerido' });
    }

    const base64Clean = cleanBase64(pdfBase64);
    ensurePdfBase64OrThrow(base64Clean);
    const safeName = safePdfName(filename);

    console.log(`[CloudConvert] Procesando ${safeName}...`);

    // Job: import(base64) -> convert(pdf→xlsx) -> export(url)
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
          output_format: 'xlsx'
          // Si tu plan soporta OCR y el PDF es escaneado:
          // ocr: true,
          // ocr_language: 'es'
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

    const file = exportTask.result.files[0]; // { url, filename, size }
    const { base64, bytes } = await downloadToBase64(file.url);

    success = true;
    updateMetrics(true);
    logRequest(req, startTime, true);

    return res.json({
      success: true,
      excel: base64,
      downloadUrl: file.url, // útil si no querés base64 en el front
      filename: safeName.replace(/\.pdf$/i, '.xlsx'),
      stats: { 
        bytes, 
        remoteName: file.filename,
        processingTime: `${((Date.now() - startTime)/1000).toFixed(2)}s`
      },
      jobId: job.id,
      credits: job.credits || 0
    });
  } catch (err) {
    success = false;
    updateMetrics(false);
    logRequest(req, startTime, false, err);
    
    const status = err?.status || err?.statusCode || 400;
    const isRateLimit = err.message.includes('Rate limit');
    
    return res.status(isRateLimit ? 429 : status === 422 ? 422 : status).json({
      success: false,
      error: isRateLimit ? 'Demasiadas peticiones - intenta más tarde' : 
             err.message || 'Error procesando PDF',
      ...(err.cc_details && { cloudconvert_details: err.cc_details })
    });
  }
});

// 2) Devuelve XLSX + JSON de TODAS las hojas
app.post('/extract-pdf-with-processing', async (req, res) => {
  const startTime = Date.now();
  let success = false;
  
  try {
    // Rate limiting
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    checkRateLimit(ip);
    
    const { pdfBase64, filename } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ success: false, error: 'pdfBase64 requerido' });
    }

    const base64Clean = cleanBase64(pdfBase64);
    ensurePdfBase64OrThrow(base64Clean);
    const safeName = safePdfName(filename);

    console.log(`[CloudConvert] Procesando ${safeName} con parsing...`);

    let job = await cloudConvert.jobs.create({
      tasks: {
        'import-file': { operation: 'import/base64', file: base64Clean, filename: safeName },
        'convert-to-xlsx': { operation: 'convert', input: 'import-file', input_format: 'pdf', output_format: 'xlsx' },
        'export-file': { operation: 'export/url', input: 'convert-to-xlsx' }
      }
    });

    job = await waitJobWithTimeout(job.id);
    assertJobOk(job);

    const exportTask = (job.tasks || []).find(
      t => t.operation === 'export/url' && t.status === 'finished'
    );
    if (!exportTask?.result?.files?.length) throw new Error('export/url sin archivos');

    const file = exportTask.result.files[0];
    const { base64, buf } = await downloadToBase64(file.url);

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
    updateMetrics(true);
    logRequest(req, startTime, true);

    return res.json({
      success: true,
      excel: base64,
      productos,
      filename: safeName.replace(/\.pdf$/i, '.xlsx'),
      jobId: job.id,
      sheetCount: wb.SheetNames.length,
      stats: {
        totalRows: productos.length,
        processingTime: `${((Date.now() - startTime)/1000).toFixed(2)}s`
      },
      credits: job.credits || 0
    });
  } catch (err) {
    success = false;
    updateMetrics(false);
    logRequest(req, startTime, false, err);
    
    const status = err?.status || err?.statusCode || 400;
    const isRateLimit = err.message.includes('Rate limit');
    
    return res.status(isRateLimit ? 429 : status === 422 ? 422 : status).json({
      success: false,
      error: isRateLimit ? 'Demasiadas peticiones - intenta más tarde' : 
             err.message || 'Error procesando PDF',
      ...(err.cc_details && { cloudconvert_details: err.cc_details })
    });
  }
});

// 3) Health con métricas básicas
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
          `${((metrics.successfulConversions / metrics.totalRequests) * 100).toFixed(2)}%` : '0%'
      },
      rateLimit: {
        maxRequests: config.rateLimit.max,
        window: `${config.rateLimit.window/1000}s`
      },
      endpoints: {
        'POST /extract-pdf': 'Excel en base64 + downloadUrl',
        'POST /extract-pdf-with-processing': 'Excel + JSON de todas las hojas'
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   🚀 CloudConvert Microservice HÍBRIDO                    ║
╠════════════════════════════════════════════════════════════╣
║   Puerto: ${PORT}                                              ║
║   Rate Limit: ${config.rateLimit.max} req/${config.rateLimit.window/1000}s                    ║
║   Timeout: ${config.jobTimeout/1000}s                              ║
╠════════════════════════════════════════════════════════════╣
║   Endpoints:                                               ║
║   • POST /extract-pdf (Excel base64)                      ║
║   • POST /extract-pdf-with-processing (Excel + JSON)      ║
║   • GET /health (Estado + métricas)                       ║
╚════════════════════════════════════════════════════════════╝
  `);
});