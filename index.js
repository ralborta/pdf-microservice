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

// ========== EXTRACTOR REGEX (PRIMERA OPCIÓN) ==========

// 1. DETECTOR DE PERFILES
function detectProfile(text, filename = '') {
  const textLower = text.toLowerCase();
  const filenameLower = filename.toLowerCase();
  
  // Detectar Sermat
  if (filenameLower.includes('sermat') || 
      (textLower.includes('bateria') && textLower.includes('c.c.a')) ||
      /12-\d+.*\$\s*\d+\.?\d*/.test(text)) {
    console.log('[PROFILE] Detectado: Sermat Baterías');
    return 'sermat_baterias';
  }
  
  // Detectar Aditivos
  if (filenameLower.includes('aditiv') || 
      filenameLower.includes('liqui') ||
      (textLower.includes('aditivos') && textLower.includes('cont. caja'))) {
    console.log('[PROFILE] Detectado: Aditivos');
    return 'aditivos';
  }
  
  console.log('[PROFILE] Detectado: Genérico');
  return 'generico';
}

// 2. EXTRACTOR REGEX PARA SERMAT
function extractSermatWithRegex(text) {
  console.log('[REGEX] Procesando Sermat...');
  const productos = [];
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Buscar líneas que empiezan con códigos de batería
    // Patrones: 12-45, NS40, VOLTA 50, S1250C23, V1150C21
    const codePatterns = [
      /^(12-\d+)/i,
      /^(NS\d+)/i,
      /^(VOLTA\s*\d+)/i,
      /^(S\d+C\d+)/i,
      /^(V\d+C\d+)/i
    ];
    
    let codigo = null;
    for (const pattern of codePatterns) {
      const match = line.match(pattern);
      if (match) {
        codigo = match[1].replace(/\s+/g, '').toUpperCase();
        break;
      }
    }
    
    if (!codigo) continue;
    
    // Buscar precio en la misma línea o siguientes
    let precio = null;
    let descripcion = line;
    let hasStock = true;
    
    // Buscar precio formato: $ 66.791 o $66.791
    const priceMatch = line.match(/\$\s*([\d.,]+)/);
    if (priceMatch) {
      // Quitar puntos de miles y convertir
      precio = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
    }
    
    // Si no encontramos precio, buscar en las siguientes 2 líneas
    if (!precio && i + 1 < lines.length) {
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const nextLine = lines[i + j];
        const nextPriceMatch = nextLine.match(/\$\s*([\d.,]+)/);
        if (nextPriceMatch) {
          precio = parseFloat(nextPriceMatch[1].replace(/\./g, '').replace(',', '.'));
          descripcion += ' ' + nextLine;
          break;
        }
      }
    }
    
    // Verificar SIN STOCK
    if (/sin\s*stock/i.test(descripcion)) {
      hasStock = false;
      precio = precio || 0;
    }
    
    // Si encontramos código y precio (o es SIN STOCK), agregar producto
    if (codigo && (precio || !hasStock)) {
      // Limpiar descripción
      descripcion = descripcion
        .replace(codigo, '')
        .replace(/\$\s*[\d.,]+/, '')
        .replace(/sin\s*stock/i, '')
        .trim();
      
      // Si la descripción está vacía, usar el tipo de batería
      if (!descripcion || descripcion.length < 5) {
        descripcion = `Batería ${codigo}`;
      }
      
      productos.push({
        codigo: codigo,
        descripcion: descripcion.substring(0, 200),
        precio: precio || 0,
        stock: hasStock ? 100 : 0,
        unidad: 'UN',
        categoria: 'Baterías',
        aplicacion: '',
        contenido: ''
      });
      
      console.log(`[REGEX] Producto encontrado: ${codigo} - $${precio}`);
    }
  }
  
  console.log(`[REGEX] Total productos extraídos: ${productos.length}`);
  return productos;
}

