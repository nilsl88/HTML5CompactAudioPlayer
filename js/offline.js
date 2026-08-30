const MEBIBYTE = 1024 * 1024;

export const OFFLINE_SCHEMA_VERSION = 1;
export const OFFLINE_CHUNK_SIZE = 8 * MEBIBYTE;
export const OFFLINE_META_CACHE = "compact-player-offline-meta-v1";
export const OFFLINE_BOOK_CACHE_PREFIX = "compact-player-offline-book-v1-";
export const OFFLINE_DOWNLOAD_HEADER = "x-compact-player-download";

function asUrl(baseUrl, path) {
  return new URL(path, baseUrl).href;
}

export function offlineMetaUrl(baseUrl, type) {
  return asUrl(baseUrl, `__compact_player_offline__/${type}.json`);
}

export function offlineManifestUrl(baseUrl) {
  return asUrl(baseUrl, "__compact_player_offline__/manifest.json");
}

export function offlineChunkUrl(baseUrl, downloadId, index) {
  return asUrl(baseUrl, `__compact_player_offline__/chunks/${encodeURIComponent(downloadId)}/${index}`);
}

export function parseContentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || start > end || end >= total) return null;
  return { start, end, total };
}

export function chunkBounds(index, totalSize, chunkSize = OFFLINE_CHUNK_SIZE) {
  const start = index * chunkSize;
  return { start, end: Math.min(totalSize - 1, start + chunkSize - 1) };
}

export function completedBytes(manifest) {
  if (!validManifest(manifest)) return 0;
  return manifest.completed.reduce((total, index) => {
    const { start, end } = chunkBounds(index, manifest.totalSize, manifest.chunkSize);
    return total + Math.max(0, end - start + 1);
  }, 0);
}

export function validManifest(value, requiredStatus = "") {
  if (!value || value.schemaVersion !== OFFLINE_SCHEMA_VERSION) return false;
  if (!value.downloadId || !value.cacheName || !value.episodeId || !value.languageCode || !value.sourceId || !value.sourceUrl || !value.mime) return false;
  if (!Number.isSafeInteger(value.totalSize) || value.totalSize <= 0 || !Number.isSafeInteger(value.chunkSize) || value.chunkSize <= 0) return false;
  if (!Number.isSafeInteger(value.totalChunks) || value.totalChunks !== Math.ceil(value.totalSize / value.chunkSize)) return false;
  if (!Array.isArray(value.completed) || new Set(value.completed).size !== value.completed.length
    || value.completed.some((index) => !Number.isInteger(index) || index < 0 || index >= value.totalChunks)) return false;
  if (!["downloading", "ready"].includes(value.status) || (requiredStatus && value.status !== requiredStatus)) return false;
  if (value.status === "ready" && value.completed.length !== value.totalChunks) return false;
  return true;
}

export function manifestMatchesSelection(manifest, selection) {
  return validManifest(manifest) && manifest.episodeId === selection?.episodeId
    && manifest.languageCode === selection?.languageCode
    && manifest.sourceId === selection?.sourceId
    && manifest.sourceUrl === selection?.sourceUrl
    && String(manifest.cacheVersion) === String(selection?.cacheVersion);
}

export class OfflineDownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OfflineDownloadError";
    this.code = code;
  }
}

