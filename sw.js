importScripts("./js/offline-manifest.js?v=19", "./js/offline-media-response.js?v=19");
const { validManifest, metaCache: META_CACHE, downloadHeader: DOWNLOAD_HEADER, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue,
  offlineMetaUrl, offlineChunkUrl, damagedChunkUrl } = globalThis.CompactPlayerOfflineManifest;
const SHELL_VERSION = "v19";
const SHELL_CACHE_PREFIX = `compact-player-app-shell:${encodeURIComponent(new URL(self.registration.scope).pathname)}:`;
const SHELL_CACHE = SHELL_CACHE_PREFIX + SHELL_VERSION;
const SHELL_NETWORK_WAIT_MS = 3000;
const SHELL_URLS = [
  "./?v=19",
  "./index.html?v=19",
  "./player.css?v=19",
  "./player.js?v=19",
  "./i18n.js?v=19",
  "./js/player-app.js?v=19",
  "./js/availability-cache.js?v=19",
  "./js/chapter-cache.js?v=19",
  "./js/chapter-panel.js?v=19",
  "./js/http-range.js?v=19",
  "./js/mp4-atoms.js?v=19",
  "./js/mp4-metadata.js?v=19",
  "./js/offline-media-response.js?v=19",
  "./js/offline-panel.js?v=19",
  "./js/offline-selection.js?v=19",
  "./js/availability-session.js?v=19",
  "./js/availability.js?v=19",
  "./js/chapters.js?v=19",
  "./js/chapter-session.js?v=19",
  "./js/config.js?v=19",
  "./js/codecs.js?v=19",
  "./js/preferences.js?v=19",
  "./js/cover.js?v=19",
  "./js/book-config.js?v=19",
  "./js/book-selection.js?v=19",
  "./js/dialogs.js?v=19",
  "./js/custom-select.js?v=19",
  "./js/media-controller.js?v=19",
  "./js/media-session.js?v=19",
  "./js/mp4-chapters.js?v=19",
  "./js/offline.js?v=19",
  "./js/offline-book-store.js?v=19",
  "./js/progress-writer.js?v=19",
  "./js/offline-transfer.js?v=19",
  "./js/offline-lock.js?v=19",
  "./js/offline-manifest.js?v=19",
  "./js/source-selection.js?v=19",
  "./js/storage.js?v=19",
  "./js/sleep-timer.js?v=19",
  "./js/utils.js?v=19",
  "./js/vtt.js?v=19",
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
  return downloadedMediaResponse(request, manifest, (index) => cache.match(chunkUrl(manifest.downloadId, index)), async (index) => {
    try {
      await cache.put(damagedChunkUrl(self.registration.scope, manifest.downloadId, index), new Response(""));
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not record a damaged audio chunk.", error);
    }
    try {
      const clients = await self.clients?.matchAll({ type: "window" }) || [];
      for (const client of clients) client.postMessage({ type: "compact-player-damaged-chunk",
        scope: self.registration.scope, downloadId: manifest.downloadId, index });
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not report a damaged audio chunk.", error);
    }
  });
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
    response.headers.set(bookHeader, bookHeaderValue(manifest.episodeId, manifest.configBookId));
    return response;
  }
  return null;
}

async function networkFirstCover(request, url) {
  const source = url.searchParams.get("url");
  const version = url.searchParams.get("version");
  const bookId = url.searchParams.get("book");
  const configId = url.searchParams.get("config");
  let target;
  try { target = new URL(source); }
  catch { return new Response(null, { status: 400 }); }
  if (target.origin !== self.location.origin || version === null || !bookId || !configId) return new Response(null, { status: 400 });
  let response;
  try {
    response = await fetch(target.href, { mode: "no-cors", cache: "no-cache", credentials: "same-origin", signal: request.signal });
    if (response.ok || response.type === "opaque") return response;
  } catch (error) {
    if (request.signal.aborted) throw error;
  }
  const manifest = await activeManifest();
  if (manifest && manifest.episodeId === bookId && (!manifest.configBookId || manifest.configBookId === configId)
    && String(manifest.cacheVersion) === version) {
    const cache = await caches.open(manifest.cacheName);
    const saved = await cache.match(target.href);
    if (saved?.ok) return saved;
  }
  return response || Response.error();
}