// 3. EXTRACTOR REGEX GENÉRICO (para otros formatos)
function extractGenericWithRegex(text) {
  console.log('[REGEX] Procesando formato genérico...');
  const productos = [];
  
  // Patrones comunes en listas de precios
  const patterns = [
    // Patrón 1: CODIGO  DESCRIPCION  $ PRECIO
    /^([A-Z0-9\-]+)\s+(.+?)\s+\$\s*([\d.,]+)$/gm,
    // Patrón 2: CODIGO | DESCRIPCION | PRECIO
    /^([A-Z0-9\-]+)\s*\|\s*(.+?)\s*\|\s*\$?\s*([\d.,]+)$/gm,
    // Patrón 3: CODIGO\tDESCRIPCION\tPRECIO
    /^([A-Z0-9\-]+)\t+(.+?)\t+\$?\s*([\d.,]+)$/gm
  ];
  
  for (const pattern of patterns) {
    let match;
    pattern.lastIndex = 0; // Reset regex
    
    while ((match = pattern.exec(text)) !== null) {
      const precio = parseFloat(
        match[3].replace(/\./g, '').replace(',', '.')
      );
      
      if (precio > 0) {
        productos.push({
          codigo: match[1].trim().toUpperCase(),
          descripcion: match[2].trim(),
          precio: precio,
          stock: 100,
          unidad: 'UN',
          categoria: 'General',
          aplicacion: '',
          contenido: ''
        });
      }
    }
    
    // Si encontramos productos con un patrón, no probar los demás
    if (productos.length > 0) break;
  }
  
  console.log(`[REGEX] Total productos genéricos: ${productos.length}`);
  return productos;
}

// 4. FUNCIÓN PRINCIPAL DE EXTRACCIÓN CON REGEX
function tryRegexExtraction(text, filename) {
  const profile = detectProfile(text, filename);
  let productos = [];
  
  if (profile === 'sermat_baterias') {
    productos = extractSermatWithRegex(text);
  } else {
    productos = extractGenericWithRegex(text);
  }
  
  return {
    productos,
    profile,
    metodo: 'Regex patterns (gratis)'
  };
}

// ========== PREPROCESADOR MULTIPATH (SEGUNDA OPCIÓN) ==========

// Detectar el perfil/tipo de documento (versión mejorada)
function detectProfileAdvanced(text, filename = '') {
  const t = text.toLowerCase();
  const fname = filename.toLowerCase();
  
  // Sermat baterías - detecta por patrones únicos
  if (fname.includes('sermat') || 
      (t.includes('c.c.a') && t.includes('c20') && t.includes('rc')) ||
      (t.includes('bater') && /\d+\s*\$/.test(text))) {
    return 'sermat_baterias';
  }
  
  // Aditivos Liqui Moly
  if ((fname.includes('aditivo') || fname.includes('liqui')) ||
      (t.includes('aditivos') && t.includes('cont. caja'))) {
    return 'aditivos_liqui';
  }
  
  return 'generico';
}

// Limpiar precios argentinos
function cleanMoneyAR(s) {
  if (!s) return undefined;
  if (typeof s === 'number') return s;
  
  const v = String(s)
    .replace(/\$/g, '')           // quitar $
    .replace(/\s/g, '')           // quitar espacios
    .replace(/\.(?=\d{3}(?:\D|$))/g, '') // quitar puntos de miles (66.791 -> 66791)
    .replace(',', '.');           // coma decimal a punto
    
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

// PREPROCESADOR ESPECÍFICO PARA SERMAT
function preprocessSermat(text) {
  console.log('[PREPROCESS] Aplicando perfil SERMAT');
  
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const productos = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Buscar líneas que empiezan con código (12-45, NS40, VOLTA 50, etc.)
    const codeMatch = line.match(/^([A-Z0-9][A-Z0-9\-\s]{2,}?)\s+/i);
    if (!codeMatch) continue;
    
    const codigo = codeMatch[1].trim().replace(/\s+/g, '');
    
    // Buscar precio en la misma línea o siguientes
    let precio = null;
    let descripcion = line.replace(codeMatch[0], '');
    let hasStock = true;
    
    // Buscar precio con $ (puede estar al final)
    const priceMatch = line.match(/\$\s*([\d.,]+)/);
    if (priceMatch) {
      precio = cleanMoneyAR(priceMatch[1]);
    } else {
      // Buscar en las siguientes 2 líneas
      for (let j = 1; j <= 2 && i + j < lines.length; j++) {
        const nextLine = lines[i + j];
        const nextPriceMatch = nextLine.match(/\$\s*([\d.,]+)/);
        if (nextPriceMatch) {
          precio = cleanMoneyAR(nextPriceMatch[1]);
          descripcion += ' ' + nextLine;
          break;
        }
      }
    }
    
    // Detectar SIN STOCK
    if (/sin\s*stock/i.test(descripcion)) {
      hasStock = false;
      descripcion = descripcion.replace(/sin\s*stock/i, '').trim();
    }
    
    // Si encontramos precio o es SIN STOCK, agregar producto
    if (precio || !hasStock) {
      // Limpiar descripción de caracteres extra
      descripcion = descripcion
        .replace(/\$\s*[\d.,]+/, '') // quitar precio de la descripción
        .replace(/\s+/g, ' ')
        .trim();
      
      productos.push({
        codigo: codigo.toUpperCase(),
        descripcion: descripcion || codigo,
        precio: precio || 0,
        stock: hasStock ? 100 : 0,
        unidad: 'UN',
        categoria: 'Baterías'
      });
    }
  }
  
  console.log(`[PREPROCESS] Sermat: ${productos.length} productos extraídos`);
  return productos;
}

