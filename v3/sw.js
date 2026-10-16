const VERSION='meu-treino-v3-beta-18-login-exato';
const FILES=['./','./index.html','./manifest.webmanifest?v=3.5.5',
  './icon-192.png?v=3.5.5','./icon-512.png?v=3.5.5',
  './icon-maskable-192.png?v=3.5.5','./icon-maskable-512.png?v=3.5.5',
  './apple-touch-icon.png?v=3.5.5','./favicon-64.png?v=3.5.5',
  './login-art.png','./cloud.js?v=3.5.5','./config.js?v=3.5.5'];
self.addEventListener('install',e=>e.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('meu-treino-v3-')&&k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const url=new URL(e.request.url);if(e.request.method!=='GET'||url.origin!==location.origin||!url.pathname.includes('/v3/'))return;e.respondWith(fetch(e.request).then(res=>{if(res.ok)caches.open(VERSION).then(cache=>cache.put(e.request,res.clone()));return res}).catch(()=>caches.match(e.request)))});
