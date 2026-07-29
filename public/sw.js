// Minimal hand-written service worker for offline play.
//
// Why hand-written instead of a plugin: this app has no external runtime
// dependency to work around (no flagcdn/restcountries/etc - all 194 flag
// PNGs live in /public/flags and next/font self-hosts the game font at
// build time), so there is nothing that needs a generated runtime-caching
// table. Bump CACHE_VERSION when this file's caching logic changes so old
// caches get swept on activate.
const CACHE_VERSION = "country-racer-v1";

const STATIC_CACHE_RE = /\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i;
const isNextStatic = (url) => url.pathname.startsWith("/_next/static/");
const isStaticAsset = (url) =>
  isNextStatic(url) || STATIC_CACHE_RE.test(url.pathname);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Precache the app shell so the very first offline load - even before
      // any runtime caching has happened - still has something to serve.
      .then((cache) => cache.addAll(["/"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so a stale cache can never brick the app -
  // any new deploy is picked up immediately while online, and only offline
  // visitors fall back to the last cached shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed Next.js build chunks and static assets (fonts, images, including
  // all /flags/*.png) are safe to cache-first: hashed filenames are
  // immutable, and non-hashed image assets rarely change.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});
