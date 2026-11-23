importScripts("./js/offline-manifest.js?v=20", "./js/offline-media-response.js?v=20");
const { validManifest, downloadHeader: DOWNLOAD_HEADER, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue,
  offlineMetaUrl, offlineChunkUrl, damagedChunkUrl, damageVersionHeader, networkStatusHeader, readActiveState,
  chunkReadTimeoutMs: SAVED_AUDIO_BODY_WAIT_MS } = globalThis.CompactPlayerOfflineManifest;
const SHELL_VERSION = "v20";
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
  "./?v=20",
  "./index.html?v=20",
  "./player.css?v=20",
  "./player.js?v=20",
  "./js/startup-error.js?v=20",
  "./i18n.js?v=20",
  "./js/player-app.js?v=20",
  "./js/player-worker.js?v=20",
  "./js/availability-cache.js?v=20",
  "./js/chapter-cache.js?v=20",
  "./js/chapter-panel.js?v=20",
  "./js/http-range.js?v=20",
  "./js/mp4-atoms.js?v=20",
  "./js/mp4-metadata.js?v=20",
  "./js/offline-media-response.js?v=20",
  "./js/offline-panel.js?v=20",
  "./js/offline-selection.js?v=20",
  "./js/availability-session.js?v=20",
  "./js/availability.js?v=20",
  "./js/chapters.js?v=20",
  "./js/chapter-session.js?v=20",
  "./js/config.js?v=20",
  "./js/codecs.js?v=20",
  "./js/preferences.js?v=20",
  "./js/cover.js?v=20",
  "./js/book-config.js?v=20",
  "./js/book-selection.js?v=20",
  "./js/dialogs.js?v=20",
  "./js/custom-select.js?v=20",
  "./js/media-controller.js?v=20",
  "./js/media-session.js?v=20",
  "./js/mp4-chapters.js?v=20",
  "./js/offline.js?v=20",
  "./js/offline-book-store.js?v=20",
  "./js/progress-writer.js?v=20",
  "./js/offline-transfer.js?v=20",
  "./js/offline-lock.js?v=20",
  "./js/offline-manifest.js?v=20",
  "./js/source-selection.js?v=20",
  "./js/storage.js?v=20",
  "./js/sleep-timer.js?v=20",
  "./js/utils.js?v=20",
  "./js/vtt.js?v=20",
];
const SHELL_PATHS = new Set(SHELL_URLS.map((path) => new URL(path, self.registration.scope).pathname));
const PLAYER_PAGES = new Set(["./", "index.html"].map((path) => new URL(path, self.registration.scope).pathname));
const RELEASE_ASSETS = new Map(Object.entries(SHELL_RELEASE?.assets || {}).map(([path, asset]) => [scopeUrl(path), asset]));
let releaseRebuild;

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
    response = await fetch(target.href, { mode: "no-cors", cache: "no-cache", credentials: "same-origin", signal: request.signal });
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

async function cachedShell(request, signal) {
  const shell = await caches.open(SHELL_CACHE);
  if (signal?.aborted) return null;
  if (request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname)) {
    if (SHELL_RELEASE) {
      const ready = (await shell.match(RELEASE_READY_URL))?.ok;
      return ready && !signal?.aborted ? shell.match(scopeUrl(SHELL_RELEASE.page)) : null;
    }
    const installed = await shell.match(scopeUrl(`index.html?v=${SHELL_VERSION.slice(1)}`));
    if (installed || signal?.aborted) return installed;
    return shell.match(scopeUrl(`./?v=${SHELL_VERSION.slice(1)}`));
  }
  return shell.match(request);
}

function invalidReleaseAsset(url) {
  return new Error(`Release asset does not match its manifest: ${url}`);
}

function cancelResponseBody(stream) {
  void stream?.cancel().catch(() => { /* The response body may already have failed. */ });
}

