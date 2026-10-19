const CACHE = 'audio-lab-__VERSION__';
const ASSETS = __ASSETS__;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  // A new version waits until existing app windows close. Never replace a live DSP session.
});
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('audio-lab-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  // Keep the cached shell and its DSP modules on one release until the waiting worker activates.
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request);
    if (cached) return cached;
    if (event.request.mode === 'navigate') {
      const shell = await cache.match(new URL('index.html', self.registration.scope));
      if (shell) return shell;
    }
    return fetch(event.request);
  }));
});
