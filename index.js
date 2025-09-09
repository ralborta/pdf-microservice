// MICROSERVICIO CORREGIDO - DEVUELVE EXCEL
const express = require('express');
const cors = require('cors');
const CloudConvert = require('cloudconvert');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// ========== ENDPOINT PRINCIPAL - DEVUELVE EXCEL ==========
app.post('/extract-pdf', async (req, res) => {
  try {
    const { pdfBase64, filename = 'documento.pdf' } = req.body;
    
    console.log(`[CloudConvert] Procesando ${filename}...`);
    
    // Limpiar base64
    const base64Clean = pdfBase64.replace(/^data:.*,/, '');
    
    // PASO 1: Crear job de conversión PDF → Excel
    let job = await cloudConvert.jobs.create({
      "tasks": {
        "import-pdf": {
          "operation": "import/base64",
          "file": base64Clean,
          "filename": filename
        },
        "convert-to-excel": {
          "operation": "convert",
          "input": "import-pdf",
          "input_format": "pdf",
          "output_format": "xlsx",
          "engine": "advanced",  // Mejor detección de tablas
          "pages": "all"
        },
        "export-excel": {
          "operation": "export/url",
          "input": "convert-to-excel"
        }
      }
    });
    
    console.log(`[CloudConvert] Job creado: ${job.id}`);
    
    // PASO 2: Esperar resultado
    job = await cloudConvert.jobs.wait(job.id);
    console.log(`[CloudConvert] Job completado`);
    
    // PASO 3: Obtener URL del Excel generado
    const exportTask = job.tasks.find(
      task => task.operation === 'export/url' && task.status === 'finished'
    );
    
    if (!exportTask || !exportTask.result || !exportTask.result.files) {
      throw new Error('No se pudo obtener el archivo Excel');
    }
    
    const excelFile = exportTask.result.files[0];
    console.log(`[CloudConvert] Descargando Excel: ${excelFile.filename}`);
    
    // PASO 4: Descargar el Excel
    const response = await fetch(excelFile.url);
    if (!response.ok) {
      throw new Error('Error descargando Excel de CloudConvert');
    }
    
    const excelBuffer = await response.arrayBuffer();
    
    // PASO 5: Convertir a base64 para enviar a Vercel
    const excelBase64 = Buffer.from(excelBuffer).toString('base64');
    
    console.log(`[CloudConvert] Excel listo: ${(excelBuffer.byteLength / 1024).toFixed(2)} KB`);
    
    // PASO 6: DEVOLVER EL EXCEL EN BASE64
    res.json({
      success: true,
      excel: excelBase64,  // ← EXCEL LISTO PARA DESCARGAR
      filename: filename.replace('.pdf', '.xlsx'),
      mensaje: 'PDF convertido exitosamente a Excel',
      estadisticas: {
        tamaño: `${(excelBuffer.byteLength / 1024).toFixed(2)} KB`,
        metodo: 'CloudConvert',
        jobId: job.id,
        tiempo: job.ended_at ? 
          `${(new Date(job.ended_at) - new Date(job.created_at)) / 1000}s` : 
          'N/A'
      },
      costo: {
        creditos: job.credits || 0,
        estimado: job.credits > 0 ? `$${(job.credits * 0.005).toFixed(3)}` : '$0.00 (gratis)'
      }
    });
    
  } catch (error) {
    console.error('[CloudConvert] Error:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Error procesando PDF',
      detalles: 'Verifica que el PDF contenga tablas válidas'
    });
  }
});

// ========== ENDPOINT ALTERNATIVO - CON PROCESAMIENTO ==========
app.post('/extract-pdf-with-processing', async (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    
    // Igual que arriba pero además parsea el Excel
    const base64Clean = pdfBase64.replace(/^data:.*,/, '');
    
    let job = await cloudConvert.jobs.create({
      "tasks": {
        "import-pdf": {
          "operation": "import/base64",
          "file": base64Clean,
          "filename": filename
        },
        "convert-to-excel": {
          "operation": "convert",
          "input": "import-pdf",
          "input_format": "pdf",
          "output_format": "xlsx",
          "engine": "advanced",
          "pages": "all"
        },
        "export-excel": {
          "operation": "export/url",
          "input": "convert-to-excel"
        }
      }
    });
    
    job = await cloudConvert.jobs.wait(job.id);
    
    const exportTask = job.tasks.find(
      task => task.operation === 'export/url' && task.status === 'finished'
    );
    
    const excelFile = exportTask.result.files[0];
    const response = await fetch(excelFile.url);
    const excelBuffer = await response.arrayBuffer();
    const excelBase64 = Buffer.from(excelBuffer).toString('base64');
    
    // Después de obtener el Excel, parsearlo
    const XLSX = require('xlsx');
    const workbook = XLSX.read(excelBuffer);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const productos = XLSX.utils.sheet_to_json(sheet);
    
    // Devolver AMBOS: Excel Y productos JSON
    res.json({
      success: true,
      excel: excelBase64,  // Excel original
      productos: productos, // Datos parseados
      filename: filename.replace('.pdf', '.xlsx')
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== HEALTH CHECK ==========
app.get('/health', async (req, res) => {
  try {
    const user = await cloudConvert.users.me();
    res.json({
      status: 'OK',
      cloudconvert: {
        connected: true,
        email: user.email,
        credits: user.credits,
        minutes_used: user.minutes
      },
      endpoints: {
        '/extract-pdf': 'Devuelve Excel en base64',
        '/extract-pdf-with-processing': 'Devuelve Excel + JSON'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      error: 'CloudConvert no conectado'
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   CloudConvert Microservice                ║
║   Puerto: ${PORT}                              ║
║   Devuelve: Excel en base64                ║
╚════════════════════════════════════════════╝
  `);
});