import "./offline-manifest.js";
import { createAbortError, fetchWithRetry } from "./utils.js";
import { withOfflineLock } from "./offline-lock.js";
import { validateOfflineBookConfig } from "./book-config.js";
import { OFFLINE_CHUNK_SIZE, OfflineDownloadError, checkCanceled, chunkBounds, downloadChunks, inspectAudioRange, sameAudioRevision } from "./offline-transfer.js";
export { OFFLINE_CHUNK_SIZE, OfflineDownloadError, chunkBounds, parseContentRange } from "./offline-transfer.js";

const PREPARATION_TIMEOUT_MS = 20_000;
const MEBIBYTE = 1024 * 1024;

const {
  schemaVersion: OFFLINE_SCHEMA_VERSION, metaCache: OFFLINE_META_CACHE, downloadHeader: OFFLINE_DOWNLOAD_HEADER,
  audioMimeType, validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl,
} = globalThis.CompactPlayerOfflineManifest;
export { OFFLINE_SCHEMA_VERSION, OFFLINE_META_CACHE, OFFLINE_DOWNLOAD_HEADER, validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl };
export const OFFLINE_BOOK_CACHE_PREFIX = "compact-player-offline-book-v2-";
const LEGACY_BOOK_CACHE_PREFIX = "compact-player-offline-book-v1-";

export function completedBytes(manifest) {
  if (!validManifest(manifest)) return 0;
  return manifest.completed.reduce((total, index) => {
    const { start, end } = chunkBounds(index, manifest.totalSize, manifest.chunkSize);
    return total + Math.max(0, end - start + 1);
  }, 0);
}

export function manifestMatchesSelection(manifest, selection) {
  return validManifest(manifest) && manifest.episodeId === selection?.episodeId
    && (!manifest.configBookId || !selection.configBookId || manifest.configBookId === selection.configBookId)
    && manifest.languageCode === selection?.languageCode
    && manifest.sourceId === selection?.sourceId
    && manifest.sourceUrl === selection?.sourceUrl
    && String(manifest.cacheVersion) === String(selection?.cacheVersion);
}

function canResume(staging, selection, preflight) {
  return manifestMatchesSelection(staging, selection) && sameAudioRevision(staging, preflight);
}

function offlineConflict() {
  throw new OfflineDownloadError("conflict", "Another tab is updating or has changed the offline book.");
}