async function readShellBytes(body, maxBytes, signal) {
  if (signal?.aborted) {
    cancelResponseBody(body);
    throw signal.reason;
  }
  if (!body) return new Uint8Array(0);
  const bytes = new Uint8Array(maxBytes);
  const reader = body.getReader();
  let offset = 0;
  let ended = false;
  const cancel = () => {
    if (ended) return;
    ended = true;
    cancelResponseBody(reader);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!ended) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      ended = done;
      if (done) break;
      if (value.byteLength > bytes.length - offset) return null;
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    return bytes.subarray(0, offset);
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

function decodedShellResponse(response, bytes) {
  // Fetch exposes decoded bytes, even when the server sends a compressed response.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
}

async function matchesReleaseBytes(bytes, asset) {
  if (bytes?.byteLength !== asset.bytes) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === asset.sha256;
}

function fetchVerifiedReleaseAsset(url, asset, parent) {
  return withShellNetworkDeadline(async (signal) => {
    const response = await fetch(url, { cache: "reload", redirect: "error", signal });
    if (response.status !== 200 || response.redirected) {
      cancelResponseBody(response.body);
      throw invalidReleaseAsset(url);
    }
    const bytes = await readShellBytes(response.body, asset.bytes, signal);
    if (!await matchesReleaseBytes(bytes, asset)) throw invalidReleaseAsset(url);
    return decodedShellResponse(response, bytes);
  }, parent);
}

async function readCache(operation) {
  try {
    return await withCacheDeadline(operation, CACHE_FALLBACK_WAIT_MS);
  } catch (error) {
    console.warn("[CompactAudioPlayer] Could not read Cache Storage.", error);
    return null;
  }
}

function currentReleaseCache(url) {
  return readCache(async (signal) => {
    const shell = await caches.open(SHELL_CACHE);
    if (signal.aborted) return null;
    const ready = (await shell.match(RELEASE_READY_URL))?.ok === true;
    if (signal.aborted) return null;
    return { shell, ready, response: ready && url ? await shell.match(url) : null };
  });
}

async function populateRelease(shell, seed, signal) {
  for (const [url, asset] of RELEASE_ASSETS) {
    if (signal?.aborted) return;
    const response = seed?.url === url ? seed.response : await fetchVerifiedReleaseAsset(url, asset, signal);
    if (signal?.aborted) return;
    await shell.put(url, response);
  }
  if (!signal?.aborted) await shell.put(RELEASE_READY_URL, new Response(SHELL_RELEASE.id));
}

function rebuildRelease(shell, seedUrl, verified) {
  if (!releaseRebuild) {
    const seed = verified && { url: seedUrl, response: verified.clone() };
    releaseRebuild = withCacheDeadline(async (signal) => {
      const ready = (await shell.match(RELEASE_READY_URL))?.ok;
      if (!ready && !signal.aborted) await populateRelease(shell, seed, signal);
    }, RELEASE_REBUILD_TIMEOUT_MS).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not rebuild the release cache.", error);
    }).finally(() => { releaseRebuild = null; });
  }
  return releaseRebuild;
}

async function releaseAsset(request, url, asset, keepAlive) {
  const installed = await currentReleaseCache(url);
  if (installed?.response) return installed.response;
  const verified = await fetchVerifiedReleaseAsset(url, asset, request.signal);
  if (installed?.ready) {
    try {
      await withCacheDeadline(() => installed.shell.put(url, verified.clone()), CACHE_FALLBACK_WAIT_MS);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not restore the release asset in Cache Storage.", error);
    }
  } else if (installed && keepAlive) {
    keepAlive(rebuildRelease(installed.shell, url, verified));
  }
  return verified;
}

function releaseRequest(request) {
  if (!SHELL_RELEASE || request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return null;
  const relative = request.url.slice(self.registration.scope.length);
  const alias = request.mode === "navigate" && /^release-([a-f0-9]{64})\.html(?:\?.*)?$/.exec(relative);
  if (alias) return { id: alias[1], url: scopeUrl(`release-${alias[1]}.html`) };
  const asset = /^releases\/([a-f0-9]{64})\//.exec(relative);
  return asset ? { id: asset[1], url: request.url } : null;
}

function isReleaseCache(name, prefix) {
  return name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length));
}

async function isCompleteRelease(cacheName) {
  return (await caches.match(RELEASE_READY_URL, { cacheName }))?.ok === true;
}

async function previousReleaseAsset(release, signal) {
  const cacheName = VERIFIED_RELEASE_CACHE_PREFIX + release.id;
  if (await isCompleteRelease(cacheName) && !signal.aborted) {
    const response = await caches.match(release.url, { cacheName });
    if (response) return response;
  }
  return signal.aborted ? null : caches.match(release.url, { cacheName: RELEASE_CACHE_PREFIX + release.id });
}

function validShellPage(html, allowNewer) {
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  const attributeValue = (tag, attribute) => {
    const match = tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
    return match?.[2];
  };
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  const links = html.match(/<link\b[^>]*>/gi) || [];
  if (allowNewer) {
    const worker = html.match(/<meta name="compact-player-worker" content="sw-([a-f0-9]{64})\.js">/)?.[1];
    if (worker) {
      const sequence = Number(html.match(/<meta name="compact-player-release" content="(\d+)">/)?.[1]);
      if (!Number.isSafeInteger(sequence) || sequence < (SHELL_RELEASE?.sequence || 0)) return false;
      const base = `./releases/${worker}/`;
      return scripts.some((tag) => attributeValue(tag, "type") === "module" && attributeValue(tag, "src") === `${base}player.js`)
        && links.some((tag) => attributeValue(tag, "rel") === "stylesheet" && attributeValue(tag, "href") === `${base}player.css`);
    }
    if (SHELL_RELEASE) return false;
  }
  const scriptVersions = scripts.filter((tag) => attributeValue(tag, "type") === "module")
    .map((tag) => attributeValue(tag, "src")?.match(/^\.\/player\.js\?v=(\d+)$/)?.[1]);
  const styleVersions = links.filter((tag) => attributeValue(tag, "rel") === "stylesheet")
    .map((tag) => attributeValue(tag, "href")?.match(/^\.\/player\.css\?v=(\d+)$/)?.[1]);
  const current = Number(SHELL_VERSION.slice(1));
  return scriptVersions.some((version) => version && styleVersions.includes(version)
    && (allowNewer ? Number(version) >= current : Number(version) === current));
}

