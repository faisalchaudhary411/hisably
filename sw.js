/* Hisably service worker – offline app shell + cached libraries */
const CACHE = 'hisably-v10';

const LOCAL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/receipt.js',
  './js/app.js',
  './js/freemium.js',
  './js/cloud.js',
  './js/supabase-config.js',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// Third-party libraries the app needs for PDF / image invoices / barcode scan / cloud.
// Cached too, otherwise those features break the moment the phone is offline.
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4'
];

const CDN_HOSTS = ['cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // one by one: a single failing file must not prevent the rest from being cached
    await Promise.all(LOCAL_ASSETS.map(u => c.add(u).catch(() => {})));
    await Promise.all(CDN_ASSETS.map(u =>
      fetch(new Request(u, { mode: 'no-cors' })).then(r => c.put(u, r)).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase API / auth: never cache, never intercept
  if (url.hostname.endsWith('supabase.co')) return;

  const sameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isCdn) return;

  if (isCdn) {
    // Libraries/fonts are versioned: cache-first
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // App files: stale-while-revalidate (instant/offline start, fresh copy for next open)
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return cached || network;
    })
  );
});
