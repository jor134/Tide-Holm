/* Tideholm service worker.
   App shell is cached so the game opens offline for pass-and-play.
   The API is never cached — an authoritative game must always hit the network. */
var CACHE = 'tideholm-v2';
var THREEJS = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
var SHELL = ['./', './index.html', './engine.js', './manifest.json', './icon-192.png', './icon-512.png', THREEJS];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('/api/') === 0) return;          // always live
  // three.js is the one cross-origin asset we cache. cdnjs sends CORS headers,
  // so the response is readable rather than opaque — never cache an opaque one.
  if (url.origin !== self.location.origin && e.request.url !== THREEJS) return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var live = fetch(e.request).then(function (r) {
        if (r && r.status === 200 && r.type !== 'opaque') {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return r;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});
