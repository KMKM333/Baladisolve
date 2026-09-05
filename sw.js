// Manāra service worker — the cheap app: installable, and readable offline.
//
// index.html is network-first, so a deploy is never masked by a stale copy —
// the single-page site already confused people once when an open tab kept old
// code, and a cache-first shell would make that permanent. If the network is
// down, the last good copy is served instead. Third-party assets (fonts, map
// tiles, libraries, report photos) are cached as they are seen and refreshed
// in the background, so a second visit works with a weak connection.
const SHELL = 'manara-shell-v1';
const ASSETS = 'manara-assets-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add('/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // The page itself, and anything else on this origin: network first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok && (req.mode === 'navigate' || url.pathname === '/')) {
          caches.open(SHELL).then((c) => c.put('/', res.clone()));
        }
        return res;
      }).catch(() => caches.match(req.mode === 'navigate' ? '/' : req))
    );
    return;
  }

  // Everything else: serve what we have, refresh it in the background.
  e.respondWith(
    caches.open(ASSETS).then(async (c) => {
      const hit = await c.match(req);
      const refresh = fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});
