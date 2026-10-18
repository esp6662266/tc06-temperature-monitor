import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAPI } from './api.mjs';
import { MemoryStore } from './memory-store.mjs';
import { createUpdates } from './updates.mjs';

const store = new MemoryStore();
const api = createAPI(() => store);
const updateStore = new MemoryStore();
const updates = createUpdates(() => updateStore);
const base = fileURLToPath(new URL('../web/', import.meta.url));
const allowed = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/index.html', ['index.html', 'text/html']], ['/sw.js', ['sw.js', 'text/javascript']], ['/graph.js', ['graph.js', 'text/javascript']], ['/voice.js', ['voice.js', 'text/javascript']], ['/voice/manifest.json', ['voice/manifest.json', 'application/json']]]);
for(const [file,type]of[['updates.html','text/html'],['updates.js','text/javascript'],['updates.css','text/css']])allowed.set('/'+file,[file,type]);
const manifest=JSON.parse(await readFile(path.join(base,'voice/manifest.json'),'utf8'));
for(const key of Object.keys(manifest.words))allowed.set(`/voice/${key}.mp3`,[`voice/${key}.mp3`,'audio/mpeg']);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) {
      const request = new Request(url, {
        method: req.method, headers: req.headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req, duplex: 'half' } : {}),
      });
      const response = await (url.pathname.startsWith('/api/updates/') ? updates : api)(request);
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
