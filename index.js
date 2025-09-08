// index.js - Microservicio completo
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Schema estructurado para OpenAI
const SCHEMA_PRODUCTOS = {
  type: "json_schema",
  json_schema: {
    name: "extraccion_productos_pdf",
    strict: true,
    schema: {
      type: "object",
      properties: {
        productos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              codigo: { type: "string" },
              descripcion: { type: "string" },
              precio: { type: "number" },
              stock: { type: "number" },
              unidad: { type: "string" },
              categoria: { type: "string" }
            },
            required: ["codigo", "descripcion", "precio", "stock", "unidad"],
            additionalProperties: false
          }
        },
        metadatos: {
          type: "object",
          properties: {
            totalProductos: { type: "number" },
            calidadExtraccion: {
              type: "string",
              enum: ["alta", "media", "baja"]
            },
            metodoProcesamiento: { type: "string" }
          },
          required: ["totalProductos", "calidadExtraccion", "metodoProcesamiento"],
          additionalProperties: false
        }
      },
      required: ["productos", "metadatos"],
      additionalProperties: false
    }
  }
};

// Ruta principal - Extraer productos de PDF
app.post('/extract-pdf', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('📄 Nueva solicitud de extracción PDF');
    
    const { pdfBase64, filename } = req.body;
    
    if (!pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere pdfBase64 en el body'
      });
    }
    
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'OPENAI_API_KEY no configurada'
      });
    }
    
    console.log(`📋 Procesando: ${filename || 'documento.pdf'}`);
    console.log(`📏 Tamaño base64: ${pdfBase64.length} caracteres`);
    
    // Llamada a OpenAI con structured outputs
    const response = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "system",
          content: `Eres un extractor experto de datos de productos de PDFs.

INSTRUCCIONES ESTRICTAS:
- Analiza el PDF/imagen proporcionada
- Extrae ÚNICAMENTE productos con datos completos
- Respeta el schema JSON estricto
- Si no hay productos claros, devuelve array vacío
- Evalúa honestamente la calidad de extracción`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Archivo: ${filename || 'documento.pdf'}

Analiza este PDF y extrae todos los productos en formato estructurado.

IMPORTANTE:
- Solo productos con código, descripción, precio, stock y unidad
- Precios como números sin símbolos monetarios  
- Stock como números enteros
- Códigos en mayúsculas
- Unidades estándar (UN, KG, LT, etc.)

Extrae según el schema definido.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:application/pdf;base64,${pdfBase64}`
              }
            }
          ]
        }
      ],
      response_format: SCHEMA_PRODUCTOS,
      max_tokens: 4000,
      temperature: 0.1
    });
    
    const contenido = response.choices[0].message.content;
    
    if (!contenido) {
      throw new Error('No se recibió respuesta de OpenAI');
    }
    
    const resultado = JSON.parse(contenido);
    const processingTime = Date.now() - startTime;
    
    console.log(`✅ Extracción completada en ${processingTime}ms`);
    console.log(`📊 Productos extraídos: ${resultado.productos.length}`);
    console.log(`🎯 Calidad: ${resultado.metadatos.calidadExtraccion}`);
    
    res.json({
      success: true,
      data: resultado,
      processing: {
        timeMs: processingTime,
        filename: filename || 'documento.pdf',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error en extracción:', error);
    
    res.status(500).json({
      success: false,
      error: error.message,
      processing: {
        timeMs: processingTime,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Ruta de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'PDF Microservice',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Ruta de información
app.get('/', (req, res) => {
  res.json({
    service: 'PDF to Excel Microservice',
    version: '1.0.0',
    description: 'Microservicio para extraer productos de PDFs usando OpenAI',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF',
      'GET /health': 'Estado del servicio',
      'GET /': 'Información del servicio'
    },
    features: [
      'OpenAI GPT-4V integration',
      'Structured outputs con schema estricto',
      'Validación automática de datos',
      'Compatible con múltiples proyectos',
      'Logs detallados',
      'Manejo robusto de errores'
    ],
    usage: {
      method: 'POST',
      endpoint: '/extract-pdf',
      body: {
        pdfBase64: 'string (required)',
        filename: 'string (optional)'
      }
    }
  });
});

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('❌ Error no manejado:', error);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    message: error.message
  });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada',
    availableEndpoints: [
      'POST /extract-pdf',
      'GET /health',
      'GET /'
    ]
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 PDF Microservice corriendo en puerto ${PORT}`);
  console.log(`📋 Endpoints disponibles:`);
  console.log(`   GET  / - Información del servicio`);
  console.log(`   GET  /health - Estado del servicio`);
  console.log(`   POST /extract-pdf - Extraer productos de PDF`);
  console.log(`🔑 OpenAI API Key configurada: ${process.env.OPENAI_API_KEY ? 'SÍ' : 'NO'}`);
});
