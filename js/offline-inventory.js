import "./offline-manifest.js?v=25";
import "./bounded-response.js?v=25";
import { responseJson } from "./offline-journal.js?v=25";
import { sameOfflineSelection } from "./offline-selection.js?v=25";
import { checkCanceled, OfflineDownloadError, withOfflineDeadline } from "./offline-transfer.js?v=25";

const { validManifest, offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, damagedChunkUrl, confirmedChunkUrl,
  damageVersionHeader, chunkByteLength, requiredConfigUrl, chunkReadTimeoutMs, readVerifiedChunk,
  matchesChunkHeaders, hasRequiredChunkChecksum } = globalThis.CompactPlayerOfflineManifest;
const { cancelResponseBody } = globalThis.CompactPlayerResponse;

const SCAN_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 3000;
const RECHECK_TIMEOUT_MS = 3000;

export function hasAllChunks(staging) {
  return Boolean(staging && staging.completed.length === staging.totalChunks);
}

export function sameDownload(manifest, other) {
  return sameOfflineSelection(manifest, other) && manifest.downloadId === other.downloadId && manifest.cacheName === other.cacheName;
}

export function useRecordedMetadata(local, recorded) {
  const url = requiredConfigUrl(recorded);
  if (url && (url !== requiredConfigUrl(local) || local.configRevision !== recorded.configRevision)) {
    local = { ...local, assets: recorded.assets, configRevision: recorded.configRevision };
  }
  if (recorded.totalSize !== local.totalSize || recorded.chunkSize !== local.chunkSize) return local;
  if (recorded.chunkRevision > (local.chunkRevision ?? 0)) local = { ...local, chunkRevision: recorded.chunkRevision };
  if (!recorded.checksummedChunks?.length) return local;
  const checksummed = new Set(local.checksummedChunks);
  const originalCount = checksummed.size;
  for (const index of recorded.checksummedChunks) checksummed.add(index);
  return checksummed.size === originalCount ? local : { ...local, checksummedChunks: [...checksummed].sort((a, b) => a - b) };
}

export function repairedManifest(original, record, cacheName, saved) {
  const repaired = record?.manifest;
  return record?.base === JSON.stringify(original) && validManifest(repaired) && repaired.cacheName === cacheName
    && (!saved || sameDownload(repaired, saved)) ? repaired : original;
}

export function readForVerification(action, signal) {
  if (!signal) return action();
  const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the saved download timed out.");
  return withOfflineDeadline(action, signal, chunkReadTimeoutMs, timeout);
}

function hasValidChunkBody(response, expected, signal) {
  const read = (readSignal) => readVerifiedChunk(response, expected, readSignal);
  if (signal) return readForVerification(read, signal);
  const timeout = new OfflineDownloadError("timeout", "Reading the saved audio chunk timed out.");
  return withOfflineDeadline(read, undefined, chunkReadTimeoutMs, timeout);
}

function recoverDownloads(manifests, saved, publishedStaging) {
  // After an explicit removal only a later staging download can become the saved book.
  if (saved?.status === "removed") manifests = manifests.filter((manifest) =>
    manifest.downloadId !== saved.downloadId && (manifest.status === "downloading" || manifest.downloadId === publishedStaging?.downloadId));
  const newest = (status, published, by) => {
    const candidates = manifests.filter((manifest) => manifest.status === status);
    return candidates.find((manifest) => manifest.cacheName === published?.cacheName)
      || candidates.sort((a, b) => b[by] - a[by])[0] || null;
  };
  const staging = newest("downloading", publishedStaging, "createdAt");
  const incompleteBook = manifests.find((manifest) => manifest.status === "downloading" && sameDownload(manifest, saved));
  if (incompleteBook) {
    const damaged = staging === incompleteBook ? null : { ...incompleteBook, status: "needs-audio" };
    return { active: null, staging, damaged };
  }
  const damaged = newest("needs-config", saved, "downloadedAt");
  const publishedNeedsConfig = damaged && damaged.cacheName === saved?.cacheName;
  const active = publishedNeedsConfig ? null : newest("ready", saved, "downloadedAt");
  return { active, damaged, staging };
}

