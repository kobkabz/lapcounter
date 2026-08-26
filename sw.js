const CACHE_NAME = 'lap-counter-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {}) // don't fail install if one asset is briefly unreachable
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// เก็บแคชเฉพาะ "เปลือกแอป" ของเราเอง (HTML/JS/ไอคอน) เท่านั้น
// คำขอไปยัง CDN (face-api.js, Supabase) หรือกล้อง ปล่อยผ่านไปที่เครือข่ายตรงๆ เสมอ
// เพื่อไม่ให้ไลบรารีค้างเวอร์ชันเก่า หรือไปยุ่งกับสตรีมกล้อง/การเชื่อมต่อฐานข้อมูลสด
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
