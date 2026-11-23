import "./offline-manifest.js?v=20";
import { readBookConfigText } from "./config.js?v=20";
import { createAbortError, fetchWithRetry } from "./utils.js?v=20";
import { OfflineBookStore, canResumeTransfer, hasAllChunks, isQuotaError, sameOfflineSelection } from "./offline-book-store.js?v=20";
import { withOfflineLock } from "./offline-lock.js?v=20";
import { OfflineDownloadError, checkCanceled, downloadChunks, inspectAudioRange, withOfflineDeadline as prepareWithTimeout } from "./offline-transfer.js?v=20";
import { PlayerWorker, PlayerWorkerSetupTimeout } from "./player-worker.js?v=20";
export { OFFLINE_CHUNK_SIZE, OfflineDownloadError, chunkBounds, parseContentRange } from "./offline-transfer.js?v=20";

const PREPARATION_TIMEOUT_MS = 20_000;
const OPTIONAL_ASSET_TIMEOUT_MS = 3000;
const STORAGE_ESTIMATE_TIMEOUT_MS = 750;
const STAGING_WRITE_TIMEOUT_MS = 20_000;
const PUBLISHED_STARTUP_TIMEOUT_MS = 3000;
const PUBLISHED_SYNC_TIMEOUT_MS = 3000;
const INVENTORY_SCAN_TIMEOUT_MS = 20_000;
const INVENTORY_LOCK_TIMEOUT_MS = 3000;
const DAMAGE_LOCK_RETRY_MS = 3000;
const DAMAGE_LOCK_MAX_RETRY_MS = 30_000;
const INVENTORY_CHECK_TIMEOUT_MS = 3000;
const RESET_CLEANUP_TIMEOUT_MS = 3000;
const BOOK_CLEANUP_TIMEOUT_MS = 3000;
const MEBIBYTE = 1024 * 1024;
const PUBLISHED_DOWNLOAD_CHANGED = "published-download-changed";

const {
  schemaVersion: OFFLINE_SCHEMA_VERSION, metaCache: OFFLINE_META_CACHE, downloadHeader: OFFLINE_DOWNLOAD_HEADER,
  validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, chunkByteLength,
} = globalThis.CompactPlayerOfflineManifest;
export { OFFLINE_SCHEMA_VERSION, OFFLINE_META_CACHE, OFFLINE_DOWNLOAD_HEADER, validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl };
export { OFFLINE_BOOK_CACHE_PREFIX, sameOfflineSelection, manifestMatchesSelection } from "./offline-book-store.js?v=20";

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

function writeStagingData(write, signal) {
  return prepareWithTimeout(write, signal, STAGING_WRITE_TIMEOUT_MS,
    new OfflineDownloadError("storage-timeout", "Saving the download files timed out."));
}

