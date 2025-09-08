const express = require('express');
const cors = require('cors');
const pdf = require('pdf-parse');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Configuración
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Cliente OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Schema JSON estructurado para GPT-4
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

// Función para dividir texto en chunks
function chunkText(txt, max = 15000) {
  const out = [];
  for (let i = 0; i < txt.length; i += max) {
    out.push(txt.slice(i, i + max));
  }
  return out;
}

// Función para normalizar productos
function normalizeProducto(p) {
  let precio = p.precio;
  
  if (typeof precio === "string") {
    // Quitar $ y espacios
    precio = precio.replace(/[$\s]/g, '');
    // Quitar puntos de miles (66.791 -> 66791)
    precio = precio.replace(/\./g, '');
    // Si hay coma decimal, cambiarla por punto
    precio = precio.replace(',', '.');
    precio = parseFloat(precio);
  }
  
  return {
    ...p,
    codigo: (p.codigo || "").trim().toUpperCase(),
    descripcion: (p.descripcion || "").trim(),
    precio: Number.isFinite(precio) ? precio : 0,
    stock: p.stock === 0 ? 0 : (p.stock || 100),
    unidad: (p.unidad || "UN").toUpperCase().trim(),
    categoria: p.categoria || "General",
    aplicacion: p.aplicacion || "",
    contenido: p.contenido || ""
  };
}

// Función para deduplicar productos
function deduplicateProducts(products) {
  const seen = new Map();
  
  for (const p of products) {
    const key = `${p.codigo}-${p.descripcion}`.toLowerCase();
    if (!seen.has(key) || p.precio > seen.get(key).precio) {
      seen.set(key, p);
    }
  }
  
  return Array.from(seen.values());
}