async function readShellPage(response, allowNewer, signal) {
  if (!response?.ok) return null;
  const bytes = await readShellBytes(response.body, SHELL_PAGE_MAX_BYTES, signal);
  if (!bytes || !validShellPage(new TextDecoder().decode(bytes), allowNewer)) return null;
  return { bytes, response: decodedShellResponse(response, bytes) };
}

async function rebuildFromPage(bytes) {
  try {
    const url = scopeUrl(SHELL_RELEASE.page);
    if (!await matchesReleaseBytes(bytes, RELEASE_ASSETS.get(url))) return;
    const installed = await currentReleaseCache();
    if (installed && !installed.ready) await rebuildRelease(installed.shell);
  } catch (error) {
    console.warn("[CompactAudioPlayer] Could not check the player page for cache recovery.", error);
  }
}

async function fetchShell(request, keepAlive) {
  const controller = new AbortController();
  const isPage = request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname);
  const network = withShellNetworkDeadline(async (signal) => {
    const response = await fetch(request, { signal });
    if (signal.aborted) {
      cancelResponseBody(response.body);
      throw signal.reason;
    }
    if (!isPage || !response.ok) return response;
    const page = await readShellPage(response, true, signal);
    if (page) {
      if (!signal.aborted && SHELL_RELEASE && keepAlive) keepAlive(rebuildFromPage(page.bytes));
      return page.response;
    }
    throw new Error("Player shell version does not match the worker");
  }, request.signal, controller);
  let timer;
  try {
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, SHELL_NETWORK_WAIT_MS); });
    const response = await Promise.race([network, deadline]);
    if (response) return response;
    // Keep the network in the race while Cache Storage opens, including on a cache miss.
    const cached = await Promise.race([network.then(() => null), readCache((signal) => cachedShell(request, signal))]);
    if (!cached?.ok) return network;
    controller.abort();
    return cached;
  } finally { clearTimeout(timer); }
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
    response = await (useShell ? fetchShell(request, keepAlive) : fetch(request));
    if (response.ok) return response;
  } catch (error) { networkError = error; }
  const cached = await readCache((signal) => cachedFallback(request, response?.status ?? "network-error", signal));
  if (cached) return cached;
  if (response) return response;
  throw networkError;
}

async function installRelease() {
  if (await isCompleteRelease(SHELL_CACHE)) return;
  try {
    await populateRelease(await caches.open(SHELL_CACHE));
  } catch (error) {
    try { await caches.delete(SHELL_CACHE); }
    catch (cause) { console.warn("[CompactAudioPlayer] Could not remove the incomplete release cache.", cause); }
    throw error;
  }
}

async function installSourceShell() {
  const stagingName = `${SHELL_CACHE}:install:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const staging = await caches.open(stagingName);
  try {
    await staging.addAll(SHELL_URLS.map((path) => new Request(scopeUrl(path), { cache: "reload" })));
    for (const page of [`./?v=${SHELL_VERSION.slice(1)}`, `./index.html?v=${SHELL_VERSION.slice(1)}`]) {
      if (!await readShellPage(await staging.match(scopeUrl(page)), false)) throw new Error("Player shell version does not match the worker");
    }
    const cache = await caches.open(SHELL_CACHE);
    for (const request of await staging.keys()) await cache.put(request, await staging.match(request));
  } finally {
    await caches.delete(stagingName);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (SHELL_RELEASE) await installRelease();
    else await installSourceShell();
    await self.skipWaiting();
  })());
});

async function previousCompleteRelease(names, signal) {
  for (const name of names.slice().reverse()) {
    if (signal.aborted) return null;
    if (name !== SHELL_CACHE && isReleaseCache(name, VERIFIED_RELEASE_CACHE_PREFIX) && await isCompleteRelease(name)) return name;
  }
  return null;
}

async function cleanUpShellCaches(signal) {
  const names = await caches.keys();
  if (signal.aborted) return;
  const previousRelease = SHELL_RELEASE && await previousCompleteRelease(names, signal);
  if (signal.aborted) return;
  // Older release caches have no marker. Keep them until we can retain a known complete predecessor instead.
  const obsolete = names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE
    && name !== previousRelease && !name.includes(":install:")
    && (!SHELL_RELEASE || previousRelease || !isReleaseCache(name, RELEASE_CACHE_PREFIX)));
  await Promise.all(obsolete.map((name) => caches.delete(name)));
}

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
