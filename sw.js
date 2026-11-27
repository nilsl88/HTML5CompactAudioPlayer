importScripts("./js/offline-manifest.js?v=25", "./js/offline-media-response.js?v=25", "./js/bounded-response.js?v=25", "./js/shell-release.js?v=25");
const { validManifest, downloadHeader: DOWNLOAD_HEADER, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue,
  offlineMetaUrl, damagedChunkUrl, damageVersionHeader, networkStatusHeader, readActiveState,
  requiredConfigUrl, offlineConfigCacheUrl, journalVersion,
  chunkReadTimeoutMs: SAVED_AUDIO_BODY_WAIT_MS } = globalThis.CompactPlayerOfflineManifest;
const { coverMaxBytes, isHtmlResponse, cancelResponseBody, readResponseBytes, responseWithDecodedBody } = globalThis.CompactPlayerResponse;
const SHELL_VERSION = "v25";
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
const RELEASE_REBUILD_TIMEOUT_MS = 60000;
const SHELL_URLS = [
  "./?v=25",
  "./index.html?v=25",
  "./player.css?v=25",
  "./player.js?v=25",
  "./js/startup-error.js?v=25",
  "./js/shell-release.js?v=25",
  "./i18n.js?v=25",
  "./js/player-app.js?v=25",
  "./js/player-worker.js?v=25",
  "./js/availability-cache.js?v=25",
  "./js/chapter-cache.js?v=25",
  "./js/chapter-panel.js?v=25",
  "./js/http-range.js?v=25",
  "./js/mp4-atoms.js?v=25",
  "./js/mp4-metadata.js?v=25",
  "./js/offline-media-response.js?v=25",
  "./js/offline-panel.js?v=25",
  "./js/offline-selection.js?v=25",
  "./js/availability-session.js?v=25",
  "./js/availability.js?v=25",
  "./js/chapters.js?v=25",
  "./js/chapter-session.js?v=25",
  "./js/config.js?v=25",
  "./js/codecs.js?v=25",
  "./js/preferences.js?v=25",
  "./js/cover.js?v=25",
  "./js/book-config.js?v=25",
  "./js/book-selection.js?v=25",
  "./js/book-session.js?v=25",
  "./js/bounded-response.js?v=25",
  "./js/dialogs.js?v=25",
  "./js/custom-select.js?v=25",
  "./js/media-controller.js?v=25",
  "./js/media-session.js?v=25",
  "./js/mp4-chapters.js?v=25",
  "./js/offline.js?v=25",
  "./js/offline-damage-recovery.js?v=25",
  "./js/offline-download-space.js?v=25",
  "./js/offline-inventory.js?v=25",
  "./js/offline-journal.js?v=25",
  "./js/offline-playback.js?v=25",
  "./js/offline-tab-sync.js?v=25",
  "./js/offline-worker-routes.js?v=25",
  "./js/offline-book-store.js?v=25",
  "./js/progress-writer.js?v=25",
  "./js/reset-dialog.js?v=25",
  "./js/seek-control.js?v=25",
  "./js/offline-transfer.js?v=25",
  "./js/offline-lock.js?v=25",
  "./js/offline-manifest.js?v=25",
  "./js/source-selection.js?v=25",
  "./js/storage.js?v=25",
  "./js/sleep-timer.js?v=25",
  "./js/utils.js?v=25",
  "./js/vtt.js?v=25",
];
const SHELL_PATHS = new Set(SHELL_URLS.map((path) => new URL(path, self.registration.scope).pathname));
const PLAYER_PAGES = new Set(["./", "index.html"].map((path) => new URL(path, self.registration.scope).pathname));
const RELEASE_ASSETS = new Map(Object.entries(SHELL_RELEASE?.assets || {}).map(([path, asset]) => [scopeUrl(path), asset]));
var { cachedShell, releaseAsset, releaseRequest, previousReleaseAsset, fetchShell,
  installRelease, installSourceShell, cleanUpShellCaches } = createShellRelease({
  scopeUrl, readCache, withCacheDeadline, withShellNetworkDeadline, preferNetwork, SHELL_VERSION, SHELL_RELEASE,
  SHELL_CACHE_PREFIX, RELEASE_CACHE_PREFIX, VERIFIED_RELEASE_CACHE_PREFIX, SHELL_CACHE,
  RELEASE_READY_URL, SHELL_PAGE_MAX_BYTES, CACHE_FALLBACK_WAIT_MS,
  RELEASE_REBUILD_TIMEOUT_MS, SHELL_URLS, PLAYER_PAGES, RELEASE_ASSETS,
});
var { cachedMediaResponse, cachedAudioRequest, savedAudioResponse } = createOfflineAudioRoutes({
  scope: self.registration.scope, readActive: (signal) => activeManifest(signal), openCache: (name) => caches.open(name),
  withAudioCacheDeadline, bodyTimeoutMs: SAVED_AUDIO_BODY_WAIT_MS, reportDamage: reportCachedAudioDamage,
});

function scopeUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function withCacheDeadline(operation, timeoutMs, controller = new AbortController()) {
  const { signal } = controller;
  if (signal.aborted) return null;
  let abort;
  let timer;
  const deadline = new Promise((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  });
  try { return await Promise.race([deadline, operation(signal)]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readCache(operation, { controller = new AbortController(), parent } = {}) {
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  try {
    return await withCacheDeadline(operation, CACHE_FALLBACK_WAIT_MS, controller);
  } catch (error) {
    if (!controller.signal.aborted) console.warn("[CompactAudioPlayer] Could not read Cache Storage.", error);
    return null;
  } finally {
    parent?.removeEventListener("abort", abort);
  }
}

async function preferNetwork(network, readCached, useCached) {
  const cacheController = new AbortController();
  let timer;
  let lookup;
  let usingCache = false;
  try {
    const delay = new Promise((resolve) => { timer = setTimeout(resolve, SHELL_NETWORK_WAIT_MS); });
    const response = await Promise.race([network, delay]);
    if (response) return response;

    lookup = readCache(readCached, { controller: cacheController });
    const cached = await Promise.race([network.then(() => null), lookup]);
    if (!cached?.ok) return network;
    usingCache = true;
    useCached();
    return cached;
  } finally {
    clearTimeout(timer);
    if (!usingCache && lookup) {
      cacheController.abort();
      void lookup.then((response) => cancelResponseBody(response?.body));
    }
  }
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

async function cachedBookResponse(request, networkStatus, signal) {
  const manifest = await activeManifest(signal);
  if (manifest && !signal?.aborted) {
    const bookCache = await caches.open(manifest.cacheName);
    if (signal?.aborted) return null;
    if (request.url === manifest.sourceUrl) {
      return cachedAudioRequest(request, { manifest, cache: bookCache }, signal ?? request.signal);
    }
    const configKey = request.method === "GET" && request.url === requiredConfigUrl(manifest)
      && offlineConfigCacheUrl(self.registration.scope, manifest);
    const asset = await bookCache.match(configKey || request);
    if (signal?.aborted) {
      cancelResponseBody(asset?.body);
      return null;
    }
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
      if (isHtmlResponse(network)) {
        cancelResponseBody(network.body);
        return Response.error();
      }
      const bytes = await readResponseBytes(network.body, coverMaxBytes, signal);
      if (!bytes) throw new Error("Cover image exceeds 16 MiB.");
      return responseWithDecodedBody(network, bytes);
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
    if (signal.aborted) return null;
    const asset = await cache.match(target.href);
    if (!signal.aborted) return asset;
    cancelResponseBody(asset?.body);
    return null;
  }, { parent: request.signal });
  if (request.signal.aborted) {
    cancelResponseBody(response?.body);
    cancelResponseBody(saved?.body);
    throw request.signal.reason;
  }
  if (saved?.ok) {
    cancelResponseBody(response?.body);
    return saved;
  }
  cancelResponseBody(saved?.body);
  return response || Response.error();
}

function cachedFallback(request, networkStatus, signal) {
  return SHELL_PATHS.has(new URL(request.url).pathname) ? cachedShell(request, signal) : cachedBookResponse(request, networkStatus, signal);
}

async function fetchBook(request) {
  const controller = new AbortController();
  const combinedSignal = AbortSignal.any?.([request.signal, controller.signal]);
  const signal = combinedSignal ?? controller.signal;
  const forwardAbort = () => controller.abort(request.signal.reason);
  if (!combinedSignal) {
    if (request.signal.aborted) forwardAbort();
    else request.signal.addEventListener("abort", forwardAbort, { once: true });
  }
  const network = Promise.resolve(fetch(request, { signal })).then(async (response) => {
    const name = new URL(request.url).pathname.split("/").at(-1);
    if (request.method !== "GET" || response.status !== 200
      || !["book.json", "episode.json", "library.json"].includes(name)) return response;
    const bytes = await readResponseBytes(response.body, (name === "library.json" ? 2 : 1) * 1024 ** 2, signal);
    if (!bytes) return new Response(null, { status: 413 });
    return responseWithDecodedBody(response, bytes);
  });
  try {
    return await preferNetwork(network, (signal) => cachedBookResponse(request, "network-error", signal), () => {
      controller.abort();
      void network.then((response) => cancelResponseBody(response.body), () => {});
    });
  } finally {
    // An uncached response may still be streaming when the function returns.
    if (!combinedSignal && signal.aborted) request.signal.removeEventListener("abort", forwardAbort);
  }
}

async function networkFirst(request, keepAlive) {
  if (request.signal.aborted) throw request.signal.reason;
  const release = releaseRequest(request);
  if (release) {
    const asset = RELEASE_ASSETS.get(release.url);
    if (asset) return releaseAsset(request, release.url, asset, keepAlive);
    if (release.id !== SHELL_RELEASE.id) {
      const previous = await readCache((signal) => previousReleaseAsset(release, signal), { parent: request.signal });
      if (request.signal.aborted) {
        cancelResponseBody(previous?.body);
        throw request.signal.reason;
      }
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
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    networkError = error;
  }
  if (request.signal.aborted) {
    cancelResponseBody(response?.body);
    throw request.signal.reason;
  }
  const cached = await readCache((signal) => cachedFallback(request, response?.status ?? "network-error", signal), { parent: request.signal });
  if (request.signal.aborted) {
    cancelResponseBody(response?.body);
    cancelResponseBody(cached?.body);
    throw request.signal.reason;
  }
  if (cached) {
    cancelResponseBody(response?.body);
    return cached;
  }
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
    type, scope: self.registration.scope, audio: true, cover: true, offlineJournal: journalVersion,
    releaseId: SHELL_RELEASE?.id ?? null, sequence: SHELL_RELEASE?.sequence || 0,
  });
});
