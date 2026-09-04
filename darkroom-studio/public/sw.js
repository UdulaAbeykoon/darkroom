const DARKROOM_CACHE_PREFIX = "darkroom-studio-";
const RETIRED_CACHE_PREFIX = `${String.fromCodePoint(
  108,
  117,
  109,
  105,
  110,
  97,
)}-studio-`;
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_NAMESPACE = `${DARKROOM_CACHE_PREFIX}${encodeURIComponent(
  SCOPE_URL.pathname,
)}-`;
const CACHE_NAME = `${CACHE_NAMESPACE}app-v5`;
const RETIRED_CACHE_NAMESPACE = `${RETIRED_CACHE_PREFIX}${encodeURIComponent(
  SCOPE_URL.pathname,
)}-`;
const RETIRED_CACHE_NAMES = new Set([
  `${RETIRED_CACHE_PREFIX}v1`,
  `${RETIRED_CACHE_PREFIX}app-v2`,
]);
const APP_ENTRY_URL = new URL("./", SCOPE_URL);
const APP_ASSET_URL = new URL("assets/", SCOPE_URL);
const APP_STATIC_ASSETS = [
  new URL("manifest.webmanifest", SCOPE_URL).href,
  new URL("icon.svg", SCOPE_URL).href,
  new URL("icon-monochrome.svg", SCOPE_URL).href,
  new URL("icon-192.png", SCOPE_URL).href,
  new URL("icon-512.png", SCOPE_URL).href,
  new URL("icon-maskable-192.png", SCOPE_URL).href,
  new URL("icon-maskable-512.png", SCOPE_URL).href,
  new URL("favicon-32.png", SCOPE_URL).href,
  new URL("apple-touch-icon.png", SCOPE_URL).href,
];
const APP_SHELL = [
  APP_ENTRY_URL.href,
  ...APP_STATIC_ASSETS,
];
const APP_STATIC_ASSET_PATHS = new Set(
  APP_STATIC_ASSETS.map((url) => new URL(url).pathname),
);
const CACHEABLE_ASSET_DESTINATIONS = new Set([
  "font",
  "image",
  "manifest",
  "script",
  "style",
  "worker",
]);

function isWithinScope(url) {
  return (
    url.origin === SCOPE_URL.origin &&
    url.protocol === SCOPE_URL.protocol &&
    url.pathname.startsWith(SCOPE_URL.pathname)
  );
}

function isAppEntry(url) {
  return (
    isWithinScope(url) &&
    (url.pathname === APP_ENTRY_URL.pathname ||
      url.pathname === new URL("index.html", SCOPE_URL).pathname)
  );
}

function isCacheableAppAsset(request, url) {
  if (!isWithinScope(url) || request.headers.has("range")) return false;
  if (APP_STATIC_ASSET_PATHS.has(url.pathname)) {
    return (
      request.destination === "" ||
      request.destination === "image" ||
      request.destination === "manifest"
    );
  }
  return (
    url.pathname.startsWith(APP_ASSET_URL.pathname) &&
    (CACHEABLE_ASSET_DESTINATIONS.has(request.destination) ||
      (request.destination === "" && url.pathname.endsWith(".wasm")))
  );
}

function canStoreResponse(request, response) {
  if (!response.ok || response.type !== "basic" || !response.url) return false;
  const responseUrl = new URL(response.url);
  return (
    isCacheableAppAsset(request, responseUrl) ||
    (request.mode === "navigate" && isAppEntry(responseUrl))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
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
            .filter(
              (key) =>
                (key.startsWith(CACHE_NAMESPACE) && key !== CACHE_NAME) ||
                key.startsWith(RETIRED_CACHE_NAMESPACE) ||
                RETIRED_CACHE_NAMES.has(key),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!isWithinScope(url)) return;

  if (event.request.mode === "navigate" && isAppEntry(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (canStoreResponse(event.request, response)) {
            return caches
              .open(CACHE_NAME)
              .then((cache) =>
                cache.put(APP_ENTRY_URL.href, response.clone()),
              )
              .then(() => response);
          }
          return response;
        })
        .catch(async (error) => {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(APP_ENTRY_URL.href);
          if (cached) return cached;
          throw error;
        }),
    );
    return;
  }

  if (!isCacheableAppAsset(event.request, url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (canStoreResponse(event.request, response)) {
            return cache
              .put(event.request, response.clone())
              .then(() => response);
          }
          return response;
        });
      }),
    ),
  );
});
