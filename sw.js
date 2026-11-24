importScripts("./js/offline-manifest.js?v=22", "./js/offline-media-response.js?v=22", "./js/shell-release.js?v=22");
const { validManifest, downloadHeader: DOWNLOAD_HEADER, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue,
  offlineMetaUrl, offlineChunkUrl, damagedChunkUrl, damageVersionHeader, networkStatusHeader, readActiveState,
  chunkReadTimeoutMs: SAVED_AUDIO_BODY_WAIT_MS } = globalThis.CompactPlayerOfflineManifest;
const SHELL_VERSION = "v22";
const SHELL_RELEASE = null;
const SHELL_CACHE_PREFIX = `compact-player-app-shell:${encodeURIComponent(new URL(self.registration.scope).pathname)}:`;
const RELEASE_CACHE_PREFIX = SHELL_CACHE_PREFIX + "release-";
const VERIFIED_RELEASE_CACHE_PREFIX = RELEASE_CACHE_PREFIX + "v2-";
const SHELL_CACHE = SHELL_RELEASE ? VERIFIED_RELEASE_CACHE_PREFIX + SHELL_RELEASE.id : SHELL_CACHE_PREFIX + SHELL_VERSION;
const RELEASE_READY_URL = scopeUrl("__compact_player_shell__/release-ready");
const SHELL_NETWORK_WAIT_MS = 3000;
const SHELL_RESPONSE_TIMEOUT_MS = 15000;
const SHELL_PAGE_MAX_BYTES = 256 * 1024;
const SHELL_CLEANUP_WAIT_MS = 1000;
const CACHE_FALLBACK_WAIT_MS = 750;
const SAVED_AUDIO_CACHE_WAIT_MS = 1500;
const SAVED_AUDIO_REPORT_WINDOW_MS = 60000;
const COVER_MAX_BYTES = 16 * 1024 ** 2;
const RELEASE_REBUILD_TIMEOUT_MS = 60000;
const SHELL_URLS = [
  "./?v=22",
  "./index.html?v=22",
  "./player.css?v=22",
  "./player.js?v=22",
  "./js/startup-error.js?v=22",
  "./js/shell-release.js?v=22",
  "./i18n.js?v=22",
  "./js/player-app.js?v=22",
  "./js/player-worker.js?v=22",
  "./js/availability-cache.js?v=22",
  "./js/chapter-cache.js?v=22",
  "./js/chapter-panel.js?v=22",
  "./js/http-range.js?v=22",
  "./js/mp4-atoms.js?v=22",
  "./js/mp4-metadata.js?v=22",
  "./js/offline-media-response.js?v=22",
  "./js/offline-panel.js?v=22",
  "./js/offline-selection.js?v=22",
  "./js/availability-session.js?v=22",
  "./js/availability.js?v=22",
  "./js/chapters.js?v=22",
  "./js/chapter-session.js?v=22",
  "./js/config.js?v=22",
  "./js/codecs.js?v=22",
  "./js/preferences.js?v=22",
  "./js/cover.js?v=22",
  "./js/book-config.js?v=22",
  "./js/book-selection.js?v=22",
  "./js/book-session.js?v=22",
  "./js/dialogs.js?v=22",
  "./js/custom-select.js?v=22",
  "./js/media-controller.js?v=22",
  "./js/media-session.js?v=22",
  "./js/mp4-chapters.js?v=22",
  "./js/offline.js?v=22",
  "./js/offline-damage-recovery.js?v=22",
  "./js/offline-book-store.js?v=22",
  "./js/progress-writer.js?v=22",
  "./js/offline-transfer.js?v=22",
  "./js/offline-lock.js?v=22",
  "./js/offline-manifest.js?v=22",
  "./js/source-selection.js?v=22",
  "./js/storage.js?v=22",
  "./js/sleep-timer.js?v=22",
  "./js/utils.js?v=22",
  "./js/vtt.js?v=22",
];
const SHELL_PATHS = new Set(SHELL_URLS.map((path) => new URL(path, self.registration.scope).pathname));
const PLAYER_PAGES = new Set(["./", "index.html"].map((path) => new URL(path, self.registration.scope).pathname));
const RELEASE_ASSETS = new Map(Object.entries(SHELL_RELEASE?.assets || {}).map(([path, asset]) => [scopeUrl(path), asset]));
var { cancelResponseBody, cachedShell, invalidReleaseAsset, readShellBytes, decodedShellResponse, matchesReleaseBytes, fetchVerifiedReleaseAsset, readCache, currentReleaseCache, populateRelease, rebuildRelease, releaseAsset, releaseRequest, isReleaseCache, isCompleteRelease, previousReleaseAsset, validShellPage, readShellPage, rebuildFromPage, fetchShell, installRelease, installSourceShell, previousCompleteRelease, cleanUpShellCaches } = createShellRelease({
  scopeUrl, withCacheDeadline, withShellNetworkDeadline, SHELL_VERSION, SHELL_RELEASE,
  SHELL_CACHE_PREFIX, RELEASE_CACHE_PREFIX, VERIFIED_RELEASE_CACHE_PREFIX, SHELL_CACHE,
  RELEASE_READY_URL, SHELL_NETWORK_WAIT_MS, SHELL_PAGE_MAX_BYTES, CACHE_FALLBACK_WAIT_MS,
  RELEASE_REBUILD_TIMEOUT_MS, SHELL_URLS, PLAYER_PAGES, RELEASE_ASSETS,
});

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function withCacheDeadline(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
  });
  try { return await Promise.race([deadline, operation(controller.signal)]); }
  finally { clearTimeout(timer); }
}