// PREPROCESADOR PARA ADITIVOS
function preprocessAditivos(text) {
  console.log('[PREPROCESS] Aplicando perfil ADITIVOS');
  
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const productos = [];
  
  for (const line of lines) {
    // Buscar código de 3-4 dígitos al inicio
    const codeMatch = line.match(/^(\d{3,4})\s+/);
    if (!codeMatch) continue;
    
    const codigo = codeMatch[1];
    let descripcion = line.replace(codeMatch[0], '');
    
    // Buscar presentación (300 ml, 1 litro, etc.)
    const presentMatch = descripcion.match(/(\d+\s*(?:ml|g|litro|litros|kg))/i);
    const presentacion = presentMatch ? presentMatch[1] : '';
    
    // Buscar precios (pueden ser varios, tomar el último que suele ser con IVA)
    const precios = [...line.matchAll(/([\d.,]+)/g)]
      .map(m => cleanMoneyAR(m[1]))
      .filter(n => n && n > 100); // filtrar valores muy pequeños
    
    const precio = precios[precios.length - 1] || precios[0];
    
    if (precio) {
      // Limpiar descripción
      descripcion = descripcion
        .replace(/[\d.,]+/g, '') // quitar números
        .replace(/\s+/g, ' ')
        .trim();
      
      productos.push({
        codigo,
        descripcion: descripcion + (presentacion ? ` - ${presentacion}` : ''),
        precio,
        stock: 100,
        unidad: 'UN',
        categoria: 'Aditivos',
        contenido: presentacion
      });
    }
  }
  
  console.log(`[PREPROCESS] Aditivos: ${productos.length} productos extraídos`);
  return productos;
}

// PREPROCESADOR GENÉRICO (fallback)
function preprocessGeneric(text) {
  console.log('[PREPROCESS] Aplicando perfil GENÉRICO');
  
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const productos = [];
  
  for (const line of lines) {
    // Patrón: código + descripción + precio
    const match = line.match(/^([A-Z0-9][A-Z0-9\-]{2,})\s+(.+?)\s+\$?\s*([\d.,]+)$/i);
    if (!match) continue;
    
    const precio = cleanMoneyAR(match[3]);
    if (precio && precio > 10) { // filtrar valores muy bajos
      productos.push({
        codigo: match[1].toUpperCase(),
        descripcion: match[2].trim(),
        precio,
        stock: 100,
        unidad: 'UN'
      });
    }
  }
  
  console.log(`[PREPROCESS] Genérico: ${productos.length} productos extraídos`);
  return productos;
}

// ========== FUNCIÓN PRINCIPAL DE PREPROCESAMIENTO ==========
function preprocessText(text, filename = '') {
  const profile = detectProfile(text, filename);
  console.log(`[PREPROCESS] Perfil detectado: ${profile}`);
  
  let productos = [];
  
  switch (profile) {
    case 'sermat_baterias':
      productos = preprocessSermat(text);
      break;
    case 'aditivos_liqui':
      productos = preprocessAditivos(text);
      break;
    default:
      productos = preprocessGeneric(text);
  }
  
  return {
    profile,
    productos,
    requiresGPT: productos.length === 0 // solo usar GPT si no encontramos nada
  };
}

