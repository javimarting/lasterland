const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const handleApi = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
// En local solo escucha en esta máquina; HOST=0.0.0.0 lo abre a la red. En Vercel lo decide la plataforma.
const HOST = process.env.HOST || (process.env.VERCEL ? undefined : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Cabeceras de seguridad para todas las respuestas. En Vercel, public/ lo sirve su CDN: las mismas
// cabeceras están en vercel.json. connect-src incluye el almacén, al que el navegador sube directamente.
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self' https://vercel.com",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// En Vercel los ficheros de public/ los sirve su CDN; esto es lo que los sirve en local.
function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  const type = CONTENT_TYPES[path.extname(name)];
  if (req.method !== 'GET' || !type || name.includes('/') || name.startsWith('.')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(header, value);
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  serveStatic(req, res);
});

// Las subidas grandes pueden tardar: sin límite de tiempo para recibir la petición.
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`Escuchando en http://${HOST || 'localhost'}:${PORT}`);
});