async function responseJson(response) {
  if (!response) return null;
  try { return await response.json(); }
  catch { return null; }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function createDownloadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Service worker setup timed out")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class OfflineManager {
  constructor({
    baseUrl,
    onChange = () => {},
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cacheStorage = globalThis.caches,
    navigatorObject = globalThis.navigator,
  } = {}) {
    this.baseUrl = new URL("./", baseUrl || globalThis.location?.href || "http://localhost/").href;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.cacheStorage = cacheStorage;
    this.navigator = navigatorObject;
    this.supported = Boolean(fetchImpl && cacheStorage && navigatorObject?.serviceWorker && globalThis.isSecureContext !== false);
    this.active = null;
    this.staging = null;
    this.phase = "idle";
    this.progress = 0;
    this.abortController = null;
    this.currentPromise = null;
  }

  snapshot() {
    return {
      supported: this.supported,
      active: this.active,
      staging: this.staging,
      phase: this.phase,
      progress: this.progress,
    };
  }

  emit() { this.onChange(this.snapshot()); }

  setPhase(phase, progress = this.progress) {
    this.phase = phase;
    this.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    this.emit();
  }

  async init() {
    if (!this.supported) { this.emit(); return this.snapshot(); }
    try {
      await withTimeout(this.navigator.serviceWorker.register(new URL("sw.js", this.baseUrl), { scope: new URL(this.baseUrl).pathname }), 8000);
      await withTimeout(this.navigator.serviceWorker.ready, 8000);
      await this.refresh();
    } catch {
      this.supported = false;
      this.active = null;
      this.staging = null;
      this.emit();
    }
    return this.snapshot();
  }

  async metaCache() { return this.cacheStorage.open(OFFLINE_META_CACHE); }

  async readRecord(type) {
    const cache = await this.metaCache();
    const record = await responseJson(await cache.match(offlineMetaUrl(this.baseUrl, type)));
    const status = type === "active" ? "ready" : "downloading";
    return validManifest(record?.manifest, status) && record.cacheName === record.manifest.cacheName ? record.manifest : null;
  }

  async writeRecord(type, manifest) {
    const cache = await this.metaCache();
    const key = offlineMetaUrl(this.baseUrl, type);
    if (!manifest) { await cache.delete(key); return; }
    await cache.put(key, jsonResponse({ schemaVersion: OFFLINE_SCHEMA_VERSION, cacheName: manifest.cacheName, manifest }));
  }

  async readBookManifest(cacheName) {
    try {
      const cache = await this.cacheStorage.open(cacheName);
      let manifest = await responseJson(await cache.match(offlineManifestUrl(this.baseUrl)));
      if (!validManifest(manifest) || manifest.cacheName !== cacheName) return null;
      const present = await Promise.all(manifest.completed.map(async (index) => Boolean(await cache.match(offlineChunkUrl(this.baseUrl, manifest.downloadId, index)))));
      if (manifest.status === "ready" && present.some((exists) => !exists)) return null;
      if (manifest.status === "downloading" && present.some((exists) => !exists)) {
        manifest = { ...manifest, completed: manifest.completed.filter((_index, position) => present[position]) };
        await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
      }
      return manifest;
    } catch { return null; }
  }

  async refresh() {
    if (!this.supported) return this.snapshot();
    this.active = await this.readRecord("active");
    this.staging = await this.readRecord("staging");
    const cacheNames = new Set(await this.cacheStorage.keys());
    if (this.active) {
      const stored = cacheNames.has(this.active.cacheName) ? await this.readBookManifest(this.active.cacheName) : null;
      if (!validManifest(stored, "ready")) {
        this.active = null;
        await this.writeRecord("active", null);
      } else {
        this.active = stored;
        await this.writeRecord("active", stored);
      }
    }
    if (this.staging) {
      const stored = cacheNames.has(this.staging.cacheName) ? await this.readBookManifest(this.staging.cacheName) : null;
      if (!validManifest(stored, "downloading")) {
        this.staging = null;
        await this.writeRecord("staging", null);
      } else {
        this.staging = stored;
        await this.writeRecord("staging", stored);
      }
    }
    const bookNames = [...cacheNames].filter((name) => name.startsWith(OFFLINE_BOOK_CACHE_PREFIX));
    const manifests = (await Promise.all(bookNames.map((name) => this.readBookManifest(name)))).filter(Boolean);
    if (!this.active) {
      this.active = manifests.filter((manifest) => manifest.status === "ready").sort((a, b) => b.downloadedAt - a.downloadedAt)[0] || null;
      if (this.active) await this.writeRecord("active", this.active);
    }
    if (!this.staging) {
      this.staging = manifests.filter((manifest) => manifest.status === "downloading").sort((a, b) => b.createdAt - a.createdAt)[0] || null;
      if (this.staging) await this.writeRecord("staging", this.staging);
    }
    const retained = new Set([this.active?.cacheName, this.staging?.cacheName].filter(Boolean));
    await Promise.all(bookNames.filter((name) => !retained.has(name)).map((name) => this.cacheStorage.delete(name)));
    this.progress = this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0;
    this.phase = this.staging ? "paused" : "idle";
    this.emit();
    return this.snapshot();
  }

  async inspectSource(selection, signal) {
    if (!this.supported) throw new OfflineDownloadError("unsupported", "Offline downloads are not supported.");
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to the internet before downloading.");
    const sourceUrl = new URL(selection.sourceUrl);
    if (sourceUrl.origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("cross-origin", "Offline downloads require audio from this site.");
    const response = await this.fetchImpl(sourceUrl.href, {
      method: "GET",
      headers: { Range: "bytes=0-0", [OFFLINE_DOWNLOAD_HEADER]: "1" },
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    const range = parseContentRange(response.headers.get("content-range"));
    try { await response.body?.cancel(); } catch {}
    if (response.status !== 206 || !range || range.start !== 0 || range.end !== 0) {
      throw new OfflineDownloadError("range", "The audio server does not support offline downloads.");
    }
    const stagingMatches = this.staging && manifestMatchesSelection(this.staging, selection)
      && this.staging.totalSize === range.total
      && (!this.staging.etag || !response.headers.get("etag") || this.staging.etag === response.headers.get("etag"));
    const remainingBytes = range.total - (stagingMatches ? completedBytes(this.staging) : 0);
    let quota = null;
    let usage = null;
    try {
      const estimate = await this.navigator.storage?.estimate?.();
      quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
      usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
    } catch {}
    const reserve = Math.max(16 * MEBIBYTE, Math.ceil(range.total * .05));
    return {
      totalSize: range.total,
      etag: response.headers.get("etag") || "",
      lastModified: response.headers.get("last-modified") || "",
      remainingBytes,
      availableBytes: quota != null && usage != null ? Math.max(0, quota - usage) : null,
      requiredBytes: remainingBytes + reserve,
      canResume: Boolean(stagingMatches),
    };
  }

  async requestPersistence() {
    try {
      if (!this.navigator.storage?.persist) return null;
      return await this.navigator.storage.persist();
    } catch { return false; }
  }

  async putManifest(cache, manifest) {
    await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
    this.staging = manifest;
    await this.writeRecord("staging", manifest);
  }

  async createStaging(selection, preflight) {
    if (this.staging) await this.removeStaging();
    const downloadId = createDownloadId();
    const manifest = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      status: "downloading",
      downloadId,
      cacheName: `${OFFLINE_BOOK_CACHE_PREFIX}${downloadId}`,
      episodeId: selection.episodeId,
      episodeTitle: String(selection.episodeTitle || selection.episodeId),
      languageCode: selection.languageCode,
      languageLabel: String(selection.languageLabel || selection.languageCode),
      sourceId: selection.sourceId,
      sourceLabel: String(selection.sourceLabel || selection.sourceId),
      sourceUrl: selection.sourceUrl,
      mime: selection.mime,
      assets: (selection.assets || [])
        .map((asset) => ({ url: String(asset.url || ""), required: Boolean(asset.required) }))
        .filter((asset) => {
          try { return asset.url && new URL(asset.url).origin === new URL(this.baseUrl).origin; }
          catch { return false; }
        }),
      cacheVersion: String(selection.cacheVersion),
      totalSize: preflight.totalSize,
      chunkSize: OFFLINE_CHUNK_SIZE,
      totalChunks: Math.ceil(preflight.totalSize / OFFLINE_CHUNK_SIZE),
      completed: [],
      etag: preflight.etag,
      lastModified: preflight.lastModified,
      createdAt: Date.now(),
      downloadedAt: 0,
    };
    const cache = await this.cacheStorage.open(manifest.cacheName);
    await this.putManifest(cache, manifest);
    return { cache, manifest };
  }

  async cacheAssets(cache, assets, signal) {
    for (const asset of assets || []) {
      const url = String(asset?.url || "");
      if (!url || new URL(url).origin !== new URL(this.baseUrl).origin) continue;
      try {
        const response = await this.fetchImpl(url, {
          headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" },
          cache: "no-store",
          credentials: "same-origin",
          signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(url, response);
      } catch (error) {
        if (signal.aborted || asset.required) throw error;
      }
    }
  }

  async fetchChunk(manifest, index, signal) {
    const { start, end } = chunkBounds(index, manifest.totalSize, manifest.chunkSize);
    const headers = { Range: `bytes=${start}-${end}`, [OFFLINE_DOWNLOAD_HEADER]: "1" };
    if (manifest.etag && !/^W\//i.test(manifest.etag)) headers["If-Range"] = manifest.etag;
    const response = await this.fetchImpl(manifest.sourceUrl, {
      headers,
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    const range = parseContentRange(response.headers.get("content-range"));
    if (response.status !== 206 || !range || range.start !== start || range.end !== end || range.total !== manifest.totalSize) {
      try { await response.body?.cancel(); } catch {}
      throw new OfflineDownloadError("changed", "The audio file changed during the download.");
    }
    const data = await response.arrayBuffer();
    if (data.byteLength !== end - start + 1) throw new OfflineDownloadError("incomplete", "The audio download was incomplete.");
    return new Response(data, {
      headers: {
        "content-type": manifest.mime,
        "content-length": String(data.byteLength),
        "x-compact-player-start": String(start),
        "x-compact-player-end": String(end),
      },
    });
  }

  start(selection, preflight, { waitForPriority = async () => {} } = {}) {
    if (this.currentPromise) return this.currentPromise;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.currentPromise = this.runDownload(selection, preflight, signal, waitForPriority)
      .finally(() => { this.abortController = null; this.currentPromise = null; });
    return this.currentPromise;
  }

  async runDownload(selection, preflight, signal, waitForPriority) {
    this.setPhase("preparing", 0);
    try {
      let cache;
      let manifest;
      if (preflight.canResume && this.staging && manifestMatchesSelection(this.staging, selection)) {
        manifest = this.staging;
        cache = await this.cacheStorage.open(manifest.cacheName);
      } else ({ cache, manifest } = await this.createStaging(selection, preflight));
      await this.cacheAssets(cache, selection.assets, signal);
      const completed = new Set(manifest.completed);
      this.setPhase("downloading", completedBytes(manifest) / manifest.totalSize);
      for (let index = 0; index < manifest.totalChunks; index += 1) {
        if (completed.has(index)) continue;
        await waitForPriority(signal);
        if (signal.aborted) throw new DOMException("Download canceled", "AbortError");
        const chunk = await this.fetchChunk(manifest, index, signal);
        await cache.put(offlineChunkUrl(this.baseUrl, manifest.downloadId, index), chunk);
        completed.add(index);
        manifest = { ...manifest, completed: [...completed].sort((a, b) => a - b) };
        await this.putManifest(cache, manifest);
        this.setPhase("downloading", completedBytes(manifest) / manifest.totalSize);
      }
      manifest = { ...manifest, status: "ready", downloadedAt: Date.now() };
      await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
      const oldActive = this.active;
      await this.writeRecord("active", manifest);
      this.active = manifest;
      this.staging = null;
      await this.writeRecord("staging", null);
      if (oldActive?.cacheName && oldActive.cacheName !== manifest.cacheName) await this.cacheStorage.delete(oldActive.cacheName);
      this.setPhase("ready", 1);
      return manifest;
    } catch (error) {
      this.setPhase(this.staging ? "paused" : "idle", this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0);
      if (isQuotaError(error)) throw new OfflineDownloadError("quota", "The browser does not have enough storage for this download.");
      throw error;
    }
  }

  async cancel() {
    this.abortController?.abort();
    try { await this.currentPromise; } catch {}
    await this.removeStaging();
    this.setPhase("idle", 0);
  }

  async removeStaging() {
    const staging = this.staging || await this.readRecord("staging");
    await this.writeRecord("staging", null);
    if (staging?.cacheName) await this.cacheStorage.delete(staging.cacheName);
    this.staging = null;
  }

  async removeActive() {
    const active = this.active || await this.readRecord("active");
    await this.writeRecord("active", null);
    if (active?.cacheName) await this.cacheStorage.delete(active.cacheName);
    this.active = null;
    this.phase = this.staging ? "paused" : "idle";
    this.progress = this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0;
    this.emit();
  }

  async reset() {
    if (!this.cacheStorage) return;
    this.abortController?.abort();
    try { await this.currentPromise; } catch {}
    const names = await this.cacheStorage.keys();
    await Promise.all(names.filter((name) => name.startsWith(OFFLINE_BOOK_CACHE_PREFIX)).map((name) => this.cacheStorage.delete(name)));
    await this.cacheStorage.delete(OFFLINE_META_CACHE);
    this.active = null;
    this.staging = null;
    this.setPhase("idle", 0);
  }
}