// Función principal de extracción con GPT-4
async function extractWithGPT4(pdfText, filename = 'documento.pdf') {
  const requestId = Math.random().toString(36).substring(7);
  const startTime = Date.now();
  
  console.log(`[${requestId}] Iniciando extracción para ${filename}`);
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
  
  // ========== NUEVO: INTENTAR REGEX PRIMERO ==========
  console.log(`[${requestId}] Intentando extracción con Regex...`);
  const regexResult = tryRegexExtraction(pdfText, filename);
  
  if (regexResult.productos.length > 0) {
    console.log(`[${requestId}] ✅ Regex exitoso: ${regexResult.productos.length} productos`);
    
    return {
      success: true,
      data: {
        productos: regexResult.productos,
        metadatos: {
          totalProductos: regexResult.productos.length,
          calidadExtraccion: 'alta',
          metodoProcesamiento: regexResult.metodo,
          tipoTabla: regexResult.profile
        }
      },
      processing: {
        timeMs: Date.now() - startTime,
        filename,
        timestamp: new Date().toISOString(),
        metodo: regexResult.metodo,
        requestId,
        profile: regexResult.profile,
        textLength: pdfText.length,
        costo: '$0.00' // GRATIS!
      }
    };
  }
  
  console.log(`[${requestId}] Regex no encontró productos, intentando preprocesador...`);
  
  // ========== SEGUNDA OPCIÓN: PREPROCESADOR ==========
  const { profile, productos, requiresGPT } = preprocessText(pdfText, filename);
  
  // Si el preprocesador encontró productos, devolverlos directamente
  if (productos.length > 0) {
    console.log(`[${requestId}] Preprocesador exitoso: ${productos.length} productos`);
    
    return {
      success: true,
      data: {
        productos: productos,
        metadatos: {
          totalProductos: productos.length,
          calidadExtraccion: 'alta',
          metodoProcesamiento: `Preprocesador ${profile}`,
          tipoTabla: profile
        }
      },
      processing: {
        timeMs: Date.now() - startTime,
        filename,
        timestamp: new Date().toISOString(),
        metodo: `Preprocesador ${profile}`,
        requestId,
        profile,
        textLength: pdfText.length,
        costo: '$0.00' // GRATIS!
      }
    };
  }
  
  // Si no encontró nada, continuar con GPT-4
  console.log(`[${requestId}] Preprocesador no encontró productos, usando GPT-4...`);
  
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

// 2. Endpoint de prueba SOLO REGEX
app.post('/test-regex', async (req, res) => {
  try {
    const { pdfBase64, filename } = req.body;
    
    if (!pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'No se proporcionó PDF'
      });
    }
    
    // Extraer texto del PDF
    const base64Data = pdfBase64.replace(/^data:application\/pdf;base64,/, '');
    const pdfBuffer = Buffer.from(base64Data, 'base64');
    const pdfData = await pdf(pdfBuffer);
    const pdfText = pdfData.text;
    
    // Probar solo regex
    const result = tryRegexExtraction(pdfText, filename);
    
    res.json({
      success: result.productos.length > 0,
      test: 'regex-only',
      profile: result.profile,
      data: {
        productos: result.productos,
        metadatos: {
          totalProductos: result.productos.length,
          calidadExtraccion: result.productos.length > 0 ? 'alta' : 'baja',
          metodoProcesamiento: result.metodo
        }
      },
      processing: {
        metodo: result.metodo,
        costo: '$0.00',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Error en /test-regex:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      test: 'regex-only'
    });
  }
});

