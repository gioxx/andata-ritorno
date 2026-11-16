// Old hostnames on gioxx.org and their new home on gxware.org. Path, query and fragment are kept
// (the browser keeps the fragment across a redirect by itself).
const TARGETS = {
  'ar.gioxx.org': 'ar.gxware.org',
  'app.ar.gioxx.org': 'app.ar.gxware.org',
};

// Browsers refuse a redirected service-worker script, so an old worker would keep serving its
// cached app forever. /sw.js answers 200 with a worker that empties the caches, unregisters itself
// and reloads the open pages, which then follow the redirect. Same script as landing/public/sw.js.
// It does not clear IndexedDB: an old copy may hold data its owner never moved.
export const KILL_SWITCH = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key)
      await self.registration.unregister()
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
    })(),
  )
})
`;

export default {
  fetch(req) {
    const url = new URL(req.url);
    const host = Object.hasOwn(TARGETS, url.hostname) ? TARGETS[url.hostname] : null;
    if (!host) return new Response('Not found', { status: 404 });
    if (url.pathname === '/sw.js') {
      return new Response(KILL_SWITCH, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' },
      });
    }
    url.hostname = host;
    url.protocol = 'https:';
    return new Response(null, {
      status: 301,
      headers: {
        location: url.toString(),
        'cache-control': 'public, max-age=86400',
        'strict-transport-security': 'max-age=31536000',
      },
    });
  },
};
