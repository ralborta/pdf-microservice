# PDF Microservice

Microservicio para extraer productos de PDFs usando OpenAI GPT-4V.

## Instalación

```bash
npm install
```

## Configuración

Crear archivo `.env`:
```
OPENAI_API_KEY=sk-proj-tu_clave_aqui
PORT=3000
```

## Uso

```bash
npm start
```

## Endpoints

### POST /extract-pdf
Extrae productos de un PDF.

**Body:**
```json
{
  "pdfBase64": "base64_del_pdf",
  "filename": "documento.pdf"
}
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "productos": [...],
    "metadatos": {...}
  }
}
```

### GET /health
Estado del servicio.

### GET /
Información del servicio.

## Deploy en Railway

1. Crear nuevo proyecto en Railway
2. Conectar este repositorio
3. Configurar variable `OPENAI_API_KEY`
4. Deploy automático

## Uso desde otros proyectos

```javascript
const response = await fetch('https://tu-microservicio.railway.app/extract-pdf', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    pdfBase64: pdfBuffer.toString('base64'),
    filename: 'documento.pdf'
  })
});

const result = await response.json();
```