// 3. Endpoint de prueba con datos de ejemplo
app.post('/test-extract', async (req, res) => {
  try {
    // Simular texto de un PDF de ejemplo con datos de Sermat
    const testText = `
Lista de precios Nº37 1/8/2025 - SERMAT BATERÍAS
CODIGO  TIPO     Borne  C20   RC    C.C.A.  Aplicaciones                           Precio
12-45   12x45    D      38    56    350     Clio mio-palio 8v-Ford ka             $ 66.791
12-55   12x55    D      51    90    430     P 208/308/207/307 - Fiat Argo         $ 77.873
12-65   12X65    D/I    45    70    430     Focus, Gol trend, Voyager              $ 75.008
12-70   12X70    STD    54    83    450     Peugeot-Citroën-Partner-Berlingo      $ 83.631
NS40    H Fit    D      30    41    260     Honda Fit/ City - Hyundai I10         SIN STOCK
VOLTA 50 VOLTA 50 D      45    70    400     Universal - múltiples aplicaciones    $ 89.500

ADITIVOS LIQUI MOLY
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
      version: '1.6.0',
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

// 4. Endpoint de verificación de versión
app.get('/version', (req, res) => {
  res.json({
    version: '1.6.0-regex',
    timestamp: new Date().toISOString(),
    features: {
      regex: true,
      preprocesador: true,
      python: false,
      gpt35: false,
      gpt4: true
    },
    message: 'Versión con Regex para Sermat implementada',
    flujo: 'Regex → Preprocesador → GPT-4',
    costo_regex: '$0.00',
    costo_preprocesador: '$0.00'
  });
});

// 5. Endpoint de test directo para Sermat
app.post('/test-sermat-direct', (req, res) => {
  try {
    // Texto hardcodeado de Sermat para test directo
    const testText = `12-45 12x45 D 38 56 350 Clio mio-palio 8v-Ford ka $ 66.791
12-55 12x55 D 51 90 430 P 208/308/207/307 - Fiat Argo $ 77.873
12-65 12X65 D/I 45 70 430 Focus, Gol trend, Voyager $ 75.008
12-70 12X70 STD 54 83 450 Peugeot-Citroën-Partner-Berlingo $ 83.631
NS40 H Fit D 30 41 260 Honda Fit/ City - Hyundai I10 SIN STOCK
VOLTA 50 VOLTA 50 D 45 70 400 Universal - múltiples aplicaciones $ 89.500`;
    
    console.log('[TEST-DIRECT] Probando regex con texto hardcodeado de Sermat');
    const productos = extractSermatWithRegex(testText);
    
    res.json({
      test: 'sermat-direct',
      encontrados: productos.length,
      productos: productos,
      timestamp: new Date().toISOString(),
      metodo: 'Regex patterns (gratis)'
    });
    
  } catch (error) {
    console.error('[TEST-DIRECT] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      test: 'sermat-direct'
    });
  }
});

// 6. Información del servicio
app.get('/', (req, res) => {
  res.json({
    service: 'PDF to Excel Microservice - GPT-4 Optimized',
    version: '1.6.0',
    description: 'Microservicio con GPT-4 para extracción inteligente de productos',
    endpoints: {
      'POST /extract-pdf': 'Extraer productos de PDF (Regex → Preprocesador → GPT-4)',
      'POST /test-regex': 'Probar solo extracción con Regex (gratis)',
      'POST /test-sermat-direct': 'Test directo con texto hardcodeado de Sermat',
      'POST /test-extract': 'Probar extracción con datos de ejemplo',
      'GET /version': 'Verificar versión y features implementadas',
      'GET /health': 'Estado del servicio y conexión OpenAI',
      'GET /': 'Información del servicio'
    },
    optimizaciones: [
      'Regex patterns como primera opción (GRATIS)',
      'Preprocesador multipath como segunda opción (GRATIS)',
      'GPT-4 turbo como fallback para casos complejos',
      'Detección automática de perfil de documento',
      'Extracción instantánea para Sermat (sin API calls)',
      'Manejo específico de baterías Sermat con regex',
      'Normalización perfecta de precios argentinos',
      'Detección de SIN STOCK automática',
      'Logs detallados con requestId y método usado',
      'Ahorro significativo de costos'
    ],
    modelo: 'gpt-4-turbo-preview',
    especializado: 'Listas de precios, catálogos y tablas de productos'
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 PDF Microservice v1.6.0 iniciado - DEPLOY FORZADO`);
  console.log(`📍 Puerto: ${PORT}`);
  console.log(`🤖 Modelo: GPT-4 turbo`);
  console.log(`✅ OpenAI configurado: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`\n📋 Endpoints disponibles:`);
  console.log(`   POST /extract-pdf - Extracción principal (Regex → Preprocesador → GPT-4)`);
  console.log(`   POST /test-regex - Probar solo Regex (GRATIS)`);
  console.log(`   POST /test-sermat-direct - Test directo Sermat (GRATIS)`);
  console.log(`   POST /test-extract - Prueba con datos de ejemplo`);
  console.log(`   GET /version - Verificar versión y features`);
  console.log(`   GET /health - Estado del servicio`);
  console.log(`   GET / - Información del servicio\n`);
});

module.exports = app;