import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAPI } from './api.mjs';
import { MemoryStore } from './memory-store.mjs';

const store = new MemoryStore();
const api = createAPI(() => store);
const base = fileURLToPath(new URL('../web/', import.meta.url));
const allowed = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(new URL(req.url, 'http://127.0.0.1'), {
        method: req.method, headers: req.headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req, duplex: 'half' } : {}),
      });
      const response = await api(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } else if (allowed.has(url.pathname)) {
      const [file, type] = allowed.get(url.pathname);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(await readFile(path.join(base, file)));
    } else { res.writeHead(404); res.end('Not found'); }
  } catch { res.writeHead(500); res.end('Local server error'); }
});
server.listen(Number(process.env.PORT || 8766), '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port} (검증용 임시 저장소 · 운전값 없음)`));
