import "./offline-manifest.js";
import { createAbortError, fetchWithRetry } from "./utils.js";
import { OfflineBookStore, canResumeTransfer, hasAllChunks, isQuotaError, sameOfflineSelection } from "./offline-book-store.js";
import { withOfflineLock } from "./offline-lock.js";
import { OfflineDownloadError, checkCanceled, downloadChunks, inspectAudioRange } from "./offline-transfer.js";
export { OFFLINE_CHUNK_SIZE, OfflineDownloadError, chunkBounds, parseContentRange } from "./offline-transfer.js";

const PREPARATION_TIMEOUT_MS = 20_000;
const MEBIBYTE = 1024 * 1024;

const {
  schemaVersion: OFFLINE_SCHEMA_VERSION, metaCache: OFFLINE_META_CACHE, downloadHeader: OFFLINE_DOWNLOAD_HEADER,
  validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, chunkByteLength,
} = globalThis.CompactPlayerOfflineManifest;
export { OFFLINE_SCHEMA_VERSION, OFFLINE_META_CACHE, OFFLINE_DOWNLOAD_HEADER, validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl };
export { OFFLINE_BOOK_CACHE_PREFIX, sameOfflineSelection, manifestMatchesSelection } from "./offline-book-store.js";

export function completedBytes(manifest) {
  if (!validManifest(manifest)) return 0;
  return manifest.completed.reduce((total, index) => total + chunkByteLength(manifest, index), 0);
}

function offlineConflict() {
  throw new OfflineDownloadError("conflict", "Another tab is updating or has changed the offline book.");
}