export class OfflineManager {
  constructor({
    baseUrl,
    onChange = () => {},
    fetchImpl = globalThis.fetch?.bind(globalThis),
    cacheStorage,
    getCacheStorage = () => cacheStorage === undefined ? globalThis.caches : cacheStorage,
    navigatorObject = globalThis.navigator,
    workerScriptName,
    workerReleaseSequence,
  } = {}) {
    const installation = new URL("./", baseUrl || globalThis.location?.href || "http://localhost/");
    this.baseUrl = installation.href;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorObject;
    this.worker = new PlayerWorker({
      baseUrl: this.baseUrl, navigatorObject, fetchImpl, scriptName: workerScriptName, releaseSequence: workerReleaseSequence,
    });
    this.workerSetupTimedOut = false;
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
    this.pendingDamage = false;
    this.damageCheck = null;
    this.damageRetryTimer = null;
    this.damageRetryDelay = DAMAGE_LOCK_RETRY_MS;
    this.publishedRevision = 0;
    this.publishedReady = Promise.resolve();
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
      canWrite: this.worker.canWriteOfflineJournal,
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
    this.worker.listen(({ downloadId, index }) => {
      if (!downloadId) return;
      const saved = [this.active, this.repairable, this.staging].find((item) => item?.downloadId === downloadId);
      if (!Number.isSafeInteger(index) || index < 0 || (saved && index >= saved.totalChunks)) return;
      this.store.reportDamagedChunk(downloadId, index);
      this.pendingDamage = true;
      this.reconcileReportedDamage();
    }, () => {
      void this.worker.supportsOfflineWrites().then(() => this.recoverFromWorkerTimeout()).then(() => this.emit()).catch((error) => {
        console.warn("[CompactAudioPlayer] Could not recover offline controls after the worker took control.", error);
      });
    });
    const registration = this.worker.register().catch((error) => {
      console.warn("[CompactAudioPlayer] Could not register the offline player.", error);
      if (error instanceof PlayerWorkerSetupTimeout && this.supported) {
        if (this.worker.controller) return;
        this.workerSetupTimedOut = true;
      }
      this.supported = false;
      this.emit();
    });
    this.publishedReady = this.preparePublishedAtStartup(registration).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not prepare the saved book for startup.", error);
    });
    await registration;
    await this.publishedReady;
    if (this.supported) await this.refresh();
    await this.worker.prepare(this.active);
    this.emit();
    return this.snapshot();
  }

  async recoverFromWorkerTimeout() {
    if (!this.workerSetupTimedOut) return;
    await this.publishedReady;
    if (!this.workerSetupTimedOut || !this.worker.controller) return;
    this.workerSetupTimedOut = false;
    this.supported = true;
    this.emit();
    await this.refresh();
    await this.worker.prepare(this.active);
  }

  async preparePublishedAtStartup(registration) {
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    const prepare = async () => {
      if (!this.worker.controller) await registration;
      if (signal.aborted || (!this.supported && !this.worker.controller)) return;
      if (await this.readPublishedBook(false, signal) && !signal.aborted) await this.worker.prepare(this.active);
    };
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, PUBLISHED_STARTUP_TIMEOUT_MS);
      });
      await Promise.race([prepare(), deadline]);
    } finally {
      clearTimeout(timer);
      this.emit();
    }
  }

  listenForPublishedChanges(BroadcastChannel) {
    if (this.changeChannel || !this.cacheStorage || typeof BroadcastChannel !== "function") return;
    try {
      this.changeChannel = new BroadcastChannel(`compact-player-offline:${this.baseUrl}`);
      this.changeChannel.addEventListener("message", ({ data }) => {
        if (data === PUBLISHED_DOWNLOAD_CHANGED) void this.syncPublishedDownload();
      });
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not listen for offline changes in other tabs.", error);
    }
  }

  announcePublishedChange() {
    try { this.changeChannel?.postMessage(PUBLISHED_DOWNLOAD_CHANGED); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not tell other tabs about the offline change.", error); }
  }

  async syncPublishedDownload(syncStaging = true) {
    if (!this.cacheStorage) return;
    const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the published download timed out.");
    try {
      await prepareWithTimeout(async (signal) => {
        await this.publishedReady;
        checkCanceled(signal);
        if (this.currentPromise) {
          this.publishedSyncPending = true;
          return;
        }
        if (await this.readPublishedBook(syncStaging, signal) && !signal.aborted) {
          this.setPhase(this.staging ? "paused" : this.active ? "ready" : "idle");
        }
      }, undefined, PUBLISHED_SYNC_TIMEOUT_MS, timeout);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not sync the published offline book.", error);
    }
  }

  metaCache() { return this.store.metaCache(); }
  readRecord(type, includeUnpublished, signal) { return this.store.readRecord(type, includeUnpublished, signal); }
  writeRecord(type, manifest, signal) { return this.store.writeRecord(type, manifest, signal); }

  get downloadedConfig() {
    const url = this.store.configUrl(this.active);
    return url ? { id: this.active.episodeId, url } : null;
  }

  async withLock(action, whenBusy, waitMs) {
    if (!await this.worker.supportsOfflineWrites()) {
      throw new OfflineDownloadError("unsupported", "The player is waiting for the updated offline worker.");
    }
    const jobs = [];
    try {
      return await withOfflineLock(this.navigator, `compact-player-offline:${this.baseUrl}`, async () => {
        this.cleanupJobs = jobs;
        try { return await action(); }
        finally { this.cleanupJobs = null; }
      }, whenBusy, waitMs);
    } finally {
      for (const job of jobs) void this.cleanup(job);
    }
  }

  setPublishedBook(saved) {
    this.publishedRevision++;
    this.active = saved?.status === "ready" ? saved : null;
    this.repairable = ["needs-config", "needs-audio"].includes(saved?.status) ? saved : null;
    void this.worker.prepare(this.active);
  }

  recordIds() {
    return { activeId: this.active?.downloadId, repairableId: this.repairable?.downloadId, stagingId: this.staging?.downloadId };
  }

  updateIfCurrent(expected, action, signal) {
    return this.withLock(async () => {
      const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the saved download records timed out.");
      const { saved, staging, resetId } = await prepareWithTimeout(async (readSignal) => {
        const current = await this.inventoryRecords(readSignal, false);
        checkCanceled(readSignal);
        if (current.saved?.status === "ready" && current.saved.downloadId === expected.repairableId) {
          current.saved = await this.store.checkReadyConfig(current.saved, readSignal);
        }
        return current;
      }, signal, INVENTORY_CHECK_TIMEOUT_MS, timeout);
      checkCanceled(signal);
      this.setPublishedBook(saved);
      this.staging = staging;
      if (this.active?.downloadId !== expected.activeId || this.repairable?.downloadId !== expected.repairableId
        || this.staging?.downloadId !== expected.stagingId) {
        this.emit();
        return offlineConflict();
      }
      return action(resetId);
    }, offlineConflict);
  }

  async readPublishedBook(syncStaging = false, signal) {
    const revision = ++this.publishedRevision;
    try {
      const saved = await this.readRecord("active", true, signal);
      if (signal?.aborted) return false;
      const checked = saved?.status === "ready" ? await this.store.checkReadyConfig(saved, signal) : saved;
      if (signal?.aborted) return false;
      const staging = syncStaging ? await this.readRecord("staging", false, signal) : null;
      if (signal?.aborted || revision !== this.publishedRevision) return false;
      if (syncStaging && this.currentPromise) {
        this.publishedSyncPending = true;
        return false;
      }
      this.setPublishedBook(checked);
      if (syncStaging) this.staging = staging?.downloadId !== saved?.downloadId ? staging : null;
      return true;
    } catch (error) {
      if (!signal?.aborted) console.warn("[CompactAudioPlayer] Could not read the published offline book.", error);
    }
  }

  async refresh() {
    if (!this.supported || this.currentPromise) return this.snapshot();
    try {
      const outcome = await this.inspectAndReconcileDownloads();
      if (outcome !== "applied" && outcome !== "timed-out") await this.syncPublishedDownload();
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not access the offline lock. Reading the published book.", error);
      this.supported = false;
      await this.syncPublishedDownload(false);
      this.emit();
    } finally {
      if (this.pendingDamage) this.reconcileReportedDamage();
    }
    return this.snapshot();
  }

  reconcileReportedDamage(retryLock = true) {
    if (!this.supported || !this.pendingDamage || this.damageCheck || this.currentPromise) return;
    clearTimeout(this.damageRetryTimer);
    this.damageRetryTimer = null;
    let retry = false;
    let lockTimedOut = false;
    this.damageCheck = Promise.resolve().then(async () => {
      this.pendingDamage = false;
      const outcome = await this.inspectAndReconcileDownloads(true);
      lockTimedOut = outcome === "lock-timeout";
      if (outcome !== "applied" && outcome !== "timed-out" && !lockTimedOut) await this.syncPublishedDownload();
      const queued = this.pendingDamage;
      if (outcome !== "applied") this.pendingDamage = true;
      retry = outcome === "applied" || outcome === "stale" || (queued && ["failed", "timed-out"].includes(outcome))
        || (lockTimedOut && (retryLock || queued));
    }).catch((error) => {
      this.pendingDamage = true;
      console.warn("[CompactAudioPlayer] Could not check the damaged audio chunk.", error);
    }).finally(() => {
      this.damageCheck = null;
      if (!lockTimedOut) this.damageRetryDelay = DAMAGE_LOCK_RETRY_MS;
      if (retry && this.pendingDamage) this.reconcileReportedDamage(!lockTimedOut);
      else if (lockTimedOut && this.pendingDamage) this.scheduleDamageRetry();
    });
  }

  scheduleDamageRetry() {
    if (this.damageRetryTimer !== null) return;
    this.damageRetryTimer = setTimeout(() => {
      this.damageRetryTimer = null;
      this.reconcileReportedDamage(false);
    }, this.damageRetryDelay);
    this.damageRetryDelay = Math.min(this.damageRetryDelay * 2, DAMAGE_LOCK_MAX_RETRY_MS);
  }

  async inventoryRecords(signal, includeUnpublishedStaging = true) {
    const state = await this.store.readActiveState(signal);
    const [saved, stagingState] = await Promise.all([
      this.store.readRecord("active", true, signal, state),
      this.store.readStagingState(includeUnpublishedStaging, signal, state),
    ]);
    const partial = stagingState.manifest;
    return { saved, staging: partial?.downloadId === saved?.downloadId ? null : partial,
      stagingAuthoritative: stagingState.authoritative, revision: state.revision, resetId: state.resetId,
      journalCaches: [state.journalCacheName, state.previousJournalCacheName] };
  }

  async inspectAndReconcileDownloads(waitForLock = false) {
    if (!this.supported || this.currentPromise) return "busy";
    if (!await this.worker.supportsOfflineWrites()) return "busy";
    let records;
    let inventory;
    try {
      const timeout = new OfflineDownloadError("storage-read-timeout", "Scanning the offline caches timed out.");
      ({ records, inventory } = await prepareWithTimeout(async (signal) => {
        const records = await this.inventoryRecords(signal);
        checkCanceled(signal);
        const inventory = await this.store.inspectDownloads(records, signal);
        return { records, inventory };
      }, undefined, INVENTORY_SCAN_TIMEOUT_MS, timeout));
    } catch (error) {
      if (error?.code === "storage-read-timeout" || error?.name === "TimeoutError") {
        console.warn("[CompactAudioPlayer] Offline cache scan timed out.", error);
        return "timed-out";
      }
      return this.inventoryFailed(error);
    }
    try {
      return await this.withLock(() => this.applyInventory(records, inventory), waitForLock ? undefined : () => "busy",
        waitForLock ? INVENTORY_LOCK_TIMEOUT_MS : undefined);
    } catch (error) {
      if (waitForLock && error?.name === "TimeoutError") return "lock-timeout";
      throw error;
    }
  }

  async applyInventory(records, inventory) {
    if (!this.supported || this.currentPromise) return "busy";
    try {
      const timeout = new OfflineDownloadError("storage-timeout", "Checking the saved download records timed out.");
      const stillCurrent = await prepareWithTimeout(async (signal) => {
        const current = await this.inventoryRecords(signal);
        checkCanceled(signal);
        return JSON.stringify(current) === JSON.stringify(records) && this.store.inspectionIsCurrent(inventory, signal);
      }, undefined, INVENTORY_CHECK_TIMEOUT_MS, timeout);
      if (!stillCurrent) return "stale";
      if (this.currentPromise) return "busy";
      // The write lock and rechecked journal identify abandoned candidates. Candidate names are never reused.
      const abandoned = inventory.journalCandidates.filter((name) => !records.journalCaches.includes(name));
      if (abandoned.length) this.cleanupJobs.push((signal) => this.store.deletePublicationCaches(abandoned, signal));
      this.setPublishedBook(records.saved);
      this.staging = records.staging;
      await this.store.applyInspection(inventory);
      await this.reconcileDownloads(records, inventory);
      return "applied";
    } catch (error) {
      return this.inventoryFailed(error);
    }
  }

  inventoryFailed(error) {
    console.warn("[CompactAudioPlayer] Could not reconcile offline downloads. Reading the published book.", error);
    if (isAccessDenied(error)) this.supported = false;
    return "failed";
  }

  async reconcileDownloads({ resetId }, { bookNames, active, staging, damaged, completion }) {
    this.stagingCheck = completion;
    const candidate = completion?.status === "ready" ? completion : active;
    const recoveredStaging = staging && staging.downloadId !== candidate?.downloadId
      && staging.downloadId !== this.staging?.downloadId ? staging : undefined;
    this.staging = staging;
    if (candidate && candidate.downloadId !== this.active?.downloadId) {
      return this.publish(candidate, bookNames, undefined, recoveredStaging);
    }
    const previous = this.active || this.repairable;
    const published = active || damaged;
    const retired = previous && !published && staging?.downloadId !== previous.downloadId
      ? { status: "removed", downloadId: previous.downloadId } : published;
    if (recoveredStaging) await this.store.commitActive(retired, { recoveredStaging });
    else await this.store.reconcileRecord("active", previous, retired);
    this.setPublishedBook(published);
    if (previous?.status !== published?.status || previous?.downloadId !== published?.downloadId) this.announcePublishedChange();
    this.queueBookCleanup(bookNames, resetId);
    this.setPhase(this.staging ? "paused" : "idle");
  }

  async inspectSource(selection, signal) {
    checkCanceled(signal);
    if (!this.supported) throw new OfflineDownloadError("unsupported", "Offline downloads are not supported.");
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to the internet before downloading.");
    const sourceUrl = new URL(selection.sourceUrl);
    if (sourceUrl.origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("cross-origin", "Offline downloads require audio from this site.");
    const { mime, ...representation } = await prepareWithTimeout(
      (boundedSignal) => inspectAudioRange(this.fetchImpl, sourceUrl.href, selection.mime, boundedSignal), signal,
    );
    return { ...representation, mime, ...this.recordIds(), ...await this.downloadSpace(selection, representation, signal) };
  }

  async estimateAvailableBytes(signal) {
    try {
      const estimate = await prepareWithTimeout(
        () => this.navigator.storage?.estimate?.(), signal, STORAGE_ESTIMATE_TIMEOUT_MS,
      );
      if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) return Math.max(0, estimate.quota - estimate.usage);
    } catch {
      checkCanceled(signal);
    }
    return null;
  }

  async downloadSpace(selection, representation, signal) {
    const stagingMatches = canResumeTransfer(this.staging, selection, representation);
    const remainingBytes = representation.totalSize - (stagingMatches ? completedBytes(this.staging) : 0);
    const availableBytes = await this.estimateAvailableBytes(signal);
    const reserve = Math.max(16 * MEBIBYTE, Math.ceil(representation.totalSize * .05));
    return {
      remainingBytes,
      availableBytes,
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
    const space = await this.downloadSpace(selection, check, signal);
    const current = { ...check, ...space, reclaimStaging: false };
    if (current.availableBytes == null || current.availableBytes >= current.requiredBytes) return current;
    const deficit = current.requiredBytes - current.availableBytes;
    const staged = this.staging;
    const replacing = !current.canResume && staged && staged.cacheName !== (this.active || this.repairable)?.cacheName;
    const fits = replacing && completedBytes(staged) >= deficit && await this.store.canReclaimBytes(staged, deficit, signal);
    checkCanceled(signal);
    if (!fits) throw new OfflineDownloadError("quota", "Insufficient browser storage.");
    return { ...current, reclaimStaging: true };
  }

  async putManifest(files, manifest, signal) {
    await writeStagingData(() => files.writeManifest(manifest), signal);
    await this.writeRecord("staging", manifest, signal);
    this.staging = manifest;
  }

  async createStaging(selection, preflight, signal, resetId) {
    let manifest = this.store.stagingManifest(selection, preflight, resetId);
    const previous = this.staging;
    const files = await this.store.openStagingFiles(manifest, signal, { creating: true });
    try {
      if (previous) manifest = await this.prepareRequiredConfig(manifest, selection, signal);
      await this.putManifest(files, manifest, signal);
    } catch (error) {
      this.queueBookCleanup([manifest.cacheName], resetId, manifest);
      throw error;
    }
    this.stagingCheck = null;
    if (previous) {
      if (!preflight.reclaimStaging) this.queueBookCleanup([previous.cacheName], resetId, previous);
      this.announcePublishedChange();
    }
    return { files, manifest, configPrepared: Boolean(previous) };
  }

  async cacheSupportingAssets(files, assets, configUrl, signal) {
    for (const asset of assets || []) {
      const url = String(asset?.url || "");
      if (!url || url === configUrl || new URL(url).origin !== new URL(this.baseUrl).origin) continue;
      const save = (assetSignal) => fetchWithRetry(url, {
        fetchImpl: this.fetchImpl, retries: 1, timeoutMs: PREPARATION_TIMEOUT_MS,
        headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" },
        cache: "no-store",
        credentials: "same-origin",
        signal: assetSignal,
      }, async (response) => {
        if (assetSignal.aborted) {
          void response.body?.cancel().catch(() => { /* The fetch may already have canceled the body. */ });
          checkCanceled(assetSignal);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await files.writeAsset(url, response);
      });
      try {
        if (asset.required) await save(signal);
        else await prepareWithTimeout(save, signal, OPTIONAL_ASSET_TIMEOUT_MS);
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
      if (this.busy) this.setPhase(this.staging ? "paused" : "idle");
      if (this.pendingDamage) this.reconcileReportedDamage();
      if (this.publishedSyncPending) {
        this.publishedSyncPending = false;
        void this.syncPublishedDownload();
      }
    });
    this.setPhase("preparing");
    return this.currentPromise;
  }

  async checkStaging(staging, selection, signal) {
    this.stagingCheck = null;
    this.stagingCheck = await this.store.checkCompletion(staging, selection, signal);
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
          const ready = await this.updateIfCurrent(expected,
            () => this.finishStaging(selection, expected, confirmDownload, signal), signal);
          if (ready !== undefined) return ready;
        }
        const check = preflight || await this.inspectSource(selection, signal);
        checkCanceled(signal);
        if (!confirmDownload(check, selection)) return null;
        const persistence = preflight ? null : this.requestPersistence();
        const ready = await this.updateIfCurrent(check, async (resetId) => {
          const current = await this.checkSpaceBeforeWrite(selection, check, signal);
          checkCanceled(signal);
          return this.runDownload(selection, current, signal, waitForPriority, resetId);
        }, signal);
        if (ready && persistence && onPersistence) {
          void persistence.then((granted) => {
            if (this.active?.downloadId === ready.downloadId) onPersistence(granted);
          }).catch((error) => console.warn("[CompactAudioPlayer] Could not report the offline storage permission.", error));
        }
        return ready;
      } catch (error) {
        if (signal.aborted && expected.stagingId && this.staging?.downloadId === expected.stagingId
          && sameOfflineSelection(this.staging, selection)) {
          await this.updateIfCurrent(expected, async () => {
            await this.removeStagingLocked();
            this.setPhase("idle");
          });
        }
        throw error;
      }
    });
  }

  async finishStaging(selection, expected, confirmDownload, signal) {
    let stored = await this.checkStaging(this.staging, selection, signal);
    checkCanceled(signal);
    if (!stored || stored.status === "downloading") {
      if (stored) this.staging = stored;
      return;
    }
    const check = { ...expected, totalSize: stored.totalSize, remainingBytes: 0, requiredBytes: 0, canResume: true };
    if (!confirmDownload(check, selection)) return null;
    if (stored.status === "needs-config") {
      await this.restoreConfig(stored, signal);
      stored = await this.checkStaging(this.staging, selection, signal);
      if (stored?.status !== "ready") throw new OfflineDownloadError("incomplete", "The saved book is incomplete.");
      checkCanceled(signal);
    }
    this.setPhase("finalizing");
    await this.publish(stored, undefined, signal);
    return stored;
  }

  async fetchValidatedConfig(candidate, url, signal) {
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to restore the book configuration.");
    if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("config", "The saved configuration URL belongs to another site.");
    const text = await prepareWithTimeout(async (requestSignal) => {
      const result = await this.fetchImpl(url, { cache: "no-store", credentials: "same-origin",
        headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" }, signal: requestSignal });
      checkCanceled(requestSignal);
      if (!result.ok) throw new OfflineDownloadError("config", "Could not retrieve the saved book configuration.");
      return readBookConfigText(result, requestSignal);
    }, signal);
    checkCanceled(signal);
    return { url, text, id: this.store.validateConfig(candidate, url, text) };
  }

  async restoreConfig(candidate, signal) {
    const config = await this.fetchValidatedConfig(candidate, this.store.configUrl(candidate), signal);
    try {
      await writeStagingData((writeSignal) => this.store.saveConfig(candidate, config, writeSignal), signal);
      return config.id;
    } catch (error) {
      if (this.staging?.cacheName === candidate.cacheName && (signal.aborted || error?.code === "storage-timeout")) {
        await this.removeStagingLocked();
      }
      throw error;
    }
  }

  async prepareRequiredConfig(manifest, selection, signal) {
    const url = this.store.checkConfigUrl(manifest, this.store.configUrl(selection));
    if (!url) return manifest;
    const expected = { ...manifest, configBookId: manifest.configBookId || selection.configBookId };
    const id = await this.store.cachedConfigId(expected, url, signal) || await this.restoreConfig(expected, signal);
    // Older downloads can record a catalog alias without the book configuration's ID.
    return manifest.configBookId ? manifest : { ...manifest, configBookId: id };
  }

  repairConfig() {
    const expected = this.recordIds();
    return this.runOperation((signal) => this.updateIfCurrent(expected, async () => {
      const candidate = this.repairable;
      const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the saved book cache timed out.");
      if (candidate?.status !== "needs-config" || this.active
        || !await prepareWithTimeout((readSignal) => this.store.hasBookCache(candidate, readSignal),
          signal, INVENTORY_CHECK_TIMEOUT_MS, timeout)) {
        throw new OfflineDownloadError("conflict", "The saved download has changed.");
      }
      checkCanceled(signal);
      await this.restoreConfig(candidate, signal);
      const ready = await this.store.readBookManifest(candidate.cacheName, candidate, { signal });
      if (!validManifest(ready, "ready") || ready.downloadId !== candidate.downloadId) {
        throw new OfflineDownloadError("incomplete", "The saved audio is incomplete.");
      }
      checkCanceled(signal);
      this.setPhase("publishing-repair");
      await this.publish(ready, undefined, signal);
      return ready;
    }, signal));
  }

  async publish(manifest, bookNames = [(this.active || this.repairable)?.cacheName], signal, recoveredStaging) {
    let committed;
    try {
      const consumeStaging = this.staging?.downloadId === manifest.downloadId;
      committed = await this.store.publish(manifest, signal, recoveredStaging, consumeStaging);
    } catch (error) {
      if (this.staging?.downloadId === manifest.downloadId && (signal?.aborted || error?.code === "storage-timeout")) {
        await this.removeStagingLocked();
      }
      throw error;
    }
    this.setPublishedBook(manifest);
    this.announcePublishedChange();
    if (this.staging?.downloadId === manifest.downloadId) this.staging = null;
    this.queueBookCleanup(bookNames, committed.resetId);
    this.setPhase(this.staging ? "paused" : "ready");
  }

  queueBookCleanup(bookNames, resetId, retiredBook) {
    const retained = new Set([this.active?.cacheName, this.staging?.cacheName, this.repairable?.cacheName]);
    const obsolete = bookNames.filter((name) => name && !retained.has(name));
    if (obsolete.length) this.cleanupJobs.push((signal) => this.store.deleteObsoleteBookCaches(obsolete, resetId, signal, retiredBook));
  }

  async cleanup(remove) {
    try {
      const timeout = new OfflineDownloadError("storage-timeout", "Removing old offline downloads timed out.");
      await prepareWithTimeout(remove, undefined, BOOK_CLEANUP_TIMEOUT_MS, timeout);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not finish offline cleanup. The next visit will retry.", error);
    }
  }

  async runDownload(selection, preflight, signal, waitForPriority, resetId) {
    this.setPhase("preparing");
    const reclaim = preflight.reclaimStaging ? this.staging : null;
    let manifest;
    try {
      let files;
      let configPrepared = false;
      if (preflight.canResume && canResumeTransfer(this.staging, selection, preflight)) {
        manifest = this.staging;
        files = await this.store.openStagingFiles(manifest, signal);
      } else ({ files, manifest, configPrepared } = await this.createStaging(selection, preflight, signal, resetId));
      if (reclaim) await this.reclaimRetiredStaging(reclaim, resetId, signal);
      if (!configPrepared) {
        const configured = await this.prepareRequiredConfig(manifest, selection, signal);
        if (configured !== manifest) await this.putManifest(files, configured, signal);
        manifest = configured;
      }
      await this.cacheSupportingAssets(files, selection.assets, this.store.configUrl(manifest), signal);
      const completed = new Set(manifest.completed);
      this.setPhase("downloading");
      for await (const { index, chunk } of downloadChunks(this.fetchImpl, manifest, signal, waitForPriority)) {
        await writeStagingData(() => files.writeChunk(index, chunk), signal);
        checkCanceled(signal);
        completed.add(index);
        manifest = { ...manifest, completed: [...completed].sort((a, b) => a - b) };
        await this.putManifest(files, manifest, signal);
        this.setPhase("downloading");
      }
      manifest = await this.checkStaging(manifest, selection, signal);
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
      await this.publish(manifest, undefined, signal);
      return manifest;
    } catch (error) {
      if ((signal.aborted || error?.code === "storage-timeout") && this.phase !== "finalizing") {
        if (manifest && this.staging?.downloadId === manifest.downloadId) await this.removeStagingLocked();
        if (signal.aborted) {
          this.setPhase(this.staging ? "paused" : "idle");
          throw createAbortError("Download canceled");
        }
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

  async reclaimRetiredStaging(staging, resetId, signal) {
    const timeout = new OfflineDownloadError("storage-timeout", "Freeing space for the replacement download timed out.");
    try {
      await prepareWithTimeout((readSignal) => this.store.reclaimStagingCache(staging, readSignal), signal, BOOK_CLEANUP_TIMEOUT_MS, timeout);
    } catch (error) {
      this.queueBookCleanup([staging.cacheName], resetId, staging);
      throw error;
    }
  }

  async removeStagingLocked() {
    const staging = this.staging;
    if (!staging) return;
    const resetId = await this.store.retireStaging();
    this.staging = null;
    this.stagingCheck = null;
    this.announcePublishedChange();
    this.queueBookCleanup([staging.cacheName], resetId, staging);
  }

  async removeActive() {
    await this.updateIfCurrent(this.recordIds(), async () => {
      const saved = this.active || this.repairable;
      if (!saved) return;
      const committed = await this.store.removePublishedBook(saved);
      this.setPublishedBook(null);
      this.announcePublishedChange();
      this.queueBookCleanup([saved.cacheName], committed.resetId, saved);
      this.setPhase(this.staging ? "paused" : "idle");
    });
  }

  async reset() {
    this.store.cacheStorage ??= this.getCacheStorage();
    if (!this.cacheStorage) return;
    this.abortController?.abort();
    try { await this.currentPromise; } catch {}
    const { resetId, previous } = await this.withLock(async () => {
      const readTimeout = new OfflineDownloadError("storage-timeout", "Reading the previous download records timed out.");
      const previous = await prepareWithTimeout((signal) => Promise.all([
        this.readRecord("active", true, signal), this.readRecord("staging", true, signal),
      ]), undefined, RESET_CLEANUP_TIMEOUT_MS, readTimeout).catch((error) => {
        console.warn("[CompactAudioPlayer] Could not read the old download records before reset.", error);
        return [];
      });
      const resetId = await this.store.clearDownloads();
      this.setPublishedBook(null);
      this.staging = null;
      this.stagingCheck = null;
      this.announcePublishedChange();
      this.setPhase("idle");
      return { resetId, previous };
    }, offlineConflict);
    try {
      const cleanupTimeout = new OfflineDownloadError("storage-timeout", "Removing the old offline book files timed out.");
      await prepareWithTimeout((signal) => this.store.cleanResetDownloads(resetId, previous, signal),
        undefined, RESET_CLEANUP_TIMEOUT_MS, cleanupTimeout);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not finish removing the old offline book files.", error);
    }
  }
}
