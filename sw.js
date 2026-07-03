// Service Worker for HWM HR App PWA
// V0.1.52 — 永久根治缓存问题：HTML 始终走网络，仅缓存静态资源
const CACHE_NAME = 'hwm-hr-static-v2';
const DYNAMIC_CACHE = 'hwm-hr-dynamic-v2';

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== DYNAMIC_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // ★ HTML 文件永远不走缓存 — 直接从网络获取（根治版本不更新）
  if (url.pathname.match(/\.html$/i) || url.pathname === '/' || !url.pathname.includes('.')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // ★ 静态资源：network-first + 缓存备用
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.status === 200) {
        const clone = res.clone();
        caches.open(DYNAMIC_CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
