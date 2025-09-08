// index.js - MICROSERVICIO CON GPT-4 PARA TABLAS COMPLEJAS
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

// Schema estructurado para GPT-4
const SCHEMA_PRODUCTOS = {
  type: "json_schema",
  json_schema: {
    name: "extraccion_productos_tabla_compleja",
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
              categoria: { type: "string" },
              aplicacion: { type: "string" },
              contenido: { type: "string" }
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
            metodoProcesamiento: { type: "string" },
            tipoTabla: { type: "string" }
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

function chunkText(txt, max = 15000) {
  const out = [];
  for (let i = 0; i < txt.length; i += max) {
    out.push(txt.slice(i, i + max));
  }
  return out;
}

function normalizeProducto(p) {
  const u = (p.unidad || "").toUpperCase().trim();
  const codigo = (p.codigo || "").toUpperCase().replace(/\s+/g, '');
  
  // Normalizar precios argentinos y quitar símbolos
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
      max: 15 // Procesar más páginas con GPT-4
    });
    
    if (!data.text || data.text.length < 50) {
      throw new Error('PDF sin texto extraíble o contenido insuficiente. Puede ser un PDF escaneado.');
    }
    
    console.log(`Texto extraído: ${data.text.length} caracteres, ${data.numpages} páginas`);
    
    // Log de muestra del texto para debug
    console.log('Muestra del texto extraído:');
    console.log(data.text.substring(0, 500) + '...');
    
    return data.text;
    
  } catch (error) {
    console.error('Error extrayendo texto:', error);
    throw new Error(`No se pudo extraer texto del PDF: ${error.message}`);
  }
}

// ============================================
// RUTA PRINCIPAL CON GPT-4
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
    
    // PASO 1: Extraer texto del PDF
    const textoExtraido = await extraerTextoDePDF(pdfBase64);
    
    // PASO 2: Procesar con GPT-4 usando chunking optimizado
    console.log(`[${requestId}] Enviando texto a GPT-4 (chunking optimizado)...`);
    const chunks = chunkText(textoExtraido, 15000); // Chunks más grandes para GPT-4
    const productosAgg = [];
    let calidadAgg = "baja";
    
    for (let idx = 0; idx < chunks.length; idx++) {
      console.log(`[${requestId}] Procesando chunk ${idx + 1}/${chunks.length}`);
      
      const promptUsuario = `Archivo: ${filename || 'documento.pdf'}

TEXTO DEL PDF (fragmento ${idx + 1}/${chunks.length}):
${chunks[idx]}

INSTRUCCIONES ESPECÍFICAS:
Analiza este texto que proviene de una lista de precios o catálogo de productos.
Busca especialmente:
- Códigos de producto (números o alfanuméricos)
- Descripciones de productos 
- Precios (pueden estar en formato argentino con puntos de miles y coma decimal)
- Cantidades o stock
- Unidades de medida
- Aplicaciones o usos

Extrae TODOS los productos que encuentres, incluso si la tabla tiene muchas columnas.
Respeta estrictamente el schema JSON requerido.`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4-turbo-preview", // GPT-4 para tablas complejas
        messages: [
          { 
            role: "system", 
            content: `Eres un extractor experto especializado en listas de precios y catálogos complejos.

ESPECIALIDADES:
- Tablas con múltiples columnas (código, descripción, función, aplicación, contenido, precio)
- Listas de productos técnicos e industriales
- Formatos de precios argentinos (1.234,56)
- Códigos alfanuméricos de productos
- Descripciones técnicas detalladas

REGLAS ESTRICTAS:
- Extrae TODOS los productos visibles en el texto
- No inventes datos que no estén en el texto
- Responde exclusivamente en JSON válido siguiendo el schema
- Si encuentras muchos productos, inclúyelos todos
- Evalúa la calidad de extracción honestamente`
          },
          { 
            role: "user", 
            content: promptUsuario 
          }
        ],
        response_format: SCHEMA_PRODUCTOS,
        max_tokens: 6000, // Más tokens para respuestas largas
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
      
      // Log de algunos productos para debug
      if (prods.length > 0) {
        console.log(`[${requestId}] Ejemplos de productos en chunk ${idx + 1}:`);
        prods.slice(0, 2).forEach(p => {
          console.log(`  - ${p.codigo}: ${p.descripcion?.substring(0, 40)}... - $${p.precio}`);
        });
      }
    }

    // Dedupe por codigo + descripcion
    const dedup = new Map();
    for (const p of productosAgg) {
      if (!p.codigo || !p.descripcion || !Number.isFinite(p.precio) || !Number.isFinite(p.stock) || !p.unidad) {
        console.log(`[${requestId}] Producto incompleto descartado: ${JSON.stringify(p)}`);
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
        metodoProcesamiento: "GPT-4 turbo + chunking optimizado",
        tipoTabla: "Lista de precios compleja"
      }
    };
    
    const processingTime = Date.now() - startTime;
    
    console.log(`[${requestId}] Extracción completada en ${processingTime}ms`);
    console.log(`[${requestId}] Productos finales: ${productos.length}`);
    console.log(`[${requestId}] Calidad: ${resultado.metadatos.calidadExtraccion}`);
    
    // Log detallado de productos extraídos
    if (productos.length > 0) {
      console.log(`[${requestId}] Productos extraídos exitosamente:`);
      productos.slice(0, 5).forEach((p, i) => {
        console.log(`  ${i+1}: ${p.codigo} - ${p.descripcion?.substring(0, 50)} - $${p.precio} - Stock: ${p.stock}`);
      });
      if (productos.length > 5) {
        console.log(`  ... y ${productos.length - 5} productos más`);
      }
    } else {
      console.log(`[${requestId}] ⚠️ No se encontraron productos válidos`);
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
        metodo: 'GPT-4 turbo + chunking optimizado',
        requestId: requestId,
        chunks: chunks.length,
        textLength: textoExtraido.length
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`[${requestId}] ❌ Error en extracción:`, error);
    
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
        metodo: 'Error en procesamiento GPT-4',
        requestId: requestId
      }
    });
  }
});

