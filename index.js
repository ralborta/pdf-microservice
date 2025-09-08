// index.js - MICROSERVICIO CORREGIDO
// Usando GPT-4 con texto extraído en lugar de GPT-4V con imágenes

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

// Schema estructurado corregido
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

// ============================================
// EXTRACTOR DE TEXTO DE PDF
// ============================================

async function extraerTextoDePDF(pdfBase64) {
  console.log('Extrayendo texto del PDF...');
  
  try {
    // Usar pdf-parse para extraer texto
    const pdfParse = require('pdf-parse');
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    
    const data = await pdfParse(pdfBuffer, {
      normalizeWhitespace: true,
      disableCombineTextItems: false,
      max: 10 // Máximo 10 páginas
    });
    
    if (!data.text || data.text.length < 50) {
      throw new Error('PDF sin texto extraíble o muy poco contenido');
    }
    
    console.log(`Texto extraído: ${data.text.length} caracteres, ${data.numpages} páginas`);
    return data.text;
    
  } catch (error) {
    console.error('Error extrayendo texto:', error);
    throw new Error(`No se pudo extraer texto del PDF: ${error.message}`);
  }
}

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
    
    // PASO 1: Extraer texto del PDF
    const textoExtraido = await extraerTextoDePDF(pdfBase64);
    
    // PASO 2: Procesar con GPT-4 usando texto (no imagen)
    console.log('🤖 Enviando texto a GPT-4...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview", // Cambio: usar GPT-4 turbo en lugar de vision
      messages: [
        {
          role: "system",
          content: `Eres un extractor experto de datos de productos de documentos.

INSTRUCCIONES ESTRICTAS:
- Analiza el texto proporcionado extraído de un PDF
- Extrae ÚNICAMENTE productos con datos completos
- Respeta el schema JSON estricto
- Si no hay productos claros, devuelve array vacío
- Evalúa honestamente la calidad de extracción

FORMATO DE PRODUCTOS:
- Código: alfanumérico, mayúsculas (ej: ABC123)
- Descripción: texto descriptivo del producto
- Precio: número sin símbolos monetarios
- Stock: número entero
- Unidad: UN, KG, LT, MT, PZ, etc.
- Categoría: si está disponible en el texto`
        },
        {
          role: "user",
          content: `Archivo: ${filename || 'documento.pdf'}

Texto extraído del PDF:
${textoExtraido.substring(0, 15000)} // Limitar para no exceder tokens

Analiza este texto y extrae todos los productos siguiendo el schema estricto.

IMPORTANTE:
- Solo productos con código, descripción, precio, stock y unidad completos
- Precios como números puros (sin $, €, etc.)
- Stock como números enteros
- Códigos en mayúsculas y sin espacios
- Evalúa la calidad de extracción honestamente`
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
    
    // Log de primeros productos para debug
    if (resultado.productos.length > 0) {
      console.log('🔍 Primeros productos extraídos:');
      resultado.productos.slice(0, 3).forEach((p, i) => {
        console.log(`  ${i+1}: ${p.codigo} - ${p.descripcion?.substring(0, 30)} - $${p.precio}`);
      });
    }
    
    res.json({
      success: true,
      data: resultado,
      processing: {
        timeMs: processingTime,
        filename: filename || 'documento.pdf',
        timestamp: new Date().toISOString(),
        metodo: 'GPT-4 con texto extraído'
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('❌ Error en extracción:', error);
    
    // Respuesta de error con estructura válida
    res.status(500).json({
      success: false,
      error: error.message,
      data: {
        productos: [],
        metadatos: {
          totalProductos: 0,
          calidadExtraccion: 'baja',
          metodoProcesamiento: `Error: ${error.message}`
        }
      },
      processing: {
        timeMs: processingTime,
        timestamp: new Date().toISOString(),
        metodo: 'Error en procesamiento'
      }
    });
  }
});

// Ruta de prueba con texto de ejemplo
app.post('/test-extract', async (req, res) => {
  const textoEjemplo = `
LISTA DE PRODUCTOS

CÓDIGO    DESCRIPCIÓN                     PRECIO    STOCK   UNIDAD
ABC001    Producto de ejemplo uno         15.50     25      UN
ABC002    Producto de ejemplo dos         23.75     10      KG
ABC003    Producto de ejemplo tres        8.90      100     LT
  `;
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "Extrae productos del texto siguiendo el schema estricto."
        },
        {
          role: "user", 
          content: `Texto: ${textoEjemplo}`
        }
      ],
      response_format: SCHEMA_PRODUCTOS,
      max_tokens: 2000,
      temperature: 0.1
    });
    
    const resultado = JSON.parse(response.choices[0].message.content);
    
    res.json({
      success: true,
      data: resultado,
      test: true
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      test: true
    });
  }
});

// Ruta de salud
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'PDF Microservice Fixed',
    version: '1.1.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    openai: process.env.OPENAI_API_KEY ? 'Configurado' : 'No configurado'
  });
});

// Ruta de información
app.get('/', (req, res) => {
  res.json({
    service: 'PDF to Excel Microservice - Fixed',
    version: '1.1.0',
    description: 'Microservicio corregido para extraer productos de PDFs usando GPT-4 con texto',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF (producción)',
      'POST /test-extract': 'Probar extracción con texto de ejemplo',
      'GET /health': 'Estado del servicio',
      'GET /': 'Información del servicio'
    },
    cambios: [
      'Cambio de GPT-4V a GPT-4 turbo',
      'Extracción de texto con pdf-parse',
      'Procesamiento de texto en lugar de imagen',
      'Mejor manejo de errores',
      'Endpoint de prueba agregado'
    ],
    uso: {
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
      'POST /test-extract',
      'GET /health',
      'GET /'
    ]
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 PDF Microservice FIXED corriendo en puerto ${PORT}`);
  console.log(`📋 Cambios principales:`);
  console.log(`   • GPT-4 turbo en lugar de GPT-4V`);
  console.log(`   • Extracción de texto con pdf-parse`);
  console.log(`   • Procesamiento más confiable`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Configurada' : 'NO CONFIGURADA'}`);
});