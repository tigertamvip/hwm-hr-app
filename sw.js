// Service Worker for HWM HR App PWA
// V0.1.51d — force SW reload (2026-07-03T18:08)
const CACHE_NAME = 'hwm-hr-v0.1.51d';

// On install, cache essential assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// On activate, clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    })
  );
  self.clients.claim();
});

// Network-first strategy: try network, fallback to cache
self.addEventListener('fetch', (event) => {
  // Only handle GET for our own domain
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for static assets
        if (response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline fallback
        return caches.match(event.request);
      })
  );
});
