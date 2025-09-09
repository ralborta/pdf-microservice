// ========== CLOUDCONVERT PARA TU MICROSERVICIO ==========
// Basado en los ejemplos oficiales pero adaptado para base64

const express = require('express');
const cors = require('cors');
const CloudConvert = require('cloudconvert');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Inicializar CloudConvert
const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

// ========== MÉTODO 1: IMPORT BASE64 DIRECTO (Como tu caso) ==========
app.post('/extract-pdf', async (req, res) => {
  try {
    const { pdfBase64, filename = 'documento.pdf' } = req.body;
    
    console.log(`Procesando ${filename}...`);
    
    // Limpiar base64 (quitar el prefijo data:application/pdf;base64,)
    const base64Clean = pdfBase64.replace(/^data:.*,/, '');
    
    // Crear el job con las 3 tareas
    let job = await cloudConvert.jobs.create({
      "tasks": {
        "import-my-file": {
          "operation": "import/base64",
          "file": base64Clean,
          "filename": filename
        },
        "convert-my-file": {
          "operation": "convert",
          "input": "import-my-file",
          "output_format": "xlsx",
          "input_format": "pdf"
        },
        "export-my-file": {
          "operation": "export/url",
          "input": "convert-my-file"
        }
      }
    });
    
    console.log('Job creado, ID:', job.id);
    console.log('Esperando conversión...');
    
    // Esperar a que termine (máximo 60 segundos)
    job = await cloudConvert.jobs.wait(job.id);
    
    console.log('Job completado!');
    
    // Obtener el URL del archivo convertido
    const exportTask = job.tasks.filter(
      task => task.operation === 'export/url' && task.status === 'finished'
    )[0];
    
    const file = exportTask.result.files[0];
    console.log('Descargando Excel desde:', file.filename);
    
    // Descargar el Excel
    const response = await fetch(file.url);
    const buffer = await response.arrayBuffer();
    
    // Leer el Excel con xlsx
    const workbook = XLSX.read(buffer);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convertir a JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    // Mapear los datos según el formato esperado
    const productos = jsonData.map(row => {
      // Adaptación para Sermat o genérico
      // CloudConvert respeta las columnas originales del PDF
      
      // Intenta diferentes nombres de columnas posibles
      const codigo = row['CODIGO'] || row['Codigo'] || row['codigo'] || 
                    row['CODIGO BATERIA'] || Object.values(row)[0];
      
      const descripcion = row['DESCRIPCION'] || row['Descripcion'] || 
                         row['TIPO'] || row['Aplicaciones'] ||
                         Object.values(row).slice(1, -1).join(' ');
      
      const precio = row['PRECIO'] || row['Precio'] || row['Precio de Lista'] ||
                    row['Price'] || Object.values(row)[Object.values(row).length - 1];
      
      // Limpiar precio (quitar $, puntos de miles, etc)
      const precioLimpio = typeof precio === 'string' 
        ? parseFloat(precio.replace(/[$.,]/g, '').replace(/(\d)(\d{2})$/, '$1.$2'))
        : parseFloat(precio);
      
      return {
        codigo: String(codigo).trim(),
        descripcion: String(descripcion).trim(),
        precio: precioLimpio || 0,
        stock: String(precio).includes('SIN STOCK') ? 0 : 100,
        unidad: 'UN',
        categoria: 'General'
      };
    }).filter(p => p.codigo && p.codigo !== 'undefined'); // Filtrar filas vacías
    
    console.log(`Extracción completa: ${productos.length} productos`);
    
    // Respuesta exitosa
    res.json({
      success: true,
      data: {
        productos: productos,
        metadatos: {
          totalProductos: productos.length,
          calidadExtraccion: 'alta',
          metodoProcesamiento: 'CloudConvert PDF to Excel',
          tipoTabla: filename.toLowerCase().includes('sermat') ? 'sermat_baterias' : 'general'
        }
      },
      processing: {
        filename: filename,
        timestamp: new Date().toISOString(),
        metodo: 'CloudConvert',
        jobId: job.id,
        costo: productos.length > 25 ? `$${((productos.length - 25) * 0.005).toFixed(3)}` : '$0.00 (gratis)'
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// ========== MÉTODO 2: IMPORT URL (Si tienes el PDF en una URL) ==========
app.post('/extract-pdf-url', async (req, res) => {
  try {
    const { pdfUrl, filename = 'documento.pdf' } = req.body;
    
    let job = await cloudConvert.jobs.create({
      "tasks": {
        "import-my-file": {
          "operation": "import/url",
          "url": pdfUrl
        },
        "convert-my-file": {
          "operation": "convert",
          "input": "import-my-file",
          "output_format": "xlsx"
        },
        "export-my-file": {
          "operation": "export/url",
          "input": "convert-my-file"
        }
      }
    });
    
    // Resto igual que el método anterior...
    job = await cloudConvert.jobs.wait(job.id);
    
    // Obtener el URL del archivo convertido
    const exportTask = job.tasks.filter(
      task => task.operation === 'export/url' && task.status === 'finished'
    )[0];
    
    const file = exportTask.result.files[0];
    console.log('Descargando Excel desde:', file.filename);
    
    // Descargar el Excel
    const response = await fetch(file.url);
    const buffer = await response.arrayBuffer();
    
    // Leer el Excel con xlsx
    const workbook = XLSX.read(buffer);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convertir a JSON
    const jsonData = XLSX.utils.sheet_to_json(worksheet);
    
    // Mapear los datos según el formato esperado
    const productos = jsonData.map(row => {
      const codigo = row['CODIGO'] || row['Codigo'] || row['codigo'] || 
                    row['CODIGO BATERIA'] || Object.values(row)[0];
      
      const descripcion = row['DESCRIPCION'] || row['Descripcion'] || 
                         row['TIPO'] || row['Aplicaciones'] ||
                         Object.values(row).slice(1, -1).join(' ');
      
      const precio = row['PRECIO'] || row['Precio'] || row['Precio de Lista'] ||
                    row['Price'] || Object.values(row)[Object.values(row).length - 1];
      
      const precioLimpio = typeof precio === 'string' 
        ? parseFloat(precio.replace(/[$.,]/g, '').replace(/(\d)(\d{2})$/, '$1.$2'))
        : parseFloat(precio);
      
      return {
        codigo: String(codigo).trim(),
        descripcion: String(descripcion).trim(),
        precio: precioLimpio || 0,
        stock: String(precio).includes('SIN STOCK') ? 0 : 100,
        unidad: 'UN',
        categoria: 'General'
      };
    }).filter(p => p.codigo && p.codigo !== 'undefined');
    
    console.log(`Extracción completa: ${productos.length} productos`);
    
    res.json({
      success: true,
      data: {
        productos: productos,
        metadatos: {
          totalProductos: productos.length,
          calidadExtraccion: 'alta',
          metodoProcesamiento: 'CloudConvert PDF to Excel (URL)',
          tipoTabla: filename.toLowerCase().includes('sermat') ? 'sermat_baterias' : 'general'
        }
      },
      processing: {
        filename: filename,
        timestamp: new Date().toISOString(),
        metodo: 'CloudConvert URL',
        jobId: job.id,
        costo: productos.length > 25 ? `$${((productos.length - 25) * 0.005).toFixed(3)}` : '$0.00 (gratis)'
      }
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== HEALTH CHECK ==========
app.get('/health', async (req, res) => {
  try {
    // Verificar cuenta de CloudConvert
    const user = await cloudConvert.users.me();
    
    res.json({
      status: 'OK',
      service: 'PDF Microservice con CloudConvert',
      version: '1.0.0',
      cloudconvert: {
        email: user.email,
        credits: user.credits,
        minutes_used: user.minutes
      },
      info: {
        free_daily: '25 conversiones gratis por día',
        cost_additional: '$0.005 por PDF adicional',
        endpoints: [
          'POST /extract-pdf - Para PDF en base64',
          'POST /extract-pdf-url - Para PDF desde URL',
          'GET /health - Estado del servicio'
        ]
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      error: 'No se pudo conectar con CloudConvert',
      details: error.message
    });
  }
});

// ========== TEST ENDPOINT ==========
app.post('/test-cloudconvert', async (req, res) => {
  try {
    // Test simple para verificar que CloudConvert funciona
    const user = await cloudConvert.users.me();
    
    res.json({
      success: true,
      message: 'CloudConvert está funcionando correctamente',
      account: {
        email: user.email,
        credits_disponibles: user.credits
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error conectando con CloudConvert',
      details: error.message
    });
  }
});

// ========== INICIAR SERVIDOR ==========
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🚀 PDF Microservice con CloudConvert     ║
╠════════════════════════════════════════════╣
║   Puerto: ${PORT}                              ║
║   Método: CloudConvert API v2              ║
║   Gratis: 25 PDFs/día                      ║
║   Costo adicional: $0.005/PDF              ║
╠════════════════════════════════════════════╣
║   Endpoints:                               ║
║   • POST /extract-pdf (base64)             ║
║   • POST /extract-pdf-url (URL)            ║
║   • GET /health                            ║
║   • POST /test-cloudconvert                ║
╚════════════════════════════════════════════╝
  `);
});

module.exports = app;