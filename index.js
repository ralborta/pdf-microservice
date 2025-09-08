// index.js - MICROSERVICIO OPTIMIZADO CON MEJORAS DEL ESPECIALISTA
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

// Schema estructurado optimizado
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
// FUNCIONES HELPER OPTIMIZADAS
// ============================================

function chunkText(txt, max = 12000) {
  const out = [];
  for (let i = 0; i < txt.length; i += max) {
    out.push(txt.slice(i, i + max));
  }
  return out;
}

function normalizeProducto(p) {
  const u = (p.unidad || "").toUpperCase().trim();
  const codigo = (p.codigo || "").toUpperCase().replace(/\s+/g, '');
  
  // Normalizar precios es-AR y quitar símbolos
  let precio = p.precio;
  if (typeof precio === "string") {
    precio = precio
      .replace(/[^\d.,-]/g, '') // Quitar símbolos monetarios
      .replace(/\.(?=\d{3}(?:[^\d]|$))/g, '') // Quitar puntos de miles
      .replace(',', '.'); // Cambiar coma decimal por punto
    precio = parseFloat(precio);
  }
  
  const stock = Number.isFinite(p.stock) 
    ? Math.floor(p.stock) 
    : parseInt(String(p.stock || '0').replace(/\D/g, ''), 10);
  
  return {
    ...p,
    codigo,
    unidad: u,
    precio: Number.isFinite(precio) ? precio : undefined,
    stock: Number.isFinite(stock) ? stock : undefined
  };
}

// ============================================
// EXTRACTOR DE TEXTO ROBUSTO
// ============================================

async function extraerTextoDePDF(pdfBase64) {
  console.log('Extrayendo texto del PDF...');
  
  try {
    const pdfParse = require('pdf-parse');
    
    // Permitir data URL o base64 plano
    const base64Clean = pdfBase64.includes('base64,')
      ? pdfBase64.split('base64,').pop()
      : pdfBase64;
    
    const pdfBuffer = Buffer.from(base64Clean, 'base64');
    
    const data = await pdfParse(pdfBuffer, {
      normalizeWhitespace: true,
      disableCombineTextItems: false,
      max: 10
    });
    
    if (!data.text || data.text.length < 50) {
      throw new Error('PDF sin texto extraíble o contenido insuficiente. Puede ser un PDF escaneado.');
    }
    
    console.log(`Texto extraído: ${data.text.length} caracteres, ${data.numpages} páginas`);
    return data.text;
    
  } catch (error) {
    console.error('Error extrayendo texto:', error);
    throw new Error(`No se pudo extraer texto del PDF: ${error.message}`);
  }
}

// ============================================
// RUTA PRINCIPAL OPTIMIZADA
// ============================================

app.post('/extract-pdf', async (req, res) => {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    console.log(`[${requestId}] Nueva solicitud de extracción PDF`);
    
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
    
    console.log(`[${requestId}] Procesando: ${filename || 'documento.pdf'}`);
    console.log(`[${requestId}] Tamaño base64: ${pdfBase64.length} caracteres`);
    
    // PASO 1: Extraer texto del PDF
    const textoExtraido = await extraerTextoDePDF(pdfBase64);
    
    // PASO 2: Procesar con GPT usando chunking
    console.log(`[${requestId}] Enviando texto a LLM (chunking)...`);
    const chunks = chunkText(textoExtraido, 12000);
    const productosAgg = [];
    let calidadAgg = "baja";
    
    for (let idx = 0; idx < chunks.length; idx++) {
      console.log(`[${requestId}] Procesando chunk ${idx + 1}/${chunks.length}`);
      
      const promptUsuario = `Archivo: ${filename || 'documento.pdf'}\n\n` +
        `TEXTO (fragmento ${idx + 1}/${chunks.length}):\n` +
        chunks[idx] + `\n\n` +
        `Instrucciones: extrae SOLO productos completos según el schema.`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { 
            role: "system", 
            content: "Eres un extractor que responde exclusivamente en JSON válido, siguiendo estrictamente el schema."
          },
          { 
            role: "user", 
            content: promptUsuario 
          }
        ],
        response_format: SCHEMA_PRODUCTOS,
        max_tokens: 4000,
        temperature: 0.0
      });

      const jsonChunk = JSON.parse(resp.choices[0].message.content || "{}");
      const prods = Array.isArray(jsonChunk.productos) ? jsonChunk.productos : [];
      const calidad = jsonChunk?.metadatos?.calidadExtraccion || "baja";
      
      if (calidad === "alta" || (calidad === "media" && calidadAgg !== "alta")) {
        calidadAgg = calidad;
      }

      for (const p of prods) {
        productosAgg.push(normalizeProducto(p));
      }
      
      console.log(`[${requestId}] Chunk ${idx + 1}: ${prods.length} productos encontrados`);
    }

    // Dedupe por codigo + descripcion
    const dedup = new Map();
    for (const p of productosAgg) {
      if (!p.codigo || !p.descripcion || !Number.isFinite(p.precio) || !Number.isFinite(p.stock) || !p.unidad) {
        continue;
      }
      const key = `${p.codigo}::${p.descripcion.trim().toLowerCase()}`;
      if (!dedup.has(key)) {
        dedup.set(key, p);
      }
    }
    const productos = [...dedup.values()];

    const resultado = {
      productos,
      metadatos: {
        totalProductos: productos.length,
        calidadExtraccion: productos.length ? calidadAgg : "baja",
        metodoProcesamiento: "LLM structured output (chunked)"
      }
    };
    
    const processingTime = Date.now() - startTime;
    
    console.log(`[${requestId}] Extracción completada en ${processingTime}ms`);
    console.log(`[${requestId}] Productos finales: ${productos.length}`);
    console.log(`[${requestId}] Calidad: ${resultado.metadatos.calidadExtraccion}`);
    
    // Log de primeros productos para debug
    if (productos.length > 0) {
      console.log(`[${requestId}] Primeros productos extraídos:`);
      productos.slice(0, 3).forEach((p, i) => {
        console.log(`  ${i+1}: ${p.codigo} - ${p.descripcion?.substring(0, 30)} - $${p.precio}`);
      });
    }
    
    // Validación antes de responder
    if (!Array.isArray(resultado.productos)) {
      throw new Error("El modelo no devolvió 'productos' como array");
    }
    
    res.json({
      success: true,
      data: resultado,
      processing: {
        timeMs: processingTime,
        filename: filename || 'documento.pdf',
        timestamp: new Date().toISOString(),
        metodo: 'GPT-4o-mini + chunking',
        requestId: requestId,
        chunks: chunks.length
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`[${requestId}] Error en extracción:`, error);
    
    // Respuesta de error estructurada
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
        metodo: 'Error en procesamiento',
        requestId: requestId
      }
    });
  }
});