function isAccessDenied(error) {
  return error?.name === "SecurityError" || error?.name === "NotAllowedError";
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
    getCacheStorage = () => cacheStorage === undefined ? globalThis.caches : cacheStorage,
    navigatorObject = globalThis.navigator,
  } = {}) {
    const installation = new URL("./", baseUrl || globalThis.location?.href || "http://localhost/");
    this.baseUrl = installation.href;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorObject;
    this.getCacheStorage = getCacheStorage;
    this.store = new OfflineBookStore(this.baseUrl, null);
    this.supported = false;
    try {
      this.store.cacheStorage = this.getCacheStorage();
      this.supported = Boolean(fetchImpl && this.cacheStorage && navigatorObject?.serviceWorker && globalThis.isSecureContext !== false);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Browser access to offline storage is blocked.", error);
    }
    this.active = null;
    this.repairable = null;
    this.staging = null;
    this.stagingCheck = null;
    this.phase = "idle";
    this.abortController = null;
    this.currentPromise = null;
  }

  get cacheStorage() { return this.store.cacheStorage; }

  get busy() { return ["preparing", "downloading", "finalizing", "publishing-repair"].includes(this.phase); }
  get canCancel() {
    return this.busy ? this.phase === "preparing" || this.phase === "downloading" : Boolean(this.staging);
  }

  get progress() {
    if (this.staging) return completedBytes(this.staging) / this.staging.totalSize;
    return this.phase === "ready" ? 1 : 0;
  }

  snapshot() {
    const stagingStatus = this.staging && this.staging.downloadId === this.stagingCheck?.downloadId
      ? this.stagingCheck.status : "downloading";
    return {
      supported: this.supported,
      active: this.active,
      repairable: this.repairable,
      staging: this.staging,
      phase: this.phase,
      busy: this.busy,
      canCancel: this.canCancel,
      stagingStatus,
      canFinishOffline: stagingStatus === "ready",
      progress: this.progress,
    };
  }

  emit() { this.onChange(this.snapshot()); }

  setPhase(phase) {
    this.phase = phase;
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

  metaCache() { return this.store.metaCache(); }
  readRecord(type, includeUnpublished) { return this.store.readRecord(type, includeUnpublished); }
  writeRecord(type, manifest) { return this.store.writeRecord(type, manifest); }

  get downloadedConfig() {
    const url = this.store.configUrl(this.active);
    return url ? { id: this.active.episodeId, url } : null;
  }

  withLock(action, whenBusy) {
    return withOfflineLock(this.navigator, `compact-player-offline:${this.baseUrl}`, action, whenBusy);
  }

  setPublishedBook(saved) {
    this.active = saved?.status === "ready" ? saved : null;
    this.repairable = ["needs-config", "needs-audio"].includes(saved?.status) ? saved : null;
  }

  async readRecords(includeUnpublishedStaging = false) {
    const saved = await this.readRecord("active", true);
    this.setPublishedBook(saved);
    this.staging = await this.readRecord("staging", includeUnpublishedStaging);
    if (this.staging?.downloadId === saved?.downloadId) this.staging = null;
    return saved;
  }

  recordIds() {
    return { activeId: this.active?.downloadId, repairableId: this.repairable?.downloadId, stagingId: this.staging?.downloadId };
  }

  updateIfCurrent(expected, action) {
    return this.withLock(async () => {
      await this.readRecords();
      if (expected.repairableId && this.active?.downloadId === expected.repairableId) await this.checkPublishedConfig();
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
    try { this.setPublishedBook(await this.store.checkReadyConfig(this.active)); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not read the published book configuration.", error); }
  }

  async readPublishedBook() {
    try {
      this.setPublishedBook(await this.readRecord("active", true));
      await this.checkPublishedConfig();
    } catch (error) { console.warn("[CompactAudioPlayer] Could not read the published offline book.", error); }
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
      console.warn("[CompactAudioPlayer] Could not access the offline lock. Reading the published book.", error);
      this.supported = false;
      await this.readPublishedBook();
      this.emit();
      return this.snapshot();
    }
  }

  async refreshLocked() {
    try {
      const saved = await this.readRecords(true);
      const inventory = await this.store.inspectDownloads(saved, this.staging);
      await this.reconcileDownloads(saved, inventory);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not reconcile offline downloads. Reading the published book.", error);
      if (isAccessDenied(error)) this.supported = false;
      await this.readPublishedBook();
      this.emit();
    }
    return this.snapshot();
  }

  async reconcileDownloads(saved, { bookNames, active, staging, damaged, completion }) {
    this.stagingCheck = completion;
    const candidate = completion?.status === "ready" ? completion : active;
    if (staging && staging.downloadId !== candidate?.downloadId) await this.store.reconcileRecord("staging", this.staging, staging);
    this.staging = staging;
    if (candidate && candidate.downloadId !== this.active?.downloadId) {
      return this.publish(candidate, bookNames);
    }
    await this.store.reconcileRecord("active", this.active || this.repairable, active || damaged);
    this.setPublishedBook(active || damaged);
    await this.cleanup(bookNames, saved?.status === "removed" && !active && !damaged);
    this.setPhase(this.staging ? "paused" : "idle");
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
    return { ...representation, mime, ...this.recordIds(), ...await this.downloadSpace(selection, representation) };
  }

  async downloadSpace(selection, representation) {
    const stagingMatches = canResumeTransfer(this.staging, selection, representation);
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

  async checkSpaceBeforeWrite(selection, check, signal) {
    const space = await prepareWithTimeout(() => this.downloadSpace(selection, check), signal);
    const current = { ...check, ...space, availableBytes: space.availableBytes ?? check.availableBytes };
    if (current.availableBytes == null || current.availableBytes >= current.requiredBytes) return current;
    const deficit = current.requiredBytes - current.availableBytes;
    const staged = this.staging;
    const replacing = !current.canResume && staged && staged.cacheName !== (this.active || this.repairable)?.cacheName;
    const fits = replacing && completedBytes(staged) >= deficit && await this.store.canReclaimBytes(staged, deficit, signal);
    checkCanceled(signal);
    if (!fits) throw new OfflineDownloadError("quota", "Insufficient browser storage.");
    return current;
  }

  async putManifest(files, manifest) {
    await files.writeManifest(manifest);
    this.staging = manifest;
    await this.writeRecord("staging", manifest);
  }

  async createStaging(selection, preflight) {
    const manifest = this.store.stagingManifest(selection, preflight);
    if (this.staging) await this.removeStagingLocked();
    const files = await this.store.openStagingFiles(manifest);
    await this.putManifest(files, manifest);
    return { files, manifest };
  }

  async cacheSupportingAssets(files, assets, configUrl, signal) {
    for (const asset of assets || []) {
      const url = String(asset?.url || "");
      if (!url || url === configUrl || new URL(url).origin !== new URL(this.baseUrl).origin) continue;
      try {
        await fetchWithRetry(url, {
          fetchImpl: this.fetchImpl, retries: 1, timeoutMs: PREPARATION_TIMEOUT_MS,
          headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" },
          cache: "no-store",
          credentials: "same-origin",
          signal,
        }, async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await files.writeAsset(url, response);
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

  runOperation(action) {
    if (this.currentPromise) return this.currentPromise;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    this.currentPromise = Promise.resolve().then(() => action(signal)).finally(() => {
      this.abortController = null;
      this.currentPromise = null;
      if (["preparing", "finalizing", "publishing-repair"].includes(this.phase)) this.setPhase(this.staging ? "paused" : "idle");
    });
    this.setPhase("preparing");
    return this.currentPromise;
  }

  async checkStaging(staging, selection) {
    this.stagingCheck = null;
    this.stagingCheck = await this.store.checkCompletion(staging, selection);
    return this.stagingCheck;
  }

  resume(options) {
    if (!this.staging) return Promise.resolve(null);
    return this.start(this.staging, undefined, options);
  }

  start(selection, preflight, { waitForPriority = async () => {}, confirmDownload = () => true, onPersistence } = {}) {
    return this.runOperation(async (signal) => {
      const expected = preflight || this.recordIds();
      try {
        if (hasAllChunks(this.staging) && sameOfflineSelection(this.staging, selection)) {
          const ready = await this.updateIfCurrent(expected, () => this.finishStaging(selection, expected, confirmDownload, signal));
          if (ready !== undefined) return ready;
        }
        const check = preflight || await this.inspectSource(selection, signal);
        checkCanceled(signal);
        if (!confirmDownload(check, selection)) return null;
        if (!preflight) {
          const granted = await prepareWithTimeout(() => this.requestPersistence(), signal);
          onPersistence?.(granted);
        }
        return await this.updateIfCurrent(check, async () => {
          const current = await this.checkSpaceBeforeWrite(selection, check, signal);
          checkCanceled(signal);
          return this.runDownload(selection, current, signal, waitForPriority);
        });
      } catch (error) {
        if (signal.aborted && expected.stagingId && this.staging?.downloadId === expected.stagingId) {
          await this.updateIfCurrent(expected, () => this.removeStagingLocked());
        }
        throw error;
      }
    });
  }

  async finishStaging(selection, expected, confirmDownload, signal) {
    let stored = await this.checkStaging(this.staging, selection);
    checkCanceled(signal);
    if (!stored || stored.status === "downloading") {
      if (stored) this.staging = stored;
      return;
    }
    const check = { ...expected, totalSize: stored.totalSize, remainingBytes: 0, requiredBytes: 0, canResume: true };
    if (!confirmDownload(check, selection)) return null;
    if (stored.status === "needs-config") {
      await this.restoreConfig(stored, signal);
      stored = await this.checkStaging(this.staging, selection);
      if (stored?.status !== "ready") throw new OfflineDownloadError("incomplete", "The saved book is incomplete.");
      checkCanceled(signal);
    }
    this.setPhase("finalizing");
    await this.publish(stored);
    return stored;
  }

  async restoreConfig(candidate, signal) {
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to restore the book configuration.");
    const url = this.store.configUrl(candidate);
    if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("config", "The saved configuration URL belongs to another site.");
    const text = await prepareWithTimeout(async (requestSignal) => {
      const result = await this.fetchImpl(url, { cache: "no-store", credentials: "same-origin",
        headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" }, signal: requestSignal });
      if (!result.ok) throw new OfflineDownloadError("config", "Could not retrieve the saved book configuration.");
      return result.text();
    }, signal);
    checkCanceled(signal);
    return this.store.saveConfig(candidate, url, text);
  }

  async prepareBookAssets(files, manifest, selection, signal) {
    const url = this.store.checkConfigUrl(manifest, this.store.configUrl(selection));
    if (url) {
      const expected = { ...manifest, configBookId: manifest.configBookId || selection.configBookId };
      const id = await this.store.cachedConfigId(expected, url) || await this.restoreConfig(expected, signal);
      if (!manifest.configBookId) {
        // Legacy downloads may record the catalog alias without the ID inside the configuration.
        manifest = { ...manifest, configBookId: id };
        await this.putManifest(files, manifest);
      }
    }
    await this.cacheSupportingAssets(files, selection.assets, url, signal);
    return manifest;
  }

  repairConfig() {
    const candidate = this.repairable;
    const expected = this.recordIds();
    return this.runOperation((signal) => this.updateIfCurrent(expected, async () => {
      if (candidate?.status !== "needs-config" || this.active || !(await this.store.ownedBookCacheNames()).includes(candidate.cacheName)) {
        throw new OfflineDownloadError("conflict", "The saved download has changed.");
      }
      await this.restoreConfig(candidate, signal);
      const ready = await this.store.readBookManifest(candidate.cacheName, candidate);
      if (!validManifest(ready, "ready") || ready.downloadId !== candidate.downloadId) {
        throw new OfflineDownloadError("incomplete", "The saved audio is incomplete.");
      }
      checkCanceled(signal);
      this.setPhase("publishing-repair");
      await this.publish(ready);
      return ready;
    }));
  }

  async publish(manifest, bookNames = [(this.active || this.repairable)?.cacheName]) {
    await this.store.publish(manifest);
    this.active = manifest;
    this.repairable = null;
    if (this.staging?.downloadId === manifest.downloadId) this.staging = null;
    await this.cleanup(bookNames);
    this.setPhase(this.staging ? "paused" : "ready");
  }

  async cleanup(bookNames, clearRemovalRecord = false) {
    const retained = new Set([this.active?.cacheName, this.staging?.cacheName, this.repairable?.cacheName]);
    try {
      if (!this.staging) await this.writeRecord("staging", null);
      for (const name of bookNames) {
        if (name && !retained.has(name)) await this.store.deleteOwnedBookCache(name);
      }
      if (clearRemovalRecord) await this.writeRecord("active", null);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not finish offline cleanup. The next visit will retry.", error);
    }
  }

  async runDownload(selection, preflight, signal, waitForPriority) {
    this.setPhase("preparing");
    try {
      let files;
      let manifest;
      if (preflight.canResume && canResumeTransfer(this.staging, selection, preflight)) {
        manifest = this.staging;
        files = await this.store.openStagingFiles(manifest);
      } else ({ files, manifest } = await this.createStaging(selection, preflight));
      manifest = await this.prepareBookAssets(files, manifest, selection, signal);
      const completed = new Set(manifest.completed);
      this.setPhase("downloading");
      for await (const { index, chunk } of downloadChunks(this.fetchImpl, manifest, signal, waitForPriority)) {
        await files.writeChunk(index, chunk);
        completed.add(index);
        manifest = { ...manifest, completed: [...completed].sort((a, b) => a - b) };
        await this.putManifest(files, manifest);
        this.setPhase("downloading");
      }
      manifest = await this.checkStaging(manifest, selection);
      checkCanceled(signal);
      if (!manifest) {
        await this.removeStagingLocked();
        throw new OfflineDownloadError("manifest", "Invalid completed download manifest.");
      }
      if (manifest.status === "needs-config") throw new OfflineDownloadError("config", "The saved book configuration is missing or invalid.");
      if (manifest.status !== "ready") {
        this.staging = manifest;
        throw new OfflineDownloadError("incomplete", "A downloaded audio chunk is missing.");
      }
      this.setPhase("finalizing");
      await this.publish(manifest);
      return manifest;
    } catch (error) {
      if (signal.aborted && this.phase !== "finalizing") {
        await this.removeStagingLocked();
        this.setPhase("idle");
        throw new DOMException("Download canceled", "AbortError");
      }
      this.setPhase(this.staging ? "paused" : "idle");
      if (isQuotaError(error)) throw new OfflineDownloadError("quota", "The browser does not have enough storage for this download.");
      throw error;
    }
  }

  async cancel() {
    if (this.currentPromise) {
      if (this.canCancel) this.abortController.abort();
      try { await this.currentPromise; }
      catch (error) { if (error?.name !== "AbortError") throw error; }
    } else if (this.staging) {
      await this.updateIfCurrent(this.recordIds(), async () => {
        await this.removeStagingLocked();
        this.setPhase("idle");
      });
    }
    if (!this.staging && this.repairable?.status === "needs-audio") await this.refresh();
  }

  async removeStagingLocked() {
    this.stagingCheck = null;
    try {
      await this.store.removeStaging(this.staging);
      this.staging = null;
    } catch (error) {
      // The cancellation may already be durable even if its last cleanup step failed.
      this.staging = await this.readRecord("staging");
      throw error;
    }
  }

  async removeActive() {
    await this.updateIfCurrent(this.recordIds(), async () => {
      const saved = this.active || this.repairable;
      if (!saved) return;
      await this.store.removePublishedBook(saved, this.staging);
      this.setPublishedBook(null);
      this.setPhase(this.staging ? "paused" : "idle");
    });
  }

  async reset() {
    this.store.cacheStorage ??= this.getCacheStorage();
    if (!this.cacheStorage) return;
    this.abortController?.abort();
    try { await this.currentPromise; } catch {}
    await this.withLock(async () => {
      await this.store.clearDownloads();
      this.active = null;
      this.repairable = null;
      this.staging = null;
      this.setPhase("idle");
    }, offlineConflict);
  }
}
