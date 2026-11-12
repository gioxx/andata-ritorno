// The app used to live on this origin (A/R 2.x) with a service worker that keeps serving it from its
// cache. Browsers still holding it fetch this file when they check for updates: it replaces the old
// worker, empties the caches, unregisters itself and reloads the open pages onto the landing.
// The app now lives on https://app.ar.gxware.org.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key)
      await self.registration.unregister()
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
    })(),
  )
})