async function responseJson(response) {
  if (!response) return null;
  const text = await response.text();
  try { return JSON.parse(text); }
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

async function prepareWithTimeout(action, signal) {
  checkCanceled(signal);
  const controller = new AbortController();
  let stop;
  const interrupted = new Promise((_, reject) => {
    stop = (error) => { reject(error); controller.abort(); };
  });
  const cancel = () => stop(createAbortError("Download canceled"));
  const timer = setTimeout(() => stop(new OfflineDownloadError("timeout", "Download preparation timed out.")), PREPARATION_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([interrupted, action(controller.signal)]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export class OfflineManager {
  constructor({
    baseUrl,
    onChange = () => {},
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cacheStorage,
    navigatorObject = globalThis.navigator,
  } = {}) {
    const installation = new URL("./", baseUrl || globalThis.location?.href || "http://localhost/");
    this.baseUrl = installation.href;
    this.bookCachePrefix = `${OFFLINE_BOOK_CACHE_PREFIX}${encodeURIComponent(installation.pathname)}:`;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorObject;
    this.cacheStorage = null;
    this.supported = false;
    try {
      this.cacheStorage = cacheStorage === undefined ? globalThis.caches : cacheStorage;
      this.supported = Boolean(fetchImpl && this.cacheStorage && navigatorObject?.serviceWorker && globalThis.isSecureContext !== false);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Browser access to offline storage is blocked.", error);
    }
    this.active = null;
    this.repairable = null;
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
      repairable: this.repairable,
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
    const script = new URL("sw.js", this.baseUrl);
    let controlsPage = false;
    try {
      const workers = this.navigator.serviceWorker;
      controlsPage = workers.controller?.scriptURL === script.href;
      await withTimeout(workers.register(script, { scope: new URL(this.baseUrl).pathname }), 8000);
      await withTimeout(workers.ready, 8000);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not register the offline player.", error);
      this.supported = false;
      if (controlsPage) await this.readPublishedBook();
      this.emit();
      return this.snapshot();
    }
    return this.refresh();
  }

  async metaCache() { return this.cacheStorage.open(OFFLINE_META_CACHE); }

  configUrl(manifest) {
    return Array.isArray(manifest?.assets) && manifest.assets.find((asset) => asset?.required)?.url;
  }

  get downloadedConfig() {
    const url = this.configUrl(this.active);
    return url ? { id: this.active.episodeId, url } : null;
  }

  async ownsBookCache(name) {
    if (typeof name !== "string") return false;
    if (name.startsWith(this.bookCachePrefix)) return true;
    if (!name.startsWith(LEGACY_BOOK_CACHE_PREFIX)) return false;
    // Legacy names contain only a download ID. The manifest URL identifies the installation.
    return Boolean(await this.cacheStorage.match(offlineManifestUrl(this.baseUrl), { cacheName: name }));
  }

  async ownedBookCacheNames() {
    const owned = [];
    for (const name of await this.cacheStorage.keys()) {
      if (await this.ownsBookCache(name)) owned.push(name);
    }
    return owned;
  }

  async deleteOwnedBookCache(name) {
    if (await this.ownsBookCache(name)) await this.cacheStorage.delete(name);
  }

  async readRecord(type, includeUnpublished = false) {
    const response = await this.cacheStorage.match(offlineMetaUrl(this.baseUrl, type), { cacheName: OFFLINE_META_CACHE });
    const record = await responseJson(response);
    if (type === "active" && includeUnpublished) {
      const saved = record?.manifest;
      if (saved?.status === "removed" && typeof saved.downloadId === "string" && saved.downloadId) return saved;
      if (saved?.status === "needs-config" && saved.cacheName === record.cacheName
        && validManifest({ ...saved, status: "ready" }, "ready")) return saved;
    }
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
    const cache = await this.cacheStorage.open(cacheName);
    let manifest = await responseJson(await cache.match(offlineManifestUrl(this.baseUrl)));
    if (!validManifest(manifest) || manifest.cacheName !== cacheName) return null;
    const present = await Promise.all(manifest.completed.map(async (index) => Boolean(await cache.match(offlineChunkUrl(this.baseUrl, manifest.downloadId, index)))));
    if (manifest.status === "ready" && present.some((exists) => !exists)) return null;
    if (manifest.status === "downloading" && present.some((exists) => !exists)) {
      manifest = { ...manifest, completed: manifest.completed.filter((_index, position) => present[position]) };
      await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
    }
    if (manifest.status === "ready") {
      try { await this.verifyCachedConfig(manifest); }
      catch (error) {
        if (error.code !== "config") throw error;
        return { ...manifest, status: "needs-config" };
      }
    }
    return manifest;
  }

  withLock(action, whenBusy) {
    return withOfflineLock(this.navigator, `compact-player-offline:${this.baseUrl}`, action, whenBusy);
  }

  async readRecords() {
    const saved = await this.readRecord("active", true);
    this.active = saved?.status === "ready" ? saved : null;
    this.repairable = saved?.status === "needs-config" ? saved : null;
    this.staging = await this.readRecord("staging");
    if (this.staging?.downloadId === saved?.downloadId) this.staging = null;
    return saved;
  }

  recordIds() {
    return { activeId: this.active?.downloadId, repairableId: this.repairable?.downloadId, stagingId: this.staging?.downloadId };
  }

  updateIfCurrent(expected, action) {
    return this.withLock(async () => {
      await this.readRecords();
      if (this.active?.downloadId !== expected.activeId || this.repairable?.downloadId !== expected.repairableId
        || this.staging?.downloadId !== expected.stagingId) {
        this.emit();
        return offlineConflict();
      }
      return action();
    }, offlineConflict);
  }

  async checkPublishedConfig() {
    if (!this.active) return;
    try { await this.verifyCachedConfig(this.active); }
    catch (error) {
      if (error.code === "config") this.active = null;
      else console.warn("[CompactAudioPlayer] Could not read the published book configuration.", error);
    }
  }

  async readPublishedBook() {
    try { this.active = await this.readRecord("active"); await this.checkPublishedConfig(); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not read the published offline book.", error); }
  }

  async refresh() {
    if (!this.supported || this.currentPromise) return this.snapshot();
    try {
      return await this.withLock(() => this.refreshLocked(), async () => {
        await this.readRecords();
        await this.checkPublishedConfig();
        this.emit();
        return this.snapshot();
      });
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not update offline storage. Reading the published book.", error);
      this.supported = false;
      await this.readPublishedBook();
      this.emit();
      return this.snapshot();
    }
  }

  async refreshLocked() {
    let bookNames, manifests, saved;
    try {
      saved = await this.readRecords();
      bookNames = await this.ownedBookCacheNames();
      manifests = (await Promise.all(bookNames.map((name) => this.readBookManifest(name)))).filter(Boolean);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not verify offline downloads. Cleanup skipped.", error);
      if (error?.name === "SecurityError" || error?.name === "NotAllowedError") this.supported = false;
      this.emit();
      return this.snapshot();
    }
    // After an explicit removal only a later staging download can become the saved book.
    if (saved?.status === "removed") manifests = manifests.filter((manifest) =>
      manifest.status === "downloading" || manifest.downloadId === this.staging?.downloadId);
    const newest = (status, published, by) => {
      const candidates = manifests.filter((manifest) => manifest.status === status);
      return candidates.find((manifest) => manifest.cacheName === published?.cacheName)
        || candidates.sort((a, b) => b[by] - a[by])[0] || null;
    };
    const damaged = newest("needs-config", saved, "downloadedAt");
    const publishedNeedsConfig = damaged && damaged.cacheName === saved?.cacheName;
    const active = publishedNeedsConfig ? null : newest("ready", saved, "downloadedAt");
    const staging = newest("downloading", this.staging, "createdAt");
    if (this.active || this.repairable || active || damaged) await this.writeRecord("active", active || damaged);
    if (this.staging || staging) await this.writeRecord("staging", staging);
    this.active = active;
    this.repairable = active ? null : damaged;
    this.staging = staging;
    const retained = new Set([active?.cacheName, staging?.cacheName, this.repairable?.cacheName]);
    try {
      if (active && !staging) await this.writeRecord("staging", null);
      for (const name of bookNames) {
        if (!retained.has(name)) await this.cacheStorage.delete(name);
      }
      if (saved?.status === "removed" && !active && !damaged) await this.writeRecord("active", null);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not finish offline cleanup. The next visit will retry.", error);
    }
    this.progress = this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0;
    this.phase = this.staging ? "paused" : "idle";
    this.emit();
    return this.snapshot();
  }

  inspectSource(selection, signal) {
    return prepareWithTimeout((boundedSignal) => this.inspectRange(selection, boundedSignal), signal);
  }

  async inspectRange(selection, signal) {
    if (!this.supported) throw new OfflineDownloadError("unsupported", "Offline downloads are not supported.");
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to the internet before downloading.");
    const sourceUrl = new URL(selection.sourceUrl);
    if (sourceUrl.origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("cross-origin", "Offline downloads require audio from this site.");
    const { mime, ...representation } = await inspectAudioRange(this.fetchImpl, sourceUrl.href, selection.mime, signal);
    const stagingMatches = canResume(this.staging, selection, representation);
    const remainingBytes = representation.totalSize - (stagingMatches ? completedBytes(this.staging) : 0);
    let quota = null;
    let usage = null;
    try {
      const estimate = await this.navigator.storage?.estimate?.();
      quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
      usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
    } catch {}
    const reserve = Math.max(16 * MEBIBYTE, Math.ceil(representation.totalSize * .05));
    return {
      ...representation,
      mime,
      ...this.recordIds(),
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
    const downloadId = createDownloadId();
    const manifest = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      status: "downloading",
      downloadId,
      cacheName: `${this.bookCachePrefix}${downloadId}`,
      episodeId: selection.episodeId,
      configBookId: selection.configBookId || selection.episodeId,
      episodeTitle: String(selection.episodeTitle || selection.episodeId),
      languageCode: selection.languageCode,
      languageLabel: String(selection.languageLabel || selection.languageCode),
      sourceId: selection.sourceId,
      sourceLabel: String(selection.sourceLabel || selection.sourceId),
      sourceUrl: selection.sourceUrl,
      mime: audioMimeType(preflight.mime ?? selection.mime),
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
      responseDate: preflight.responseDate,
      createdAt: Date.now(),
      downloadedAt: 0,
    };
    if (!validManifest(manifest, "downloading")) throw new OfflineDownloadError("manifest", "Invalid offline download manifest.");
    if (this.staging) await this.removeStagingLocked();
    const cache = await this.cacheStorage.open(manifest.cacheName);
    await this.putManifest(cache, manifest);
    return { cache, manifest };
  }

  async cacheAssets(cache, assets, signal) {
    for (const asset of assets || []) {
      const url = String(asset?.url || "");
      if (!url || new URL(url).origin !== new URL(this.baseUrl).origin) continue;
      try {
        await fetchWithRetry(url, {
          fetchImpl: this.fetchImpl, retries: 1, timeoutMs: PREPARATION_TIMEOUT_MS,
          headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" },
          cache: "no-store",
          credentials: "same-origin",
          signal,
        }, async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await cache.put(url, response);
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (asset.required) {
          if (error.name === "AbortError") throw new OfflineDownloadError("timeout", "The book configuration request timed out.");
          throw error;
        }
      }
    }
  }

  async verifyCachedConfig(manifest, requiredUrl) {
    const url = this.configUrl(manifest);
    if (requiredUrl && url !== requiredUrl) throw new OfflineDownloadError("config", "The manifest lost the required book configuration.");
    if (!url) return;
    const response = await this.cacheStorage.match(url, { cacheName: manifest.cacheName });
    if (!response?.ok) throw new OfflineDownloadError("config", "The downloaded book configuration is missing.");
    const text = await response.text();
    try { validateOfflineBookConfig(text, url, this.baseUrl, manifest); }
    catch (error) { throw new OfflineDownloadError("config", error.message); }
  }

  runOperation(action) {
    if (this.currentPromise) return this.currentPromise;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.currentPromise = Promise.resolve().then(() => action(signal)).finally(() => {
      this.abortController = null;
      this.currentPromise = null;
      if (this.phase === "preparing" || this.phase === "finalizing") this.setPhase(this.staging ? "paused" : "idle", this.progress);
    });
    this.setPhase("preparing", this.progress);
    return this.currentPromise;
  }

  start(selection, preflight, { waitForPriority = async () => {}, confirmDownload = () => true, onPersistence } = {}) {
    return this.runOperation(async (signal) => {
      const expected = this.recordIds();
      try {
        const check = preflight || await this.inspectSource(selection, signal);
        checkCanceled(signal);
        if (!confirmDownload(check)) return null;
        if (check.availableBytes != null && check.availableBytes < check.requiredBytes) {
          throw new OfflineDownloadError("quota", "Insufficient browser storage.");
        }
        if (!preflight) {
          const granted = await prepareWithTimeout(() => this.requestPersistence(), signal);
          onPersistence?.(granted);
        }
        return await this.updateIfCurrent(check, () => {
          checkCanceled(signal);
          return this.runDownload(selection, check, signal, waitForPriority);
        });
      } catch (error) {
        if (signal.aborted && expected.stagingId && this.staging?.downloadId === expected.stagingId) {
          await this.updateIfCurrent(expected, () => this.removeStagingLocked());
        }
        throw error;
      }
    });
  }

  repairConfig() {
    const candidate = this.repairable;
    const expected = this.recordIds();
    return this.runOperation((signal) => this.updateIfCurrent(expected, async () => {
      if (!candidate || this.active || !(await this.ownedBookCacheNames()).includes(candidate.cacheName)) {
        throw new OfflineDownloadError("conflict", "The saved download has changed.");
      }
      const cache = await this.cacheStorage.open(candidate.cacheName);
      const url = this.configUrl(candidate);
      if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("config", "The saved configuration URL belongs to another site.");
      const text = await prepareWithTimeout(async (requestSignal) => {
        const result = await this.fetchImpl(url, { cache: "no-store", credentials: "same-origin",
          headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" }, signal: requestSignal });
        if (!result.ok) throw new OfflineDownloadError("config", "Could not retrieve the saved book configuration.");
        return result.text();
      }, signal);
      validateOfflineBookConfig(text, url, this.baseUrl, candidate);
      checkCanceled(signal);
      await cache.put(url, new Response(text, { headers: { "content-type": "application/json" } }));
      const ready = await this.readBookManifest(candidate.cacheName);
      if (!validManifest(ready, "ready") || ready.downloadId !== candidate.downloadId) {
        throw new OfflineDownloadError("incomplete", "The saved audio is incomplete.");
      }
      checkCanceled(signal);
      this.setPhase("finalizing", 1);
      await this.publish(ready);
      return ready;
    }));
  }

  async publish(manifest) {
    const previous = this.active || this.repairable;
    await this.writeRecord("active", manifest);
    this.active = manifest;
    this.repairable = null;
    if (this.staging?.downloadId === manifest.downloadId) this.staging = null;
    try {
      if (!this.staging) await this.writeRecord("staging", null);
      if (previous && previous.cacheName !== manifest.cacheName) await this.deleteOwnedBookCache(previous.cacheName);
    } catch (error) {
      console.warn("[CompactAudioPlayer] The download is ready. Cleanup will retry on the next visit.", error);
    }
    this.setPhase("ready", 1);
  }

  async runDownload(selection, preflight, signal, waitForPriority) {
    this.setPhase("preparing", 0);
    try {
      let cache;
      let manifest;
      if (preflight.canResume && canResume(this.staging, selection, preflight)) {
        manifest = this.staging;
        cache = await this.cacheStorage.open(manifest.cacheName);
      } else ({ cache, manifest } = await this.createStaging(selection, preflight));
      const config = selection.assets?.find((asset) => asset.required);
      if (config && !manifest.configBookId) {
        // Older partial downloads only recorded the catalog ID, which can be an alias.
        const previous = await responseJson(await cache.match(config.url));
        manifest = { ...manifest, configBookId: selection.configBookId || String(previous?.id || "").trim() || selection.episodeId };
        await this.putManifest(cache, manifest);
      }
      await this.cacheAssets(cache, selection.assets, signal);
      await this.verifyCachedConfig(manifest, config?.url);
      const completed = new Set(manifest.completed);
      this.setPhase("downloading", completedBytes(manifest) / manifest.totalSize);
      for await (const { index, chunk } of downloadChunks(this.fetchImpl, manifest, signal, waitForPriority)) {
        await cache.put(offlineChunkUrl(this.baseUrl, manifest.downloadId, index), chunk);
        completed.add(index);
        manifest = { ...manifest, completed: [...completed].sort((a, b) => a - b) };
        await this.putManifest(cache, manifest);
        this.setPhase("downloading", completedBytes(manifest) / manifest.totalSize);
      }
      const stored = await this.readBookManifest(manifest.cacheName);
      checkCanceled(signal);
      if (!manifestMatchesSelection(stored, selection) || stored.status !== "downloading" || stored.downloadId !== manifest.downloadId) {
        await this.removeStagingLocked();
        throw new OfflineDownloadError("manifest", "Invalid completed download manifest.");
      }
      manifest = { ...stored, status: "ready", mime: audioMimeType(stored.mime), downloadedAt: Date.now() };
      if (!validManifest(manifest, "ready")) {
        await this.putManifest(cache, stored);
        throw new OfflineDownloadError("incomplete", "A downloaded audio chunk is missing.");
      }
      await this.verifyCachedConfig(manifest, config?.url);
      checkCanceled(signal);
      this.setPhase("finalizing", 1);
      await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
      await this.publish(manifest);
      return manifest;
    } catch (error) {
      if (signal.aborted && this.phase !== "finalizing") {
        await this.removeStagingLocked();
        this.setPhase("idle", 0);
        throw new DOMException("Download canceled", "AbortError");
      }
      this.setPhase(this.staging ? "paused" : "idle", this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0);
      if (isQuotaError(error)) throw new OfflineDownloadError("quota", "The browser does not have enough storage for this download.");
      throw error;
    }
  }

  async cancel() {
    if (this.currentPromise) {
      if (this.phase !== "finalizing") this.abortController.abort();
      try { await this.currentPromise; }
      catch (error) { if (error?.name !== "AbortError") throw error; }
      return;
    }
    if (!this.staging) return;
    await this.updateIfCurrent(this.recordIds(), async () => {
      await this.removeStagingLocked();
      this.setPhase("idle", 0);
    });
  }

  async removeStagingLocked() {
    const staging = this.staging;
    await this.writeRecord("staging", null);
    await this.deleteOwnedBookCache(staging?.cacheName);
    this.staging = null;
  }

  async removeActive() {
    await this.updateIfCurrent(this.recordIds(), async () => {
      const saved = this.active || this.repairable;
      if (!saved) return;
      await this.writeRecord("active", { status: "removed", downloadId: saved.downloadId });
      await this.deleteOwnedBookCache(saved.cacheName);
      this.active = null;
      this.repairable = null;
      this.setPhase(this.staging ? "paused" : "idle", this.staging ? completedBytes(this.staging) / this.staging.totalSize : 0);
    });
  }

  async reset() {
    this.cacheStorage ??= globalThis.caches;
    if (!this.cacheStorage) return;
    this.abortController?.abort();
    try { await this.currentPromise; } catch {}
    await this.withLock(async () => {
      const names = await this.ownedBookCacheNames();
      for (const name of names) await this.cacheStorage.delete(name);
      await this.writeRecord("active", null);
      await this.writeRecord("staging", null);
      this.active = null;
      this.repairable = null;
      this.staging = null;
      this.setPhase("idle", 0);
    }, offlineConflict);
  }
}
