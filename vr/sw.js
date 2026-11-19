const CACHE = 'questai-v3';
const SHELL = ['./', './app.js', './ai.js', './i18n.js', './xr.js', './style.css', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './fonts/plex-ar-arabic-400.woff2', './fonts/plex-ar-arabic-500.woff2', './fonts/plex-ar-arabic-600.woff2', './fonts/plex-ar-arabic-700.woff2',
  './fonts/plex-ar-latin-400.woff2', './fonts/plex-ar-latin-500.woff2', './fonts/plex-ar-latin-600.woff2', './fonts/plex-ar-latin-700.woff2',
  './fonts/plex-mono-400.woff2', './fonts/plex-mono-500.woff2'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); });
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req)));
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
      return r;
    })));
  }
});
