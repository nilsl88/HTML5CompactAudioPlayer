importScripts("./js/offline-manifest.js");
const { validManifest, metaCache: META_CACHE, downloadHeader: DOWNLOAD_HEADER, offlineMetaUrl, offlineChunkUrl } = globalThis.CompactPlayerOfflineManifest;
const SHELL_VERSION = "v14";
const SHELL_CACHE_PREFIX = `compact-player-app-shell:${encodeURIComponent(new URL(self.registration.scope).pathname)}:`;
const SHELL_CACHE = SHELL_CACHE_PREFIX + SHELL_VERSION;
const SHELL_URLS = [
  "./",
  "./index.html",
  "./player.css?v=14",
  "./player.js?v=14",
  "./i18n.js?v=14",
  "./js/player-app.js",
  "./js/availability-session.js",
  "./js/availability.js",
  "./js/chapters.js",
  "./js/chapter-session.js",
  "./js/config.js",
  "./js/codecs.js",
  "./js/preferences.js",
  "./js/cover.js",
  "./js/book-config.js",
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

function parseRange(value, totalSize) {
  if (!value) return { start: 0, end: totalSize - 1, partial: false };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) return null;
    end = Math.min(end, totalSize - 1);
  }
  return { start, end, partial: true };
}

async function cachedMediaResponse(request, manifest, cache) {
  if (request.method === "HEAD") {
    return new Response(null, { headers: {
      "accept-ranges": "bytes",
      "content-length": String(manifest.totalSize),
      "content-type": manifest.mime,
    } });
  }
  const range = parseRange(request.headers.get("range"), manifest.totalSize);
  if (!range) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${manifest.totalSize}` } });
  }
  const firstChunk = Math.floor(range.start / manifest.chunkSize);
  const lastChunk = Math.floor(range.end / manifest.chunkSize);
  let index = firstChunk;
  let firstResponse = await cache.match(chunkUrl(manifest.downloadId, index));
  if (!firstResponse) return null;
  let canceled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      const response = firstResponse || await cache.match(chunkUrl(manifest.downloadId, index));
      firstResponse = null;
      if (canceled) return;
      if (!response) throw new Error("A downloaded audio chunk is missing.");
      const data = new Uint8Array(await response.arrayBuffer());
      if (canceled) return;
      const chunkStart = index * manifest.chunkSize;
      if (data.length !== Math.min(manifest.chunkSize, manifest.totalSize - chunkStart)) throw new Error("A downloaded audio chunk is incomplete.");
      const from = Math.max(0, range.start - chunkStart);
      const to = Math.min(data.length, range.end - chunkStart + 1);
      controller.enqueue(data.subarray(from, to));
      if (++index > lastChunk) controller.close();
    },
    cancel() { canceled = true; firstResponse = null; },
  }, { highWaterMark: 0 });
  const headers = {
    "accept-ranges": "bytes",
    "content-length": String(range.end - range.start + 1),
    "content-type": manifest.mime,
  };
  if (range.partial) headers["content-range"] = `bytes ${range.start}-${range.end}/${manifest.totalSize}`;
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}

async function cachedBookResponse(request) {
  const manifest = await activeManifest();
  if (manifest) {
    const bookCache = await caches.open(manifest.cacheName);
    if (request.url === manifest.sourceUrl) {
      const response = await cachedMediaResponse(request, manifest, bookCache);
      if (response) return response;
    }
    return bookCache.match(request);
  }
  return null;
}

async function cachedFallback(request) {
  if (!SHELL_PATHS.has(new URL(request.url).pathname)) {
    if (request.mode !== "navigate") return cachedBookResponse(request);
    try {
      const asset = await cachedBookResponse(request);
      if (asset) return asset;
    } catch (error) { console.warn("[CompactAudioPlayer] Could not read the downloaded book during navigation.", error); }
  }
  const shell = await caches.open(SHELL_CACHE);
  if (request.mode === "navigate") return await shell.match(scopeUrl("index.html")) || shell.match(scopeUrl("./"));
  return shell.match(request, { ignoreSearch: true });
}

async function networkFirst(request) {
  let response;
  let networkError;
  try {
    response = await fetch(request);
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