export class OfflineBookInspector {
  constructor(baseUrl, { match, matchesCacheName, checkReadyConfig, snapshotDamageVersions, hasDamageReport }) {
    Object.assign(this, { baseUrl, match, matchesCacheName, checkReadyConfig, snapshotDamageVersions, hasDamageReport });
  }

  async restoreLocalManifest(inspection, cacheName, saved) {
    if (!saved || saved.cacheName !== cacheName) return null;
    if (!this.matchesCacheName(cacheName, saved.downloadId)) return null;
    let manifest = saved;
    if (saved.status === "needs-config") manifest = { ...saved, status: "ready" };
    if (saved.status === "needs-audio") manifest = { ...saved, status: "downloading" };
    if (!validManifest(manifest)) return null;
    const local = await this.verifyBookChunks(inspection, manifest, true, saved.status);
    if (!local) return null;
    const verified = local.status === "ready" ? await this.checkReadyConfig(local, inspection.signal) : local;
    inspection.repair = local;
    return verified;
  }

  async checkChunks(inspection, manifest, verifySize) {
    const completed = [];
    for (const index of manifest.completed) {
      const chunk = await inspection.match(offlineChunkUrl(this.baseUrl, manifest.downloadId, index));
      if (!matchesChunkHeaders(chunk, manifest, index)) {
        if (chunk?.ok && !hasRequiredChunkChecksum(chunk, manifest, index)) inspection.checksumDamage = true;
        cancelResponseBody(chunk?.body);
        continue;
      }
      const expected = chunkByteLength(manifest, index);
      const marker = damagedChunkUrl(this.baseUrl, manifest.downloadId, index);
      const reported = await inspection.match(marker);
      const version = reported?.headers.get(damageVersionHeader);
      const verified = version && confirmedChunkUrl(this.baseUrl, manifest.downloadId, index);
      const confirmed = verified && await inspection.match(verified);
      const needsCheck = reported && (!version || confirmed?.headers.get(damageVersionHeader) !== version);
      const reportedInMemory = this.hasDamageReport(manifest.downloadId, index);
      if (!verifySize && !needsCheck && !reportedInMemory) {
        cancelResponseBody(chunk.body);
        completed.push(index);
      } else if (await hasValidChunkBody(chunk, expected, inspection.signal)) {
        completed.push(index);
        if ((needsCheck && verified) || reportedInMemory) inspection.confirmedChunks.set(index, {
          url: needsCheck && verified,
          version,
          damage: reportedInMemory ? { downloadId: manifest.downloadId, index } : null,
        });
      }
    }
    return completed;
  }

  async verifyBookChunks(inspection, manifest, verifySize, publishedStatus) {
    let completed = await this.checkChunks(inspection, manifest, verifySize);
    if (completed.length === manifest.completed.length) return manifest;
    if (manifest.status === "ready" && publishedStatus !== "downloading") {
      if (!publishedStatus) return null;
      // Check the surviving bytes before using the published book as a partial download.
      if (completed.length && !verifySize) completed = await this.checkChunks(inspection, { ...manifest, completed }, true);
      if (!completed.length && !inspection.checksumDamage) {
        let reportedDamage = false;
        for (const index of manifest.completed) {
          if (this.hasDamageReport(manifest.downloadId, index)
            || await inspection.match(damagedChunkUrl(this.baseUrl, manifest.downloadId, index))) {
            reportedDamage = true;
            break;
          }
        }
        if (!reportedDamage) return null;
      }
    }
    return { ...manifest, status: "downloading", completed };
  }

