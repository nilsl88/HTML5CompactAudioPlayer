importScripts("./js/offline-manifest.js", "./js/offline-media-response.js");
const { validManifest, metaCache: META_CACHE, downloadHeader: DOWNLOAD_HEADER, versionHeader, versionHeaderValue,
  offlineMetaUrl, offlineChunkUrl } = globalThis.CompactPlayerOfflineManifest;
const SHELL_VERSION = "v17";
const SHELL_CACHE_PREFIX = `compact-player-app-shell:${encodeURIComponent(new URL(self.registration.scope).pathname)}:`;
const SHELL_CACHE = SHELL_CACHE_PREFIX + SHELL_VERSION;
const SHELL_NETWORK_WAIT_MS = 3000;
const SHELL_URLS = [
  "./",
  "./index.html",
  "./player.css?v=17",
  "./player.js?v=17",
  "./i18n.js?v=17",
  "./js/player-app.js",
  "./js/availability-cache.js",
  "./js/chapter-cache.js",
  "./js/chapter-panel.js",
  "./js/http-range.js",
  "./js/mp4-atoms.js",
  "./js/mp4-metadata.js",
  "./js/offline-media-response.js",
  "./js/offline-panel.js",
  "./js/offline-selection.js",
  "./js/availability-session.js",
  "./js/availability.js",
  "./js/chapters.js",
  "./js/chapter-session.js",
  "./js/config.js",
  "./js/codecs.js",
  "./js/preferences.js",
  "./js/cover.js",
  "./js/book-config.js",
  "./js/book-selection.js",
  "./js/dialogs.js",
  "./js/custom-select.js",
  "./js/media-controller.js",
  "./js/media-session.js",
  "./js/mp4-chapters.js",
  "./js/offline.js",
  "./js/offline-book-store.js",
  "./js/progress-writer.js",
  "./js/offline-transfer.js",
  "./js/offline-lock.js",
  "./js/offline-manifest.js",
  "./js/source-selection.js",
  "./js/storage.js",
  "./js/sleep-timer.js",
  "./js/utils.js",
  "./js/vtt.js",
];
const SHELL_PATHS = new Set(SHELL_URLS.map((path) => new URL(path, self.registration.scope).pathname));
const PLAYER_PAGES = new Set(["./", "index.html"].map((path) => new URL(path, self.registration.scope).pathname));

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function chunkUrl(downloadId, index) {
  return offlineChunkUrl(self.registration.scope, downloadId, index);
}

async function activeManifest() {
  const meta = await caches.open(META_CACHE);
  const response = await meta.match(offlineMetaUrl(self.registration.scope, "active"));
  if (!response) return null;
  try {
    const record = await response.json();
    return record?.cacheName === record?.manifest?.cacheName && validManifest(record.manifest, "ready") ? record.manifest : null;
  } catch { return null; }
}

function cachedMediaResponse(request, manifest, cache) {
  return downloadedMediaResponse(request, manifest, (index) => cache.match(chunkUrl(manifest.downloadId, index)));
}

async function cachedBookResponse(request) {
  const manifest = await activeManifest();
  if (manifest) {
    const bookCache = await caches.open(manifest.cacheName);
    if (request.url === manifest.sourceUrl) {
      const response = await cachedMediaResponse(request, manifest, bookCache);
      if (response) return response;
    }
    const asset = await bookCache.match(request);
    if (!asset?.ok || request.destination) return asset;
    // Expose the saved edition to fetch() callers. Native image and navigation responses keep their URL.
    const response = new Response(asset.body, asset);
    response.headers.set(versionHeader, versionHeaderValue(manifest.cacheVersion));
    return response;
  }
  return null;
}

function cachedFallback(request) {
  return SHELL_PATHS.has(new URL(request.url).pathname) ? cachedShell(request) : cachedBookResponse(request);
}

async function cachedShell(request) {
  const shell = await caches.open(SHELL_CACHE);
  if (request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname)) {
    return await shell.match(scopeUrl("index.html")) || shell.match(scopeUrl("./"));
  }
  return shell.match(request, { ignoreSearch: true });
}

async function fetchShell(request) {
  const controller = typeof AbortSignal.any === "function" ? new AbortController() : null;
  const network = controller
    ? fetch(request, { signal: AbortSignal.any([request.signal, controller.signal]) })
    : fetch(request);
  let timer;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, SHELL_NETWORK_WAIT_MS); });
    const response = await Promise.race([network, deadline]);
    if (response) return response;
    // Keep the network in the race while Cache Storage opens, including on a cache miss.
    const cached = await Promise.race([network.then(() => null), cachedShell(request).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not read the installed player.", error);
      return null;
    })]);
    if (!cached?.ok) return network;
    controller?.abort();
    return cached;
  } finally { clearTimeout(timer); }
}

async function networkFirst(request) {
  let response;
  let networkError;
  try {
    const path = new URL(request.url).pathname;
    const paths = request.mode === "navigate" ? PLAYER_PAGES : SHELL_PATHS;
    const useShell = request.method === "GET" && paths.has(path);
    response = await (useShell ? fetchShell(request) : fetch(request));
    if (response.ok) return response;
  } catch (error) { networkError = error; }
  try {
    const cached = await cachedFallback(request);
    if (cached) return cached;
  } catch (error) { console.warn("[CompactAudioPlayer] Could not read the cached response.", error); }
  if (response) return response;
  throw networkError;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_URLS.map((path) => new Request(scopeUrl(path), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!["GET", "HEAD"].includes(request.method) || request.headers.get(DOWNLOAD_HEADER) === "1") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // Firefox can fail media seeks when a worker forwards the streaming response.
  // Let the browser own online audio; offline requests still use saved chunks.
  if (request.destination === "audio" && self.navigator?.onLine !== false) return;
  event.respondWith(networkFirst(request));
});
