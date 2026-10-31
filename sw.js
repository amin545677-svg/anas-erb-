const CACHE = 'anas-erp-v54-25-r3';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './reverse-ledger/reverse-ledger.js'];
const CORE_URLS = new Set(CORE.map(path => new URL(path, self.location.href).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('anas-erp-') && key !== CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first navigation; use the current cached shell for network errors and HTTP error responses.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          return caches.open(CACHE).then(cache => {
            // Cache is an optimization: quota/storage failures must not break a successful online navigation.
            return cache.put(new URL('./index.html', self.location.href).href, response.clone())
              .catch(() => undefined)
              .then(() => response);
          });
        }
        return caches.open(CACHE).then(cache => cache.match('./index.html')).then(cached => cached || response);
      }).catch(() => caches.open(CACHE).then(cache => cache.match('./index.html')))
    );
    return;
  }

  // Network-first for app-shell assets prevents a cache-first worker from pinning stale files.
  if (!CORE_URLS.has(url.href)) return;
  event.respondWith(
    fetch(request).then(response => {
      if (response && response.ok) {
        return caches.open(CACHE).then(cache => {
          // Cache-write failure must not turn a valid network response into an application failure.
          return cache.put(request, response.clone())
            .catch(() => undefined)
            .then(() => response);
        });
      }
      return response;
    }).catch(() => caches.open(CACHE).then(cache => cache.match(request)))
  );
});