// ============================================
// ENDPOINT DE PRUEBA OPTIMIZADO
// ============================================

app.post('/test-extract', async (req, res) => {
  const textoEjemplo = `
LISTA DE PRODUCTOS - FERRETERÍA

CÓDIGO    DESCRIPCIÓN                     PRECIO    STOCK   UNIDAD
ABC001    Martillo carpintero 500g        $1.250,50    25      UN
ABC002    Tornillos autorroscantes 3x20   $850,75     100     CAJA
ABC003    Pintura látex blanca 4 litros   $2.890,00    15     LT
DEF004    Taladro eléctrico 650W          $15.450,25    8     UN
DEF005    Cable eléctrico 2.5mm x metro   $125,80     500     MT
  `;
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Eres un extractor que responde exclusivamente en JSON válido, siguiendo estrictamente el schema."
        },
        {
          role: "user", 
          content: `Extrae productos del siguiente texto:\n\n${textoEjemplo}`
        }
      ],
      response_format: SCHEMA_PRODUCTOS,
      max_tokens: 2000,
      temperature: 0.0
    });
    
    const resultado = JSON.parse(response.choices[0].message.content);
    
    // Normalizar productos de prueba
    const productosNormalizados = resultado.productos.map(normalizeProducto);
    
    res.json({
      success: true,
      data: {
        ...resultado,
        productos: productosNormalizados
      },
      test: true,
      modelo: "gpt-4o-mini"
    });
    
  } catch (error) {
    console.error('Error en test:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      test: true
    });
  }
});

// ============================================
// RUTAS DE ESTADO
// ============================================

app.get('/health', async (req, res) => {
  try {
    // Verificar conexión a OpenAI
    const testResponse = await openai.models.list();
    
    res.json({
      status: 'OK',
      service: 'PDF Microservice Optimized',
      version: '1.2.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        connected: !!testResponse,
        model: 'gpt-4o-mini'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'PDF Microservice Optimized',
      error: error.message,
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        connected: false
      }
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    service: 'PDF to Excel Microservice - Optimized',
    version: '1.2.0',
    description: 'Microservicio optimizado con mejoras del especialista',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF (producción)',
      'POST /test-extract': 'Probar extracción con texto de ejemplo',
      'GET /health': 'Estado del servicio con verificación OpenAI',
      'GET /': 'Información del servicio'
    },
    optimizaciones: [
      'GPT-4o-mini (más rápido y económico)',
      'Chunking de texto para documentos grandes',
      'Normalización de precios argentinos',
      'Deduplicación de productos',
      'Validación robusta de entrada',
      'Logs con requestId para trazabilidad',
      'Manejo mejorado de errores'
    ],
    modelo: 'gpt-4o-mini',
    chunking: true,
    normalizacion: 'Precios argentinos soportados'
  });
});

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({
    success: false,
    error: 'Error interno del servidor',
    message: error.message
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 PDF Microservice OPTIMIZED corriendo en puerto ${PORT}`);
  console.log(`📋 Optimizaciones aplicadas:`);
  console.log(`   • GPT-4o-mini (más rápido y barato)`);
  console.log(`   • Chunking para documentos grandes`);
  console.log(`   • Normalización de precios argentinos`);
  console.log(`   • Deduplicación automática`);
  console.log(`   • Logs con requestId`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Configurada' : 'NO CONFIGURADA'}`);
});