const prefix = 'poker-study:' + self.registration.scope + ':';
const cacheName = prefix + '__REVISION__';
const files = __FILES__;
const index = new URL('./index.html', self.registration.scope).href;
const assets = new Set(files.map(file => new URL(file, self.registration.scope).href));

// A new build takes over as soon as it has cached its files, instead of
// waiting for every open tab to close. The page reloads once when it does.
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName)
    .then(cache => cache.addAll(files.map(file => new Request(file, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names
    .filter(name => name.startsWith(prefix) && name !== cacheName)
    .map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const key = url.href === self.registration.scope ? index : url.href;
  if (!assets.has(key)) return;
  event.respondWith(caches.open(cacheName).then(async cache =>
    (await cache.match(key)) ?? fetch(event.request),
  ));
});
