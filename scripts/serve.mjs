import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const root = path.resolve('dist');
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let filename = decodeURIComponent(url.pathname);
    const prefix = '/ios-audio-processing-pwa-poc/';
    if (filename.startsWith(prefix)) filename = filename.slice(prefix.length);
    const file = path.resolve(root, filename.replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(root + path.sep)) throw new Error('Forbidden');
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(Number(process.env.PORT || 4173), '0.0.0.0', () => console.log('http://localhost:4173/ios-audio-processing-pwa-poc/'));