// Función principal de extracción con GPT-4
async function extractWithGPT4(pdfText, filename = 'documento.pdf') {
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();
  
  console.log(`[${requestId}] Iniciando extracción GPT-4 para ${filename}`);
  console.log(`[${requestId}] Longitud del texto: ${pdfText.length} caracteres`);
  
  // Verificar si hay texto para procesar
  if (!pdfText || pdfText.length < 50) {
    console.error(`[${requestId}] Texto muy corto o vacío`);
    return {
      success: false,
      error: 'No se pudo extraer texto del PDF',
      processing: {
        timeMs: Date.now() - startTime,
        filename,
        requestId,
        textLength: pdfText.length
      }
    };
  }
  
  // Log de los primeros caracteres para debug
  console.log(`[${requestId}] Primeros 500 caracteres del PDF:`);
  console.log(pdfText.substring(0, 500));
  
  try {
    // Dividir en chunks
    const chunks = chunkText(pdfText, 15000);
    console.log(`[${requestId}] Procesando ${chunks.length} chunks`);
    
    const allProducts = [];
    let successfulChunks = 0;
    
    // Procesar cada chunk
    for (let idx = 0; idx < chunks.length; idx++) {
      console.log(`[${requestId}] Procesando chunk ${idx + 1}/${chunks.length}`);
      
      try {
        // PROMPT MEJORADO - GENÉRICO Y ADAPTATIVO
        const systemPrompt = {
          role: "system", 
          content: `Eres un extractor experto en listas de precios y catálogos comerciales.

CAPACIDADES:
- Detectas automáticamente el tipo de tabla (productos, precios, catálogos)
- Extraes TODA la información disponible sin perder detalles
- Adaptas la extracción según la estructura que encuentres
- Manejas formatos de precios argentinos (puntos para miles: 66.791)

REGLA CRÍTICA:
- DEBES extraer TODOS los productos que veas en el texto
- Si ves códigos y precios, son productos que DEBES extraer
- No ignores ninguna línea que parezca un producto
- Combina TODA la información disponible en la descripción`
        };
        
        const userPrompt = {
          role: "user",
          content: `Archivo: ${filename}
Fragmento ${idx + 1}/${chunks.length}

TEXTO DEL PDF:
${chunks[idx]}

INSTRUCCIONES CRÍTICAS:
1. Analiza la estructura de la tabla/lista
2. Identifica TODOS los productos (cualquier línea con código y precio)
3. Extrae COMPLETAMENTE cada producto

MAPEO INTELIGENTE:
- codigo: El primer código/identificador que veas en la línea
- descripcion: Combina TODOS los campos descriptivos que encuentres
  * Si hay tipo/modelo + aplicaciones → únelos con " - "
  * Si hay nombre + características → únelos
  * Si hay múltiples columnas de texto → combínalas
  * Incluye especificaciones técnicas si las hay
  * Ejemplo: "12x45 D - 38Ah 56min 350CCA - Clio mio-palio 8v-Ford ka"
- precio: El valor numérico del precio (quita $, espacios y puntos de miles)
- stock: Si dice "SIN STOCK"→0, si no se menciona→100
- unidad: Lo que encuentres o "UN" por defecto
- categoria: Dedúcela del contexto o usa "General"
- aplicacion: Información de uso/aplicación/vehículos si existe
- contenido: Dimensiones, medidas, capacidades, cantidades si las hay

IMPORTANTE: 
- NO te saltes productos
- Si una línea tiene código y precio, ES UN PRODUCTO
- La descripción debe ser COMPLETA con toda la info disponible
- Si ves una tabla, extrae TODAS las filas con datos
- Mejor extraer de más que perder información

Responde ÚNICAMENTE en JSON válido siguiendo el schema.`
        };
        
        // Llamada a GPT-4
        const response = await openai.chat.completions.create({
          model: "gpt-4-turbo-preview",
          messages: [systemPrompt, userPrompt],
          response_format: SCHEMA_PRODUCTOS,
          max_tokens: 6000,
          temperature: 0.0
        });
        
        const result = JSON.parse(response.choices[0].message.content);
        
        if (result.productos && result.productos.length > 0) {
          console.log(`[${requestId}] Chunk ${idx + 1}: ${result.productos.length} productos encontrados`);
          allProducts.push(...result.productos);
          successfulChunks++;
        } else {
          console.log(`[${requestId}] Chunk ${idx + 1}: Sin productos`);
        }
        
      } catch (chunkError) {
        console.error(`[${requestId}] Error en chunk ${idx + 1}:`, chunkError.message);
      }
    }
    
    // Si no se encontraron productos
    if (allProducts.length === 0) {
      console.log(`[${requestId}] No se encontraron productos en ningún chunk`);
      return {
        success: false,
        error: 'No se pudieron extraer productos del PDF',
        processing: {
          timeMs: Date.now() - startTime,
          filename,
          requestId,
          chunks: chunks.length,
          textLength: pdfText.length,
          metodo: 'GPT-4 turbo + chunking optimizado'
        }
      };
    }
    
    // Normalizar y deduplicar
    const normalizedProducts = allProducts.map(normalizeProducto);
    const uniqueProducts = deduplicateProducts(normalizedProducts);
    
    console.log(`[${requestId}] Total productos: ${allProducts.length}, únicos: ${uniqueProducts.length}`);
    
    // Determinar calidad
    const calidad = successfulChunks === chunks.length ? 'alta' : 
                   successfulChunks > chunks.length / 2 ? 'media' : 'baja';
    
    return {
      success: true,
      data: {
        productos: uniqueProducts,
        metadatos: {
          totalProductos: uniqueProducts.length,
          calidadExtraccion: calidad,
          metodoProcesamiento: 'GPT-4 turbo + chunking optimizado',
          tipoTabla: 'Lista de precios/catálogo'
        }
      },
      processing: {
        timeMs: Date.now() - startTime,
        filename,
        timestamp: new Date().toISOString(),
        metodo: 'GPT-4 turbo + chunking optimizado',
        requestId,
        chunks: chunks.length,
        textLength: pdfText.length
      }
    };
    
  } catch (error) {
    console.error(`[${requestId}] Error general:`, error);
    return {
      success: false,
      error: error.message || 'Error procesando PDF',
      processing: {
        timeMs: Date.now() - startTime,
        filename,
        requestId,
        textLength: pdfText.length
      }
    };
  }
}

// === ENDPOINTS ===