function cachedFallback(request) {
  return SHELL_PATHS.has(new URL(request.url).pathname) ? cachedShell(request) : cachedBookResponse(request);
}

async function cachedShell(request) {
  const shell = await caches.open(SHELL_CACHE);
  if (request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname)) {
    return await shell.match(scopeUrl(`index.html?v=${SHELL_VERSION.slice(1)}`)) || shell.match(scopeUrl(`./?v=${SHELL_VERSION.slice(1)}`));
  }
  return shell.match(request);
}

async function validShellPage(response, allowNewer = false) {
  if (!response?.ok) return false;
  const html = (await response.clone().text()).replace(/<!--[\s\S]*?-->/g, "");
  const attributeValue = (tag, attribute) => {
    const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
    return match?.[2];
  };
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  const links = html.match(/<link\b[^>]*>/gi) || [];
  const scriptVersions = scripts.filter((tag) => attributeValue(tag, "type") === "module")
    .map((tag) => attributeValue(tag, "src")?.match(/^\.\/player\.js\?v=(\d+)$/)?.[1]);
  const styleVersions = links.filter((tag) => attributeValue(tag, "rel") === "stylesheet")
    .map((tag) => attributeValue(tag, "href")?.match(/^\.\/player\.css\?v=(\d+)$/)?.[1]);
  const current = Number(SHELL_VERSION.slice(1));
  return scriptVersions.some((version) => version && styleVersions.includes(version)
    && (allowNewer ? Number(version) >= current : Number(version) === current));
}

async function fetchShell(request) {
  const controller = typeof AbortSignal.any === "function" ? new AbortController() : null;
  const isPage = request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname);
  const signal = controller ? AbortSignal.any([request.signal, controller.signal]) : request.signal;
  const network = fetch(request, { signal })
    .then(async (response) => {
      if (isPage && response.ok && !await validShellPage(response, true)) throw new Error("Player shell version does not match the worker");
      return response;
    });
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
    const stagingName = `${SHELL_CACHE}:install:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const staging = await caches.open(stagingName);
    try {
      await staging.addAll(SHELL_URLS.map((path) => new Request(scopeUrl(path), { cache: "reload" })));
      for (const page of [`./?v=${SHELL_VERSION.slice(1)}`, `./index.html?v=${SHELL_VERSION.slice(1)}`]) {
        if (!await validShellPage(await staging.match(scopeUrl(page)))) throw new Error("Player shell version does not match the worker");
      }
      const cache = await caches.open(SHELL_CACHE);
      for (const request of await staging.keys()) await cache.put(request, await staging.match(request));
      await self.skipWaiting();
    } finally {
      await caches.delete(stagingName);
    }
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
  const savedUrl = new URL(request.url);
  if (request.destination === "image"
    && savedUrl.pathname === new URL(offlineMetaUrl(self.registration.scope, "cover")).pathname) {
    event.respondWith(networkFirstCover(request, savedUrl));
    return;
  }
  if (savedUrl.pathname === new URL(offlineMetaUrl(self.registration.scope, "audio")).pathname) {
    event.respondWith((async () => {
      const manifest = await activeManifest();
      if (!manifest || savedUrl.searchParams.get("download") !== manifest.downloadId) return new Response(null, { status: 404 });
      const cache = await caches.open(manifest.cacheName);
      return await cachedMediaResponse(request, manifest, cache) || new Response(null, { status: 404 });
    })());
    return;
  }
  // Native audio has no book version. Saved audio uses the validated internal URL above.
  if (request.destination === "audio") return;
  event.respondWith(networkFirst(request));
});
