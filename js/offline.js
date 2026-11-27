import "./offline-manifest.js?v=25";
import "./bounded-response.js?v=25";
import { readBookConfigText } from "./config.js?v=25";
import { readLibraryText } from "./book-config.js?v=25";
import { createAbortError, fetchWithRetry } from "./utils.js?v=25";
import { OfflineBookStore, hasAllChunks, isQuotaError, sameOfflineSelection } from "./offline-book-store.js?v=25";
import { OfflineDownloadSpace, canResumeTransfer, completedBytes } from "./offline-download-space.js?v=25";
import { withOfflineLock } from "./offline-lock.js?v=25";
import { OfflineDownloadError, checkCanceled, downloadChunks, inspectAudioRange, withOfflineDeadline as prepareWithTimeout } from "./offline-transfer.js?v=25";
import { PlayerWorker, PlayerWorkerSetupTimeout } from "./player-worker.js?v=25";
import { OfflineDamageRecovery } from "./offline-damage-recovery.js?v=25";
import { OfflineInventory, sameDownload } from "./offline-inventory.js?v=25";
import { createOfflinePlayback } from "./offline-playback.js?v=25";
import { OfflineTabSync } from "./offline-tab-sync.js?v=25";
import { OfflineWorkerRoutes } from "./offline-worker-routes.js?v=25";
export { OFFLINE_CHUNK_SIZE, OfflineDownloadError, chunkBounds, parseContentRange } from "./offline-transfer.js?v=25";
export { completedBytes };

const PREPARATION_TIMEOUT_MS = 20_000;
const OPTIONAL_ASSET_TIMEOUT_MS = 3000;
const STAGING_WRITE_TIMEOUT_MS = 20_000;
const PUBLISHED_STARTUP_TIMEOUT_MS = 3000;
const RECORD_CHECK_TIMEOUT_MS = 3000;
const RESET_CLEANUP_TIMEOUT_MS = 3000;
const BOOK_CLEANUP_TIMEOUT_MS = 3000;

const {
  schemaVersion: OFFLINE_SCHEMA_VERSION, metaCache: OFFLINE_META_CACHE, downloadHeader: OFFLINE_DOWNLOAD_HEADER,
  validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl,
} = globalThis.CompactPlayerOfflineManifest;
export { OFFLINE_SCHEMA_VERSION, OFFLINE_META_CACHE, OFFLINE_DOWNLOAD_HEADER, validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl };
export { OFFLINE_BOOK_CACHE_PREFIX, sameOfflineSelection, manifestMatchesSelection } from "./offline-book-store.js?v=25";