// 1. Endpoint principal de extracción
app.post('/extract-pdf', async (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    
    if (!pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'No se proporcionó PDF'
      });
    }
    
    // Extraer base64
    const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    
    // Parsear PDF
    const pdfData = await pdf(pdfBuffer);
    const pdfText = pdfData.text;
    
    // Extraer con GPT-4
    const result = await extractWithGPT4(pdfText, filename);
    
    res.json(result);
    
  } catch (error) {
    console.error('Error en /extract-pdf:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error procesando PDF'
    });
  }
});

// 2. Endpoint de prueba con datos de ejemplo
app.post('/test-extract', async (req, res) => {
  try {
    // Simular texto de un PDF de ejemplo
    const testText = `
Lista de precios Nº37 1/8/2025
CODIGO  TIPO     Borne  C20   RC    C.C.A.  Aplicaciones                           Precio
12-45   12x45    D      38    56    350     Clio mio-palio 8v-Ford ka             $ 66.791
12-55   12x55    D      51    90    430     P 208/308/207/307 - Fiat Argo         $ 77.873
12-65   12X65    D/I    45    70    430     Focus, Gol trend, Voyager              $ 75.008
12-70   12X70    STD    54    83    450     Peugeot-Citroën-Partner-Berlingo      $ 83.631
NS40    H Fit    D      30    41    260     Honda Fit/ City - Hyundai I10         SIN STOCK

ADITIVOS
2124    Injection Reiniger      300ml    Universal    $ 14.189
1870    Pro-Line Fuel Cleaner   300ml    Intensivo    $ 22.320
2603    Ventil Sauber          150ml    Universal    $ 18.069
    `;
    
    const result = await extractWithGPT4(testText, 'test-productos.pdf');
    
    res.json({
      ...result,
      test: true,
      modelo: 'gpt-4-turbo-preview'
    });
    
  } catch (error) {
    console.error('Error en /test-extract:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error en prueba',
      test: true
    });
  }
});

// 3. Health check
app.get('/health', async (req, res) => {
  try {
    // Verificar conexión con OpenAI
    let openaiStatus = false;
    try {
      // Hacer una llamada simple para verificar
      await openai.models.list();
      openaiStatus = true;
    } catch (e) {
      console.error('OpenAI check failed:', e.message);
    }
    
    res.json({
      status: 'OK',
      service: 'PDF Microservice GPT-4 Optimized',
      version: '1.4.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      openai: {
        configured: !!process.env.OPENAI_API_KEY,
        connected: openaiStatus,
        model: 'gpt-4-turbo-preview'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error.message
    });
  }
});

// 4. Información del servicio
app.get('/', (req, res) => {
  res.json({
    service: 'PDF to Excel Microservice - GPT-4 Optimized',
    version: '1.4.0',
    description: 'Microservicio con GPT-4 para extracción inteligente de productos',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF con GPT-4',
      'POST /test-extract': 'Probar extracción con datos de ejemplo',
      'GET /health': 'Estado del servicio y conexión OpenAI',
      'GET /': 'Información del servicio'
    },
    optimizaciones: [
      'GPT-4 turbo para tablas complejas',
      'Chunks de 15000 caracteres',
      'Prompts adaptativos para cualquier tipo de producto',
      'Detección automática de estructura de tabla',
      'Extracción completa sin pérdida de información',
      'Normalización de precios argentinos',
      'Deduplicación inteligente',
      'Logs detallados con requestId',
      'Manejo robusto de múltiples formatos'
    ],
    modelo: 'gpt-4-turbo-preview',
    especializado: 'Listas de precios, catálogos y tablas de productos'
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 PDF Microservice v1.4.0 iniciado`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo: GPT-4 turbo`);
  console.log(`✅ OpenAI configurado: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`\n📋 Endpoints disponibles:`);
  console.log(`   POST /extract-pdf - Extracción principal`);
  console.log(`   POST /test-extract - Prueba con datos de ejemplo`);
  console.log(`   GET /health - Estado del servicio`);
  console.log(`   GET / - Información del servicio\n`);
});

module.exports = app;