  async inspectBookManifest(cacheName, saved, { restoreMissing = true, verifyCompleted = false, signal } = {}) {
    const damageVersions = this.snapshotDamageVersions();
    const match = (url) => this.match(cacheName, url, signal);
    const response = await match(offlineManifestUrl(this.baseUrl));
    const original = await readForVerification((readSignal) => responseJson(response, readSignal), signal);
    const repairResponse = await match(offlineMetaUrl(this.baseUrl, "manifest-repair"));
    const repairRecord = await readForVerification((readSignal) => responseJson(repairResponse, readSignal), signal);
    const repairBase = JSON.stringify(original);
    const restored = repairedManifest(original, repairRecord, cacheName, saved);
    const downloadId = restored?.downloadId ?? saved?.downloadId;
    const inspection = { cacheName, original, repairRecord, repairBase, restored, match, signal,
      repair: null, confirmedChunks: new Map(), downloadId, damageVersion: damageVersions.get(downloadId) };
    const manifest = await this.verifyLocalManifest(inspection, saved, restoreMissing, verifyCompleted);
    const { repair, confirmedChunks, damageVersion } = inspection;
    return { cacheName, original, repairRecord, repairBase, manifest, repair, confirmedChunks, downloadId, damageVersion };
  }

  async verifyLocalManifest(inspection, saved, restoreMissing, verifyCompleted) {
    const { cacheName } = inspection;
    let manifest = inspection.restored;
    if (!validManifest(manifest)) {
      if (!restoreMissing || manifest?.status === "removed" || (manifest?.downloadId && manifest.downloadId !== saved?.downloadId)
        || (manifest?.cacheName && manifest.cacheName !== cacheName)) return null;
      return this.restoreLocalManifest(inspection, cacheName, saved);
    }
    if (manifest.cacheName !== cacheName) return null;
    const publishedStatus = sameDownload(manifest, saved) ? saved.status : null;
    if (saved?.cacheName === cacheName && !publishedStatus) {
      throw new OfflineDownloadError("manifest", "The local and published records identify different downloads.");
    }
    const local = manifest;
    if (publishedStatus) manifest = useRecordedMetadata(manifest, saved);
    const verifySize = verifyCompleted || (hasAllChunks(manifest) && publishedStatus !== "ready");
    manifest = await this.verifyBookChunks(inspection, manifest, verifySize, publishedStatus);
    if (!manifest) return null;
    if (manifest !== local) inspection.repair = manifest;
    // Both startup and Resume pass an unpublished replacement through completionFor().
    if (publishedStatus === "downloading" && manifest.status === "ready") return { ...manifest, status: "downloading" };
    return manifest.status === "ready" ? this.checkReadyConfig(manifest, inspection.signal) : manifest;
  }
}

export class OfflineInventory {
  constructor({ store, canInspect, canWrite, withLock, onVerified, onReconciled, onFailure }) {
    this.store = store;
    this.canInspect = canInspect;
    this.canWrite = canWrite;
    this.withLock = withLock;
    this.onVerified = onVerified;
    this.onReconciled = onReconciled;
    this.onFailure = onFailure;
  }

  async readRecords(signal, includeUnpublishedStaging = true) {
    const snapshot = await this.store.readControlSnapshot(signal);
    const state = await this.store.readActiveState(signal, false, snapshot);
    const [saved, stagingState] = await Promise.all([
      this.store.readRecord("active", true, signal, state),
      this.store.readStagingState(includeUnpublishedStaging, signal, state, snapshot),
    ]);
    const partial = stagingState.manifest;
    return { saved, staging: partial?.downloadId === saved?.downloadId ? null : partial,
      stagingAuthoritative: stagingState.authoritative, revision: state.revision, resetId: state.resetId,
      journalCaches: [state.journalCacheName, state.previousJournalCacheName] };
  }

  async inspect({ saved, staging: publishedStaging, stagingAuthoritative, revision, resetId }, signal) {
    const damageRevision = this.store.damageRevision;
    const { bookNames, journalCandidates } = await this.store.listBookCaches(saved, publishedStaging, signal);
    checkCanceled(signal);
    const authoritative = Boolean(saved) || revision > 0 || stagingAuthoritative;
    // Once the active record exists, only it and the recorded draft can be recovered.
    const eligible = bookNames.filter((name) => this.store.belongsToEpoch(name, resetId)
      && (!authoritative || name === saved?.cacheName || name === publishedStaging?.cacheName));
    const inspections = await Promise.all(eligible.map((name) =>
      this.store.inspectBookManifest(name, name === publishedStaging?.cacheName ? publishedStaging : saved, { signal })));
    checkCanceled(signal);
    const manifests = inspections.map(({ manifest }) => manifest).filter(Boolean);
    const { active, staging, damaged } = recoverDownloads(manifests, saved, publishedStaging);
    const completion = hasAllChunks(staging) && sameDownload(staging, publishedStaging)
      ? await this.store.completionFor(staging, publishedStaging, signal) : null;
    return { bookNames, journalCandidates, active, staging, damaged, completion, inspections, damageRevision };
  }

