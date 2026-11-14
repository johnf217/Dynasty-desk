// Stub service worker. Bump CACHE on each release so phones pick up the new version.
const CACHE='stub-v8';
const FILES=['./','index.html','manifest.webmanifest','icons/apple-touch-icon.png','icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET')return;
  if(req.mode==='navigate'){
    // Network first for the page so updates show up; fall back to the saved copy offline.
    e.respondWith(fetch(req).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put('index.html',c));return r;}).catch(()=>caches.match('index.html')));
    return;
  }
  // Icon library from unpkg: save a copy the first time so icons work offline.
  if(req.url.indexOf('unpkg.com/lucide@')!==-1){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(req,c));return r;})));
    return;
  }
  e.respondWith(caches.match(req).then(hit=>hit||fetch(req)));
});