// ============================================
// ENDPOINT DE PRUEBA CON GPT-4
// ============================================

app.post('/test-extract', async (req, res) => {
  const textoEjemplo = `
LISTADO DE PRODUCTOS MAYORISTA - ADITIVOS

CÓDIGO    DESCRIPCIÓN                     FUNCIÓN              APLICACIÓN    CONT    PRECIO
2124      Injection Reiniger             limpieza inyectores  universal     300 ml  14.189
1870      Pro-Line Fuel System Cleaner   limpieza inyectores  intensivo     300 ml  22.320
2603      Ventil Sauber                   limpieza válvulas    universal     150 ml  18.069
6931      Catalytic System Cleaner        limpieza catalizador universal     300 ml  19.665
2123      mtx Vergaser Reiniger           limpieza carburador  universal     300 ml  21.734
  `;
  
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "Eres un extractor experto que responde exclusivamente en JSON válido, siguiendo estrictamente el schema para listas de precios complejas."
        },
        {
          role: "user", 
          content: `Extrae todos los productos de esta lista de precios:\n\n${textoEjemplo}`
        }
      ],
      response_format: SCHEMA_PRODUCTOS,
      max_tokens: 3000,
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
      modelo: "gpt-4-turbo-preview"
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
      service: 'PDF Microservice GPT-4 Optimized',
      version: '1.3.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        connected: !!testResponse,
        model: 'gpt-4-turbo-preview'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      service: 'PDF Microservice GPT-4 Optimized',
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
    service: 'PDF to Excel Microservice - GPT-4 Optimized',
    version: '1.3.0',
    description: 'Microservicio con GPT-4 para tablas complejas de productos',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF con GPT-4',
      'POST /test-extract': 'Probar extracción con datos de ejemplo',
      'GET /health': 'Estado del servicio',
      'GET /': 'Información del servicio'
    },
    optimizaciones: [
      'GPT-4 turbo para tablas complejas',
      'Chunks de 15000 caracteres',
      'Prompts especializados en listas de precios',
      'Normalización de precios argentinos',
      'Deduplicación inteligente',
      'Logs detallados con requestId',
      'Manejo robusto de múltiples columnas'
    ],
    modelo: 'gpt-4-turbo-preview',
    especializado: 'Listas de precios y catálogos complejos'
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
  console.log(`🚀 PDF Microservice GPT-4 OPTIMIZED corriendo en puerto ${PORT}`);
  console.log(`📋 Configuración para tablas complejas:`);
  console.log(`   • GPT-4 turbo (máxima capacidad)`);
  console.log(`   • Chunks de 15000 caracteres`);
  console.log(`   • Prompts especializados`);
  console.log(`   • Logs detallados de productos`);
  console.log(`   • Manejo de múltiples columnas`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? 'Configurada' : 'NO CONFIGURADA'}`);
});