  async scan(waitForLock = false) {
    if (!this.canInspect()) return "busy";
    if (!await this.canWrite()) return "read-only";
    if (waitForLock) {
      const available = await this.withLock(() => true, () => false);
      if (!available) return "lock-timeout";
    }

    let records;
    let inventory;
    try {
      const timeout = new OfflineDownloadError("storage-read-timeout", "Scanning the offline caches timed out.");
      ({ records, inventory } = await withOfflineDeadline(async (signal) => {
        const records = await this.readRecords(signal);
        checkCanceled(signal);
        const inventory = await this.inspect(records, signal);
        return { records, inventory };
      }, undefined, SCAN_TIMEOUT_MS, timeout));
    } catch (error) {
      if (error?.code === "storage-read-timeout" || error?.name === "TimeoutError") {
        console.warn("[CompactAudioPlayer] Offline cache scan timed out.", error);
        return "timed-out";
      }
      return this.fail(error);
    }

    try {
      return await this.withLock(() => this.apply(records, inventory), waitForLock ? undefined : () => "busy",
        waitForLock ? LOCK_TIMEOUT_MS : undefined);
    } catch (error) {
      if (waitForLock && error?.name === "TimeoutError") return "lock-timeout";
      throw error;
    }
  }

  async apply(records, inventory) {
    if (!this.canInspect()) return "busy";
    try {
      const timeout = new OfflineDownloadError("storage-timeout", "Checking the saved download records timed out.");
      const stillCurrent = await withOfflineDeadline(async (signal) => {
        const current = await this.readRecords(signal);
        checkCanceled(signal);
        return JSON.stringify(current) === JSON.stringify(records) && this.store.inspectionIsCurrent(inventory, signal);
      }, undefined, RECHECK_TIMEOUT_MS, timeout);
      if (!stillCurrent) return "stale";
      if (!this.canInspect()) return "busy";

      const abandoned = inventory.journalCandidates.filter((name) => !records.journalCaches.includes(name));
      this.onVerified(records, abandoned);
      await this.store.applyInspection(inventory);
      await this.onReconciled(await this.reconcile(records, inventory));
      return "applied";
    } catch (error) {
      return this.fail(error);
    }
  }

  async reconcile(records, { bookNames, active, staging, damaged, completion, damageRevision }) {
    const previous = records.saved?.status === "removed" ? null : records.saved;
    const candidate = completion?.status === "ready" ? completion : active;
    const recoveredStaging = staging && staging.downloadId !== candidate?.downloadId
      && staging.downloadId !== records.staging?.downloadId ? staging : undefined;
    const result = { staging, completion, bookNames, resetId: records.resetId, damageRevision };
    if (candidate && (previous?.status !== "ready" || candidate.downloadId !== previous.downloadId)) {
      return { ...result, publication: { candidate, recoveredStaging } };
    }

    const saved = active || damaged || null;
    const retired = previous && !saved && staging?.downloadId !== previous.downloadId
      ? { status: "removed", downloadId: previous.downloadId } : saved;
    if (recoveredStaging) await this.store.commitActive(retired, { recoveredStaging });
    else await this.store.reconcileRecord("active", previous, retired);
    const changed = previous?.status !== saved?.status || previous?.downloadId !== saved?.downloadId;
    return { ...result, saved, changed };
  }

  fail(error) {
    console.warn("[CompactAudioPlayer] Could not reconcile offline downloads. Reading the published book.", error);
    this.onFailure(error);
    return "failed";
  }
}
