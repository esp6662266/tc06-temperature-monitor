/* Cache the UI and fixed number voice lexicon, never measured API responses. */
const CACHE='tc06-web-v0.6.0';
const VOICE=['intro','minus','0','1','2','3','4','5','6','7','8','9','10','100','1000','point','end'];
const ASSETS=['/','/index.html','/app.js','/graph.js','/voice.js','/style.css','/voice/manifest.json',...VOICE.map(key=>`/voice/${key}.mp3`)];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('tc06-web-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||url.pathname.startsWith('/api/')||event.request.method!=='GET')return;
  if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).catch(()=>caches.match('/index.html')));return;}
  if(ASSETS.includes(url.pathname))event.respondWith(fetch(event.request).catch(()=>caches.match(url.pathname)));
});
