const CACHE = 'anas-erp-v54-25-r26';
const CORE = [
  './', './index.html', './manifest.webmanifest', './icons/icon.svg',
  './anas-erp-ui-safe-enhancements.css',
  './ai-excel-import-ui.js',
  './ai-excel-import-ui.css',
  './anas-pos-floating-cart.js',
  './anas-pos-floating-cart.css',
  './reverse-ledger/reverse-ledger.js',
  './reverse-ledger/reverse-ledger-modal.js',
  './reverse-ledger/settlement-allocation-modal.js',
  './storage/android-resilient-storage.js',
  './core/ai-operations-engine.js',
  './micro-pos-core.js',
  './pos/micro-pos-engine.mjs',
  './pos/micro-pos-deep-core.mjs',
  './pos/advanced-financial-engine.mjs',
  './vendor/firebase/firebase-compat.js',
  './vendor/xlsx/xlsx.full.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './supplier-account-statement.js',
  './cashbox-readonly-ledger.js',
  './arabic-query-engine.js',
  './customer-debt-protection.js',
  './warehouse-transfer-audit.js'
];
// OCR is a large optional offline pack. Cache each asset independently: one missing file or
// quota failure must not discard every successfully cached OCR runtime/language asset.
const OCR_ASSETS = [
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './vendor/tesseract/core/tesseract-core.wasm.js',
  './vendor/tesseract/core/tesseract-core-simd.wasm.js',
  './vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  './vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract/lang/ara.traineddata.gz',
  './vendor/tesseract/lang/eng.traineddata.gz',
  './vendor/tesseract/lang/fra.traineddata.gz'
];
const CORE_URLS = new Set([...CORE, ...OCR_ASSETS].map(path => new URL(path, self.location.href).href));


self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => caches.open(CACHE).then(cache => Promise.allSettled(OCR_ASSETS.map(path => cache.add(path)))))
      .then(() => self.skipWaiting())
  );
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
