const CACHE = 'permitkeep-v3';
const ASSETS = ['./', './index.html', './styles.css', './icon.svg', './manifest.webmanifest', './src/app.mjs', './src/core.mjs', './src/store.mjs', './privacy.html', './permit-renewal-tracking-checklist.html', './multi-location-license-renewal-process.html', './restaurant-permit-renewal-calendar.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  })));
});