async function withAbortDeadline(operation, { parent, controller = new AbortController(), timeoutMs, timeoutMessage }) {
  const { signal } = controller;
  const forwardAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) forwardAbort();
  if (signal.aborted) throw signal.reason;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason); });
  signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException(timeoutMessage, "TimeoutError")), timeoutMs);
  parent?.addEventListener("abort", forwardAbort, { once: true });
  try {
    return await Promise.race([aborted, operation(signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAbort);
    parent?.removeEventListener("abort", forwardAbort);
  }
}

function withShellNetworkDeadline(operation, parent, controller) {
  return withAbortDeadline(operation, { parent, controller, timeoutMs: SHELL_RESPONSE_TIMEOUT_MS,
    timeoutMessage: "Player shell request timed out." });
}

function withAudioCacheDeadline(operation, parent, timeoutMs = SAVED_AUDIO_CACHE_WAIT_MS) {
  return withAbortDeadline(operation, { parent, timeoutMs, timeoutMessage: "Saved audio cache read timed out." });
}

function chunkUrl(downloadId, index) {
  return offlineChunkUrl(self.registration.scope, downloadId, index);
}

function abortableCachedBody(response, signal) {
  if (!response.body || !signal || typeof TransformStream !== "function") return response;
  return new Response(response.body.pipeThrough(new TransformStream(), { signal }));
}

async function activeManifest(signal) {
  const record = await readActiveState(self.registration.scope, async (url, cacheName) => {
    const response = await caches.match(url, { cacheName });
    if (signal?.aborted) {
      cancelResponseBody(response?.body);
      throw signal.reason;
    }
    if (!response) return null;
    try { return await abortableCachedBody(response, signal).json(); }
    catch (error) {
      if (error?.name === "SyntaxError") return null;
      throw error;
    }
  }, signal, caches);
  const manifest = record.manifest;
  const currentEpoch = !record.resetId || String(manifest?.downloadId).startsWith(record.resetId + ".");
  return currentEpoch && record.cacheName === manifest?.cacheName && validManifest(manifest, "ready") ? manifest : null;
}

async function reportCachedAudioDamage(cache, manifest, index) {
  try {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const marker = new Response("", { headers: { [damageVersionHeader]: id } });
    await withCacheDeadline(() => cache.put(damagedChunkUrl(self.registration.scope, manifest.downloadId, index), marker), CACHE_FALLBACK_WAIT_MS);
  } catch (error) {
    console.warn("[CompactAudioPlayer] Could not record a damaged audio chunk.", error);
  }
  try {
    await withCacheDeadline(async (signal) => {
      const clients = await self.clients?.matchAll({ type: "window" }) || [];
      if (signal.aborted) return;
      for (const client of clients) client.postMessage({ type: "compact-player-damaged-chunk",
        scope: self.registration.scope, downloadId: manifest.downloadId, index });
    }, CACHE_FALLBACK_WAIT_MS);
  } catch (error) {
    console.warn("[CompactAudioPlayer] Could not report a damaged audio chunk.", error);
  }
}

function cachedMediaResponse(request, manifest, cache, finish = () => {}) {
  const readChunk = (index, parent) => withAudioCacheDeadline(async (signal) => {
    const response = await cache.match(chunkUrl(manifest.downloadId, index));
    if (signal.aborted) cancelResponseBody(response?.body);
    return response;
  }, parent);
  return downloadedMediaResponse(request, manifest, readChunk, {
    readBody: (response, expected, parent) => withAudioCacheDeadline(
      (signal) => readStoredAudioChunk(response, expected, signal), parent, SAVED_AUDIO_BODY_WAIT_MS),
    reportInvalidChunk: (index) => finish(reportCachedAudioDamage(cache, manifest, index)),
    finish,
  });
}

async function savedAudioResponse(request, url, finish) {
  try {
    const download = await withAudioCacheDeadline(async (signal) => {
      const manifest = await activeManifest(signal);
      if (signal.aborted || !manifest || url.searchParams.get("download") !== manifest.downloadId) return null;
      const cache = await caches.open(manifest.cacheName);
      return { manifest, cache };
    }, request.signal);
    if (download) {
      const media = await cachedMediaResponse(request, download.manifest, download.cache, finish);
      if (media) return media;
    }
    return new Response(null, { status: 404 });
  } catch (error) {
    if (request.signal.aborted) throw error;
    console.warn("[CompactAudioPlayer] Could not read saved audio.", error);
    return new Response(null, { status: 503 });
  }
}

async function cachedBookResponse(request, networkStatus, signal) {
  const manifest = await activeManifest(signal);
  if (manifest && !signal?.aborted) {
    const bookCache = await caches.open(manifest.cacheName);
    if (signal?.aborted) return null;
    if (request.url === manifest.sourceUrl) {
      const response = await cachedMediaResponse(request, manifest, bookCache);
      if (response) return response;
    }
    if (signal?.aborted) return null;
    const asset = await bookCache.match(request);
    if (!asset?.ok || request.destination) return asset;
    // Expose the saved edition to fetch() callers. Native image and navigation responses keep their URL.
    const response = new Response(asset.body, asset);
    response.headers.set(versionHeader, versionHeaderValue(manifest.cacheVersion));
    response.headers.set(bookHeader, bookHeaderValue(manifest.episodeId, manifest.configBookId));
    if (networkStatus != null) response.headers.set(networkStatusHeader, String(networkStatus));
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
    response = await withAbortDeadline(async (signal) => {
      const network = await fetch(target.href, { mode: "no-cors", cache: "no-cache", credentials: "same-origin", signal });
      if (!network.ok) return network;
      const bytes = await readShellBytes(network.body, COVER_MAX_BYTES, signal);
      if (!bytes) throw new Error("Cover image exceeds 16 MiB.");
      return decodedShellResponse(network, bytes);
    }, { parent: request.signal, timeoutMs: SHELL_NETWORK_WAIT_MS, timeoutMessage: "Cover request timed out." });
    if (response.ok || response.type === "opaque") return response;
  } catch (error) {
    if (request.signal.aborted) throw error;
  }
  const saved = await readCache(async (signal) => {
    const manifest = await activeManifest(signal);
    if (signal.aborted || !manifest || manifest.episodeId !== bookId
      || (manifest.configBookId && manifest.configBookId !== configId) || String(manifest.cacheVersion) !== version) return null;
    const cache = await caches.open(manifest.cacheName);
    return signal.aborted ? null : cache.match(target.href);
  });
  if (saved?.ok) return saved;
  return response || Response.error();
}

function cachedFallback(request, networkStatus, signal) {
  return SHELL_PATHS.has(new URL(request.url).pathname) ? cachedShell(request, signal) : cachedBookResponse(request, networkStatus, signal);
}

async function fetchBook(request) {
  const controller = new AbortController();
  const signal = AbortSignal.any?.([request.signal, controller.signal]) ?? request.signal;
  const network = Promise.resolve(fetch(request, { signal })).then(async (response) => {
    const name = new URL(request.url).pathname.split("/").at(-1);
    if (request.method !== "GET" || response.status !== 200
      || !["book.json", "episode.json", "library.json"].includes(name)) return response;
    const bytes = await readShellBytes(response.body, (name === "library.json" ? 2 : 1) * 1024 ** 2, signal);
    if (!bytes) return new Response(null, { status: 413 });
    return decodedShellResponse(response, bytes);
  });
  let timer;
  try {
    const delay = new Promise((resolve) => { timer = setTimeout(resolve, SHELL_NETWORK_WAIT_MS); });
    const response = await Promise.race([network, delay]);
    if (response) return response;
    const cached = await Promise.race([
      network.then(() => null),
      readCache((cacheSignal) => cachedBookResponse(request, "network-error", cacheSignal)),
    ]);
    if (!cached?.ok) return network;
    controller.abort();
    void network.then((response) => cancelResponseBody(response.body), () => {});
    return cached;
  } finally {
    clearTimeout(timer);
  }
}

async function networkFirst(request, keepAlive) {
  const release = releaseRequest(request);
  if (release) {
    const asset = RELEASE_ASSETS.get(release.url);
    if (asset) return releaseAsset(request, release.url, asset, keepAlive);
    if (release.id !== SHELL_RELEASE.id) {
      const previous = await readCache((signal) => previousReleaseAsset(release, signal));
      if (previous) return previous;
    }
    return fetch(request);
  }
  let response;
  let networkError;
  try {
    const path = new URL(request.url).pathname;
    const paths = request.mode === "navigate" ? PLAYER_PAGES : SHELL_PATHS;
    const useShell = request.method === "GET" && paths.has(path);
    response = await (useShell ? fetchShell(request, keepAlive) : fetchBook(request));
    if (response.ok) return response;
  } catch (error) { networkError = error; }
  const cached = await readCache((signal) => cachedFallback(request, response?.status ?? "network-error", signal));
  if (cached) return cached;
  if (response) return response;
  throw networkError;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (SHELL_RELEASE) await installRelease();
    else await installSourceShell();
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    withCacheDeadline(cleanUpShellCaches, SHELL_CLEANUP_WAIT_MS).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not clean up old player caches.", error);
    }),
  ]));
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
    let finish;
    const lifetime = new Promise((resolve) => { finish = resolve; });
    // Keep early damage reports alive without holding the event open for a whole audiobook.
    event.waitUntil(withCacheDeadline(() => lifetime, SAVED_AUDIO_REPORT_WINDOW_MS));
    event.respondWith(savedAudioResponse(request, savedUrl, finish).then((response) => {
      if (!response.body) finish();
      return response;
    }, (error) => {
      finish();
      throw error;
    }));
    return;
  }
  // Native audio has no book version. Saved audio uses the validated internal URL above.
  if (request.destination === "audio") return;
  if (SHELL_RELEASE) {
    let recovery;
    const response = networkFirst(request, (work) => { recovery = work; });
    event.respondWith(response);
    event.waitUntil(response.then(() => recovery, () => recovery));
  } else {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener("message", (event) => {
  const type = "compact-player-worker-capabilities";
  if (event.data?.type === type) event.ports[0]?.postMessage({
    type, scope: self.registration.scope, audio: true, cover: true, offlineJournal: 1,
    releaseId: SHELL_RELEASE?.id ?? null, sequence: SHELL_RELEASE?.sequence || 0,
  });
});