const { coverMaxBytes, isHtmlResponse, cancelResponseBody, readResponseBytes, responseWithDecodedBody } = globalThis.CompactPlayerResponse;

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
    this.coordinationName = `compact-player-offline:${this.baseUrl}`;
    this.onChange = onChange;
    this.fetchImpl = fetchImpl;
    this.navigator = navigatorObject;
    this.worker = new PlayerWorker({
      baseUrl: this.baseUrl, navigatorObject, scriptName: workerScriptName, releaseSequence: workerReleaseSequence,
    });
    this.routes = new OfflineWorkerRoutes({
      baseUrl: this.baseUrl, fetchImpl,
      isOnline: () => this.navigator?.onLine !== false,
      connect: () => this.worker.connect(),
      readControl: () => this.worker.readControl(),
      onChange: () => this.emit(),
    });
    this.workerSetupTimedOut = false;
    this.workerRegistrationFailed = false;
    this.workerRegistrationRetry = null;
    this.getCacheStorage = getCacheStorage;
    this.store = new OfflineBookStore(this.baseUrl, null);
    this.storageSpace = new OfflineDownloadSpace({
      getStorage: () => this.navigator.storage,
      canReclaimBytes: (...args) => this.store.canReclaimBytes(...args),
    });
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
    this.resetId = "";
    this.stagingCheck = null;
    this.phase = "idle";
    this.abortController = null;
    this.currentPromise = null;
    this.tabSync = new OfflineTabSync({
      name: this.coordinationName, navigatorObject,
      canRead: () => Boolean(this.cacheStorage),
      waitForPublished: () => this.publishedReady,
      isLocallyBusy: () => Boolean(this.currentPromise || this.cleanupJobs),
      readPublished: (full, signal) => this.readPublishedBook(full, signal),
      getDraft: () => this.staging,
      inspectDraft: async (draft, signal) => {
        if (!hasAllChunks(draft)) return null;
        return this.store.completionFor(draft, draft, signal);
      },
      onSync: (records, staged) => {
        this.updateDownloadState(records);
        if (staged) this.stagingCheck = staged.completion;
        this.restoreRestingPhase();
      },
    });
    this.inventory = new OfflineInventory({
      store: this.store,
      canInspect: () => this.supported && !this.currentPromise,
      canWrite: () => this.worker.supportsOfflineWrites(),
      withLock: (...args) => this.withLock(...args),
      onVerified: (records, abandoned) => {
        if (abandoned.length) this.cleanupJobs.push((signal) => this.store.deletePublicationCaches(abandoned, signal));
        this.updateDownloadState({ saved: records.saved, staging: records.staging, resetId: records.resetId, deferDamageCleanup: true });
      },
      onReconciled: (result) => this.applyReconciledDownloads(result),
      onFailure: (error) => { if (isAccessDenied(error)) this.supported = false; },
    });
    this.damage = new OfflineDamageRecovery({
      canRun: () => this.supported && !this.currentPromise,
      inspect: () => this.inventory.scan(true),
      sync: () => this.syncPublishedDownload(),
    });
    this.pendingDamageRetirements = new Set();
    this.publishedRevision = 0;
    this.publishedReady = Promise.resolve();
    this.playback = createOfflinePlayback({
      routes: this.routes,
      getActive: () => this.active,
      isSupported: () => this.supported,
      hasController: () => this.worker.readControl().controlled,
      waitForPublished: () => this.publishedReady,
    });
  }

  get cacheStorage() { return this.store.cacheStorage; }

  get busy() { return ["preparing", "downloading", "finalizing", "publishing-repair"].includes(this.phase); }
  get canCancel() {
    return this.busy ? this.phase === "preparing" || this.phase === "downloading"
      : Boolean(this.staging && !this.tabSync.lockBusy && !this.tabSync.lockUnavailable);
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
      canWrite: this.worker.canWriteOfflineJournal && !this.tabSync.lockUnavailable,
      active: this.active,
      repairable: this.repairable,
      staging: this.staging,
      phase: this.phase,
      busy: this.busy,
      writeLockBusy: Boolean(this.staging && this.tabSync.lockBusy && !this.busy && !this.cleanupJobs),
      canCancel: this.canCancel,
      stagingStatus,
      canFinishOffline: stagingStatus === "ready",
      progress: this.progress,
    };
  }

  emit() { this.onChange(this.snapshot()); }

  async retryWorkerConnection() {
    if (!this.supported && !this.workerSetupTimedOut) return;
    try {
      await this.worker.retryCapabilities();
      await this.recoverFromWorkerTimeout();
      this.emit();
      if (this.workerRegistrationFailed) {
        if (!this.workerRegistrationRetry) {
          this.workerRegistrationRetry = this.worker.register().then(() => {
            this.workerRegistrationFailed = false;
          }).finally(() => { this.workerRegistrationRetry = null; });
        }
        await this.workerRegistrationRetry;
        await this.recoverFromWorkerTimeout();
        this.emit();
      }
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not retry the offline worker connection.", error);
    }
  }

  setPhase(phase) {
    this.phase = phase;
    this.emit();
  }

  restoreRestingPhase() {
    this.setPhase(this.staging ? "paused" : this.active ? "ready" : "idle");
  }

  async init() {
    if (!this.supported) { this.emit(); return this.snapshot(); }
    this.worker.listen(({ downloadId, index }) => {
      if (!downloadId) return;
      const saved = [this.active, this.repairable, this.staging].find((item) => item?.downloadId === downloadId);
      if (!Number.isSafeInteger(index) || index < 0 || (saved && index >= saved.totalChunks)) return;
      this.store.reportDamagedChunk(downloadId, index);
      this.damage.report();
    }, () => {
      void this.worker.supportsOfflineWrites().then(async (writable) => {
        await this.recoverFromWorkerTimeout();
        this.emit();
        if (writable) {
          await this.damage.check;
          this.damage.resume();
        }
      }).catch((error) => {
        console.warn("[CompactAudioPlayer] Could not recover offline controls after the worker took control.", error);
      });
    }, () => {
      void this.playback.connectionChanged();
      this.emit();
    });
    const registration = this.worker.register().catch((error) => {
      console.warn("[CompactAudioPlayer] Could not register the offline player.", error);
      const retryable = error instanceof PlayerWorkerSetupTimeout || ["TypeError", "NetworkError", "TimeoutError"].includes(error?.name);
      if (retryable) this.workerRegistrationFailed = true;
      if (retryable && this.worker.controller) return;
      if (retryable && this.supported) this.workerSetupTimedOut = true;
      this.supported = false;
      this.emit();
    });
    this.publishedReady = this.preparePublishedAtStartup(registration).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not prepare the saved book for startup.", error);
    });
    await registration;
    await this.publishedReady;
    if (this.supported) await this.refresh();
    await this.routes.prepare(this.active);
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
    await this.routes.prepare(this.active);
  }

  async preparePublishedAtStartup(registration) {
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    const prepare = async () => {
      if (!this.worker.controller) await registration;
      if (signal.aborted || (!this.supported && !this.worker.controller)) return;
      for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
        const read = await this.readPublishedBook(false, signal);
        if (!read || !await read.isCurrent() || signal.aborted) continue;
        this.updateDownloadState(read.records);
        await this.routes.prepare(this.active);
        return;
      }
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

  listenForPublishedChanges(BroadcastChannel) { this.tabSync.listen(BroadcastChannel); }

  announcePublishedChange() { this.tabSync.announce(); }

  syncPublishedDownload(syncStaging, options) { return this.tabSync.request(syncStaging, options); }

  metaCache() { return this.store.metaCache(); }
  readRecord(type, includeUnpublished, signal) { return this.store.readRecord(type, includeUnpublished, signal); }
  writeRecord(type, manifest, signal) { return this.store.writeRecord(type, manifest, signal); }

  get downloadedConfig() {
    const url = this.store.configUrl(this.active);
    return url ? { id: this.active.episodeId, url } : null;
  }

  async withLock(action, whenBusy, waitMs) {
    const unsupported = () => new OfflineDownloadError("unsupported", "The player is waiting for the updated offline worker.");
    if (!await this.worker.supportsOfflineWrites()) throw unsupported();
    const jobs = [];
    try {
      return await withOfflineLock(this.navigator, this.coordinationName, async () => {
        if (!await this.worker.supportsOfflineWrites() || !this.worker.canWriteOfflineJournal) throw unsupported();
        this.cleanupJobs = jobs;
        try { return await action(); }
        finally { this.cleanupJobs = null; }
      }, whenBusy, waitMs);
    } finally {
      for (const job of jobs) void this.cleanup(job);
      this.tabSync.operationSettled();
    }
  }

  updateDownloadState({ saved, staging, resetId, damageRevision, deferDamageCleanup = false }) {
    const previousSaved = (this.active || this.repairable)?.downloadId;
    const previousStaging = this.staging?.downloadId;
    if (saved !== undefined) {
      this.publishedRevision++;
      this.active = saved?.status === "ready" ? saved : null;
      this.repairable = ["needs-config", "needs-audio"].includes(saved?.status) ? saved : null;
    }
    if (staging !== undefined) this.staging = staging;

    const savedId = (this.active || this.repairable)?.downloadId;
    const stagingId = this.staging?.downloadId;
    if (previousSaved && previousSaved !== savedId) this.pendingDamageRetirements.add(previousSaved);
    if (previousStaging && previousStaging !== stagingId) this.pendingDamageRetirements.add(previousStaging);
    if (saved?.status === "removed") this.pendingDamageRetirements.add(saved.downloadId);

    // Wait for the staging record before retiring a previously published ID.
    if (staging !== undefined && !deferDamageCleanup) {
      if (damageRevision !== undefined) this.store.forgetUnreferencedDamage([savedId, stagingId], damageRevision);
      for (const id of this.pendingDamageRetirements) {
        if (id !== savedId && id !== stagingId) this.store.forgetDamage(id);
      }
      this.pendingDamageRetirements.clear();
    }
    if (resetId !== undefined) this.resetId = resetId || "";
    if (resetId) this.store.setDamageEpoch(resetId);
    if (saved !== undefined) void this.routes.prepare(this.active);
  }

  recordIds() {
    return { resetId: this.resetId, activeId: this.active?.downloadId,
      repairableId: this.repairable?.downloadId, stagingId: this.staging?.downloadId };
  }

  async readDownloadVersion(signal, expected = this.recordIds()) {
    const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the offline reset record timed out.");
    const { resetId } = await prepareWithTimeout((readSignal) => this.store.readActiveState(readSignal),
      signal, RECORD_CHECK_TIMEOUT_MS, timeout);
    return { ...expected, resetId: resetId || "" };
  }

  updateIfCurrent(expected, action, signal) {
    return this.withLock(async () => {
      const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the saved download records timed out.");
      const { saved, staging, resetId } = await prepareWithTimeout(async (readSignal) => {
        const current = await this.inventory.readRecords(readSignal, false);
        checkCanceled(readSignal);
        if (current.saved?.status === "ready" && current.saved.downloadId === expected.repairableId) {
          current.saved = await this.store.checkReadyConfig(current.saved, readSignal);
        }
        return current;
      }, signal, RECORD_CHECK_TIMEOUT_MS, timeout);
      checkCanceled(signal);
      this.updateDownloadState({ saved, staging, resetId: resetId || "" });
      if (this.resetId !== (expected.resetId || "") || this.active?.downloadId !== expected.activeId
        || this.repairable?.downloadId !== expected.repairableId
        || this.staging?.downloadId !== expected.stagingId) {
        this.emit();
        return offlineConflict();
      }
      return action(resetId);
    }, offlineConflict);
  }

  async readPublishedBook(syncStaging = false, signal) {
    const revision = ++this.publishedRevision;
    const failed = (error) => {
      if (!signal?.aborted) console.warn("[CompactAudioPlayer] Could not read the published offline book.", error);
      return null;
    };
    try {
      const snapshot = await this.store.readControlSnapshot(signal);
      const state = await this.store.readActiveState(signal, false, snapshot);
      const saved = await this.store.readRecord("active", true, signal, state);
      if (signal?.aborted) return null;
      const checked = saved?.status === "ready" ? await this.store.checkReadyConfig(saved, signal) : saved;
      if (signal?.aborted) return null;
      const staging = syncStaging ? (await this.store.readStagingState(false, signal, state, snapshot)).manifest : null;
      if (signal?.aborted || revision !== this.publishedRevision) return null;
      const isCurrent = async () => {
        const current = snapshot && await this.store.readControlSnapshot(signal).catch(failed);
        return !signal?.aborted && revision === this.publishedRevision && JSON.stringify(current) === JSON.stringify(snapshot);
      };
      const records = { saved: checked, resetId: state.resetId,
        staging: syncStaging ? (staging?.downloadId !== saved?.downloadId ? staging : null) : undefined };
      return { records, isCurrent };
    } catch (error) {
      return failed(error);
    }
  }

  async refresh() {
    if (!this.supported || this.currentPromise) return this.snapshot();
    try {
      const outcome = await this.inventory.scan();
      if (outcome !== "applied" && outcome !== "timed-out") await this.syncPublishedDownload();
    } catch (error) {
      if (error?.code === "unsupported") {
        await this.syncPublishedDownload();
        return this.snapshot();
      }
      console.warn("[CompactAudioPlayer] Could not access the offline lock. Reading the published book.", error);
      if (isAccessDenied(error) || error?.name === "NotSupportedError") this.supported = false;
      await this.syncPublishedDownload(false);
      this.emit();
    } finally {
      this.damage.resume();
    }
    return this.snapshot();
  }

  async applyReconciledDownloads({ saved, staging, resetId, completion, damageRevision, publication, bookNames, changed }) {
    this.stagingCheck = completion;
    if (publication) {
      this.updateDownloadState({ staging, deferDamageCleanup: true });
      return this.publish(publication.candidate, bookNames, undefined,
        { recoveredStaging: publication.recoveredStaging, damageRevision });
    }
    this.updateDownloadState({ saved, staging, resetId, damageRevision });
    if (changed) this.announcePublishedChange();
    this.queueBookCleanup(bookNames, resetId);
    this.restoreRestingPhase();
  }

  async inspectSource(selection, signal, records = this.recordIds()) {
    return (await this.planDownload(selection, signal, records)).check;
  }

  async planDownload(selection, signal, records) {
    checkCanceled(signal);
    if (!this.supported) throw new OfflineDownloadError("unsupported", "Offline downloads are not supported.");
    if (this.navigator.onLine === false) throw new OfflineDownloadError("offline", "Connect to the internet before downloading.");
    const sourceUrl = new URL(selection.sourceUrl);
    if (sourceUrl.origin !== new URL(this.baseUrl).origin) throw new OfflineDownloadError("cross-origin", "Offline downloads require audio from this site.");
    const expected = await this.readDownloadVersion(signal, records);
    const representation = await prepareWithTimeout(
      (boundedSignal) => inspectAudioRange(this.fetchImpl, sourceUrl.href, selection.mime, boundedSignal), signal,
    );
    const draft = this.staging;
    const inspection = draft?.completed.length && canResumeTransfer(draft, selection, representation)
      ? await this.inspectResumeDraft(draft, signal) : null;
    const space = await this.storageSpace.inspect(selection, representation, inspection?.manifest ?? draft, signal);
    return { check: { ...representation, ...expected, ...space }, draft, inspection };
  }

  async inspectResumeDraft(draft, signal) {
    const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the interrupted download timed out.");
    const inspection = await prepareWithTimeout((readSignal) => this.store.inspectBookManifest(draft.cacheName, draft,
      { restoreMissing: false, verifyCompleted: true, signal: readSignal }), signal, PREPARATION_TIMEOUT_MS, timeout);
    if (!sameDownload(inspection.manifest, draft) || inspection.manifest.status !== "downloading") {
      throw new OfflineDownloadError("manifest", "Invalid interrupted download manifest.");
    }
    return inspection;
  }

  async prepareResume(selection, check, plan, signal) {
    const draft = this.staging;
    if (!draft?.completed.length || !canResumeTransfer(draft, selection, check)) return;
    let inspection = plan?.inspection;
    const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the interrupted download timed out.");
    const current = inspection && JSON.stringify(plan.draft) === JSON.stringify(draft)
      && await prepareWithTimeout((readSignal) => this.store.inspectionIsCurrent({ inspections: [inspection] }, readSignal),
        signal, RECORD_CHECK_TIMEOUT_MS, timeout);
    // Cache Storage can lose a chunk without changing either manifest.
    const cached = current && await prepareWithTimeout((readSignal) => this.store.hasCachedChunks(inspection.manifest, readSignal),
      signal, PREPARATION_TIMEOUT_MS, timeout);
    if (!cached) inspection = await this.inspectResumeDraft(draft, signal);
    await this.store.applyInspection({ inspections: [inspection] }, signal);
    checkCanceled(signal);
    if (JSON.stringify(inspection.manifest) !== JSON.stringify(draft)) {
      await this.writeRecord("staging", inspection.manifest, signal);
      this.updateDownloadState({ staging: inspection.manifest });
    }
  }

  async putManifest(files, manifest, signal) {
    await writeStagingData(() => files.writeManifest(manifest), signal);
    await this.writeRecord("staging", manifest, signal);
    this.updateDownloadState({ staging: manifest });
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
    if (previous && !preflight.reclaimStaging) this.queueBookCleanup([previous.cacheName], resetId, previous);
    this.announcePublishedChange();
    return { files, manifest, configPrepared: Boolean(previous) };
  }

  async cacheSupportingAssets(files, assets, configUrl, availableForAssets, signal) {
    if (!Array.isArray(assets)) return;
    const base = new URL(this.baseUrl);
    const libraryUrl = new URL("media/library.json", base).href;
    const internalPath = new URL(".", offlineManifestUrl(this.baseUrl)).pathname;
    for (const asset of assets) {
      const url = String(asset?.url || "");
      if (!url || url === configUrl) continue;
      try {
        const assetUrl = new URL(url);
        if (assetUrl.origin !== base.origin || assetUrl.pathname.startsWith(internalPath)) continue;
      }
      catch { continue; }
      const limit = asset.required ? coverMaxBytes : Math.min(coverMaxBytes, availableForAssets);
      if (!limit) continue;
      const save = (assetSignal) => fetchWithRetry(url, {
        fetchImpl: this.fetchImpl, retries: 1, timeoutMs: PREPARATION_TIMEOUT_MS,
        headers: { [OFFLINE_DOWNLOAD_HEADER]: "1" },
        cache: "no-store",
        credentials: "same-origin",
        signal: assetSignal,
      }, async (response) => {
        if (assetSignal.aborted) {
          cancelResponseBody(response.body);
          checkCanceled(assetSignal);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!asset.required && url !== libraryUrl && isHtmlResponse(response)) {
          cancelResponseBody(response.body);
          return;
        }
        const bytes = url === libraryUrl
          ? new TextEncoder().encode(await readLibraryText(response, assetSignal))
          : await readResponseBytes(response.body, limit, assetSignal);
        if (!bytes?.byteLength || bytes.byteLength > limit) return;
        checkCanceled(assetSignal);
        if (!asset.required) availableForAssets -= bytes.byteLength;
        await files.writeAsset(url, responseWithDecodedBody(response, bytes));
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
      if (this.busy) this.restoreRestingPhase();
      this.damage.resume();
      this.tabSync.operationSettled();
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
    const recordIds = this.recordIds();
    return this.runOperation(async (signal) => {
      let expected = preflight || recordIds;
      let heldForTransfer = false;
      const announceTransfer = () => {
        heldForTransfer = true;
        if (this.staging) this.announcePublishedChange();
      };
      try {
        if (hasAllChunks(this.staging) && sameOfflineSelection(this.staging, selection)) {
          if (!preflight) expected = await this.readDownloadVersion(signal, recordIds);
          const ready = await this.updateIfCurrent(expected, () => {
            announceTransfer();
            return this.finishStaging(selection, expected, confirmDownload, signal);
          }, signal);
          if (ready !== undefined) return ready;
        }
        const plan = preflight ? null : await this.planDownload(selection, signal, recordIds);
        const check = preflight || plan.check;
        expected = check;
        checkCanceled(signal);
        if (!confirmDownload(check, selection)) return null;
        const persistence = preflight ? null : this.storageSpace.requestPersistence();
        const ready = await this.updateIfCurrent(check, async (resetId) => {
          announceTransfer();
          await this.prepareResume(selection, check, plan, signal);
          const current = await this.storageSpace.checkBeforeWrite(selection, check,
            { staging: this.staging, saved: this.active || this.repairable }, signal);
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
            this.restoreRestingPhase();
          });
        }
        throw error;
      } finally {
        if (heldForTransfer) this.announcePublishedChange();
      }
    });
  }

  async finishStaging(selection, expected, confirmDownload, signal) {
    let stored = await this.checkStaging(this.staging, selection, signal);
    checkCanceled(signal);
    if (!stored || stored.status === "downloading") {
      if (stored) this.updateDownloadState({ staging: stored });
      return;
    }
    const check = { ...expected, totalSize: stored.totalSize, remainingBytes: 0, requiredBytes: 0, canResume: true };
    if (!confirmDownload(check, selection)) return null;
    if (stored.status === "needs-config") {
      const repaired = await this.restoreConfig(stored, signal);
      const draft = { ...repaired, status: "downloading" };
      await this.writeRecord("staging", draft, signal);
      this.updateDownloadState({ staging: draft });
      stored = await this.checkStaging(draft, selection, signal);
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
      if (requestSignal.aborted || !result.ok) {
        cancelResponseBody(result.body);
        checkCanceled(requestSignal);
        throw new OfflineDownloadError("config", "Could not retrieve the saved book configuration.");
      }
      return readBookConfigText(result, requestSignal);
    }, signal);
    checkCanceled(signal);
    return { url, text, id: this.store.validateConfig(candidate, url, text) };
  }

  async restoreConfig(candidate, signal) {
    const config = await this.fetchValidatedConfig(candidate, this.store.configUrl(candidate), signal);
    const stored = await writeStagingData((writeSignal) => this.store.saveConfig(candidate, config, writeSignal), signal);
    return stored.configBookId ? stored : { ...stored, configBookId: config.id };
  }

  async prepareRequiredConfig(manifest, selection, signal) {
    const url = this.store.checkConfigUrl(manifest, this.store.configUrl(selection));
    if (!url) return manifest;
    const expected = { ...manifest, configBookId: manifest.configBookId || selection.configBookId };
    const id = await this.store.cachedConfigId(expected, url, signal);
    if (!id) return this.restoreConfig(manifest.configBookId ? manifest : expected, signal);
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
          signal, RECORD_CHECK_TIMEOUT_MS, timeout)) {
        throw new OfflineDownloadError("conflict", "The saved download has changed.");
      }
      checkCanceled(signal);
      const repaired = await this.restoreConfig(candidate, signal);
      const ready = await this.store.readBookManifest(candidate.cacheName, repaired, { signal });
      if (!validManifest(ready, "ready") || ready.downloadId !== candidate.downloadId) {
        throw new OfflineDownloadError("incomplete", "The saved audio is incomplete.");
      }
      checkCanceled(signal);
      this.setPhase("publishing-repair");
      await this.publish(ready, undefined, signal);
      return ready;
    }, signal));
  }

  async publish(manifest, bookNames = [(this.active || this.repairable)?.cacheName], signal,
    { recoveredStaging, damageRevision } = {}) {
    let committed;
    const consumeStaging = this.staging?.downloadId === manifest.downloadId;
    try {
      committed = await this.store.publish(manifest, signal, recoveredStaging, consumeStaging);
    } catch (error) {
      if (this.staging?.downloadId === manifest.downloadId && (signal?.aborted || error?.code === "storage-timeout")) {
        await this.removeStagingLocked();
      }
      throw error;
    }
    this.updateDownloadState({ saved: manifest, staging: consumeStaging ? null : this.staging,
      resetId: committed.resetId, damageRevision });
    this.announcePublishedChange();
    this.queueBookCleanup(bookNames, committed.resetId);
    this.restoreRestingPhase();
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

  async transferChunks(manifest, files, signal, waitForPriority) {
    const completed = new Set(manifest.completed);
    const checksummed = new Set(manifest.checksummedChunks);
    this.setPhase("downloading");
    for await (const { index, chunk } of downloadChunks(this.fetchImpl, manifest, signal, waitForPriority)) {
      await writeStagingData(() => files.writeChunk(index, chunk), signal);
      checkCanceled(signal);
      completed.add(index);
      checksummed.add(index);
      manifest = { ...manifest, completed: [...completed].sort((a, b) => a - b),
        checksummedChunks: [...checksummed].sort((a, b) => a - b), chunkRevision: (manifest.chunkRevision ?? 0) + 1 };
      await this.putManifest(files, manifest, signal);
      this.setPhase("downloading");
    }
    return manifest;
  }

  async runDownload(selection, preflight, signal, waitForPriority, resetId) {
    this.setPhase("preparing");
    const reclaim = preflight.reclaimStaging ? this.staging : null;
    let manifest;
    let preserveOnTimeout = false;
    try {
      let files;
      let configPrepared = false;
      if (preflight.canResume && canResumeTransfer(this.staging, selection, preflight)) {
        manifest = this.staging;
        files = await this.store.openStagingFiles(manifest, signal);
      } else ({ files, manifest, configPrepared } = await this.createStaging(selection, preflight, signal, resetId));
      if (reclaim) {
        preserveOnTimeout = true;
        await this.reclaimRetiredStaging(reclaim, resetId, signal);
        preserveOnTimeout = false;
      }
      if (!configPrepared) {
        preserveOnTimeout = manifest.completed.length > 0;
        const configured = await this.prepareRequiredConfig(manifest, selection, signal);
        preserveOnTimeout = false;
        if (configured !== manifest) await this.putManifest(files, configured, signal);
        manifest = configured;
      }
      await this.cacheSupportingAssets(files, selection.assets, this.store.configUrl(manifest), preflight.availableForAssets, signal);
      manifest = await this.transferChunks(manifest, files, signal, waitForPriority);
      manifest = await this.checkStaging(manifest, selection, signal);
      checkCanceled(signal);
      if (manifest?.status === "downloading" && canResumeTransfer(manifest, selection, preflight)) {
        this.updateDownloadState({ staging: manifest });
        await this.storageSpace.checkBeforeWrite(selection, preflight, { staging: manifest,
          saved: this.active || this.repairable }, signal);
        checkCanceled(signal);
        manifest = await this.transferChunks(manifest, files, signal, waitForPriority);
        manifest = await this.checkStaging(manifest, selection, signal);
        checkCanceled(signal);
      }
      if (!manifest) {
        await this.removeStagingLocked();
        throw new OfflineDownloadError("manifest", "Invalid completed download manifest.");
      }
      if (manifest.status === "needs-config") throw new OfflineDownloadError("config", "The saved book configuration is missing or invalid.");
      if (manifest.status !== "ready") {
        this.updateDownloadState({ staging: manifest });
        throw new OfflineDownloadError("incomplete", "A downloaded audio chunk is missing.");
      }
      this.setPhase("finalizing");
      await this.publish(manifest, undefined, signal);
      return manifest;
    } catch (error) {
      if ((signal.aborted || (error?.code === "storage-timeout" && !preserveOnTimeout)) && this.phase !== "finalizing") {
        if (manifest && this.staging?.downloadId === manifest.downloadId) await this.removeStagingLocked();
        if (signal.aborted) {
          this.restoreRestingPhase();
          throw createAbortError("Download canceled");
        }
      }
      this.restoreRestingPhase();
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
        this.restoreRestingPhase();
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
    this.updateDownloadState({ staging: null });
    this.stagingCheck = null;
    this.announcePublishedChange();
    this.queueBookCleanup([staging.cacheName], resetId, staging);
  }

  async removeActive() {
    await this.updateIfCurrent(this.recordIds(), async () => {
      const saved = this.active || this.repairable;
      if (!saved) return;
      const committed = await this.store.removePublishedBook(saved);
      this.updateDownloadState({ saved: null, staging: this.staging });
      this.announcePublishedChange();
      this.queueBookCleanup([saved.cacheName], committed.resetId, saved);
      this.restoreRestingPhase();
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
      this.updateDownloadState({ saved: null, staging: null, resetId });
      this.stagingCheck = null;
      this.announcePublishedChange();
      this.restoreRestingPhase();
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
