const SHELL_VERSION = "v9";
const SHELL_CACHE = `compact-player-shell-${SHELL_VERSION}`;
const META_CACHE = "compact-player-offline-meta-v1";
const DOWNLOAD_HEADER = "x-compact-player-download";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./player.css?v=9",
  "./player.js?v=9",
  "./i18n.js?v=9",
  "./js/availability.js",
  "./js/chapters.js",
  "./js/config.js",
  "./js/book-config.js",
  "./js/dialogs.js",
  "./js/media-controller.js",
  "./js/mp4-chapters.js",
  "./js/offline.js",
  "./js/source-selection.js",
  "./js/storage.js",
  "./js/utils.js",
  "./js/vtt.js",
];

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

function chunkUrl(downloadId, index) {
  return scopeUrl(`__compact_player_offline__/chunks/${encodeURIComponent(downloadId)}/${index}`);
}

function validManifest(value) {
  return value?.schemaVersion === 1 && value.status === "ready" && value.downloadId && value.cacheName
    && value.sourceUrl && value.mime && Number.isSafeInteger(value.totalSize) && value.totalSize > 0
    && Number.isSafeInteger(value.chunkSize) && value.chunkSize > 0
    && Number.isSafeInteger(value.totalChunks) && value.totalChunks === Math.ceil(value.totalSize / value.chunkSize)
    && Array.isArray(value.completed) && new Set(value.completed).size === value.totalChunks
    && value.completed.every((index) => Number.isInteger(index) && index >= 0 && index < value.totalChunks);
}

async function activeManifest() {
  const meta = await caches.open(META_CACHE);
  const response = await meta.match(scopeUrl("__compact_player_offline__/active.json"));
  if (!response) return null;
  try {
    const record = await response.json();
    return record?.cacheName === record?.manifest?.cacheName && validManifest(record.manifest) ? record.manifest : null;
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
  const chunks = [];
  for (let index = firstChunk; index <= lastChunk; index += 1) {
    const response = await cache.match(chunkUrl(manifest.downloadId, index));
    if (!response) return null;
    chunks.push({ index, response });
  }
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (const { index, response } of chunks) {
          const data = new Uint8Array(await response.arrayBuffer());
          const chunkStart = index * manifest.chunkSize;
          const from = Math.max(0, range.start - chunkStart);
          const to = Math.min(data.byteLength, range.end - chunkStart + 1);
          if (to > from) controller.enqueue(data.subarray(from, to));
        }
        controller.close();
      } catch (error) { controller.error(error); }
    },
  });
  const headers = {
    "accept-ranges": "bytes",
    "content-length": String(range.end - range.start + 1),
    "content-type": manifest.mime,
  };
  if (range.partial) headers["content-range"] = `bytes ${range.start}-${range.end}/${manifest.totalSize}`;
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}

async function cachedFallback(request) {
  const manifest = await activeManifest();
  if (manifest) {
    const bookCache = await caches.open(manifest.cacheName);
    if (request.url === manifest.sourceUrl) {
      const response = await cachedMediaResponse(request, manifest, bookCache);
      if (response) return response;
    }
    const asset = await bookCache.match(request);
    if (asset) return asset;
  }
  const shell = await caches.open(SHELL_CACHE);
  if (request.mode === "navigate") return shell.match(scopeUrl("index.html")) || shell.match(scopeUrl("./"));
  return shell.match(request, { ignoreSearch: true });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok || response.status === 206) return response;
    return await cachedFallback(request) || response;
  } catch (error) {
    const cached = await cachedFallback(request);
    if (cached) return cached;
    throw error;
  }
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
    await Promise.all(names.filter((name) => name.startsWith("compact-player-shell-") && name !== SHELL_CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!["GET", "HEAD"].includes(request.method) || request.headers.get(DOWNLOAD_HEADER) === "1") return;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
