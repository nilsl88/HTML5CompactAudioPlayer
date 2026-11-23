import "./offline-manifest.js?v=20";
import { readBookConfigText } from "./config.js?v=20";
import { sameOfflineSelection, manifestMatchesSelection, validateOfflineBookConfig } from "./offline-selection.js?v=20";
export { sameOfflineSelection, manifestMatchesSelection } from "./offline-selection.js?v=20";
import { OFFLINE_CHUNK_SIZE, OfflineDownloadError, sameAudioRevision, checkCanceled, withOfflineDeadline } from "./offline-transfer.js?v=20";

const { validManifest, audioMimeType, metaCache: OFFLINE_META_CACHE, schemaVersion: OFFLINE_SCHEMA_VERSION,
  offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, damagedChunkUrl, confirmedChunkUrl, damageVersionHeader, chunkByteLength,
  activeCandidatePrefix, offlineControl, readActiveState, chunkReadTimeoutMs, readExactChunk } = globalThis.CompactPlayerOfflineManifest;
export const OFFLINE_BOOK_CACHE_PREFIX = "compact-player-offline-book-v2-";
const LEGACY_BOOK_CACHE_PREFIX = "compact-player-offline-book-v1-";
const STAGING_META_CACHE_PREFIX = "compact-player-offline-staging-v1:";
const ACTIVE_WRITE_TIMEOUT_MS = 20_000;
const RECLAIM_CHECK_TIMEOUT_MS = 20_000;
const REPAIR_WRITE_TIMEOUT_MS = 3000;

export async function responseJson(response, signal) {
  checkCanceled(signal);
  if (!response) return null;
  const text = await response.text();
  checkCanceled(signal);
  try { return JSON.parse(text); }
  catch { return null; }
}

export function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
}

export function canResumeTransfer(staging, selection, preflight) {
  return manifestMatchesSelection(staging, selection) && sameAudioRevision(staging, preflight);
}

export function hasAllChunks(staging) {
  return Boolean(staging && staging.completed.length === staging.totalChunks);
}

function sameDownload(manifest, other) {
  return sameOfflineSelection(manifest, other) && manifest.downloadId === other.downloadId && manifest.cacheName === other.cacheName;
}

function repairedManifest(original, record, cacheName, saved) {
  const repaired = record?.manifest;
  return record?.base === JSON.stringify(original) && validManifest(repaired) && repaired.cacheName === cacheName
    && (!saved || sameDownload(repaired, saved)) ? repaired : original;
}

function readForVerification(action, signal) {
  if (!signal) return action();
  const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the saved download timed out.");
  return withOfflineDeadline(action, signal, chunkReadTimeoutMs, timeout);
}

function hasChunkLength(response, expected, signal) {
  const read = (readSignal) => readExactChunk(response.body, expected, readSignal);
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

function createDownloadId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class OfflineBookStore {
  constructor(baseUrl, cacheStorage) {
    this.baseUrl = baseUrl;
    this.cacheStorage = cacheStorage;
    const scope = encodeURIComponent(new URL(baseUrl).pathname);
    this.bookCachePrefix = OFFLINE_BOOK_CACHE_PREFIX + scope + ":";
    this.stagingMetaCacheName = STAGING_META_CACHE_PREFIX + scope;
    this.reportedChunks = new Map();
    this.damageRevision = 0;
  }

  reportDamagedChunk(downloadId, index) {
    this.damageRevision++;
    if (!this.reportedChunks.has(downloadId)) this.reportedChunks.set(downloadId, new Set());
    this.reportedChunks.get(downloadId).add(index);
  }

  newResetId() { return createDownloadId(); }

  get control() { return offlineControl(this.baseUrl, this.cacheStorage); }

  stagingManifest(selection, preflight, resetId) {
    const id = createDownloadId();
    const downloadId = resetId ? `${resetId}.${id}` : id;
    const manifest = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      status: "downloading",
      downloadId,
      cacheName: `${this.bookCachePrefix}${downloadId}`,
      episodeId: selection.episodeId,
      configBookId: selection.configBookId || selection.episodeId,
      episodeTitle: String(selection.episodeTitle || selection.episodeId),
      languageCode: selection.languageCode,
      languageTag: selection.languageTag || (selection.downloadId ? undefined : selection.languageCode),
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
      responseUrl: preflight.responseUrl,
      createdAt: Date.now(),
      downloadedAt: 0,
    };
    if (!validManifest(manifest, "downloading")) throw new OfflineDownloadError("manifest", "Invalid offline download manifest.");
    return manifest;
  }

  async openStagingFiles(manifest, signal, { creating = false } = {}) {
    const timeout = new OfflineDownloadError("storage-read-timeout", "Opening the incomplete download cache timed out.");
    const cache = await withOfflineDeadline(async (openSignal) => {
      const cache = await this.cacheStorage.open(manifest.cacheName);
      if (creating && openSignal.aborted) {
        void this.cacheStorage.delete(manifest.cacheName).catch((error) => {
          console.warn("[CompactAudioPlayer] Could not remove an unused download cache.", error);
        });
      }
      checkCanceled(openSignal);
      return cache;
    }, signal, chunkReadTimeoutMs, timeout);
    return {
      writeManifest: (current) => cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(current)),
      writeChunk: (index, response) => cache.put(offlineChunkUrl(this.baseUrl, manifest.downloadId, index), response),
      writeAsset: (url, response) => cache.put(url, response),
    };
  }

  async clearDownloads() {
    const resetId = this.newResetId();
    await this.commitRemoval(resetId, { resetId });
    return resetId;
  }

  async cleanResetDownloads(resetId, previous, signal) {
    const currentPrefix = `${this.bookCachePrefix}${resetId}.`;
    if (await this.cacheStorage.has(OFFLINE_META_CACHE)) {
      checkCanceled(signal);
      const legacy = await this.metaCache();
      for (const type of ["active", "staging"]) {
        checkCanceled(signal);
        await legacy.delete(offlineMetaUrl(this.baseUrl, type));
      }
    }
    checkCanceled(signal);
    const names = await this.cacheStorage.keys();
    for (const name of names) {
      checkCanceled(signal);
      if (name.startsWith(currentPrefix)) continue;
      const recorded = previous.find((record) => record?.cacheName === name);
      if (!await this.ownsBookCache(name, recorded, signal)) continue;
      if ((await this.readActiveState(signal)).resetId !== resetId) return;
      checkCanceled(signal);
      await this.cacheStorage.delete(name);
    }
  }

  async metaCache() { return this.cacheStorage.open(OFFLINE_META_CACHE); }

  configUrl(manifest) {
    return Array.isArray(manifest?.assets) && manifest.assets.find((asset) => asset?.required)?.url;
  }

  async ownsBookCache(name, published, signal) {
    checkCanceled(signal);
    if (typeof name !== "string") return false;
    if (name.startsWith(this.bookCachePrefix)) return true;
    if (!name.startsWith(LEGACY_BOOK_CACHE_PREFIX)) return false;
    // Legacy names contain only a download ID. The manifest URL identifies the installation.
    const manifest = await this.cacheStorage.match(offlineManifestUrl(this.baseUrl), { cacheName: name });
    checkCanceled(signal);
    if (manifest) return true;
    if (name !== published?.cacheName || name !== LEGACY_BOOK_CACHE_PREFIX + published.downloadId) return false;
    for (const index of published.completed || []) {
      const chunk = await this.cacheStorage.match(offlineChunkUrl(this.baseUrl, published.downloadId, index), { cacheName: name });
      checkCanceled(signal);
      if (chunk) return true;
    }
    return false;
  }

  async hasBookCache(book, signal) {
    if (!await this.ownsBookCache(book.cacheName, book, signal)) return false;
    checkCanceled(signal);
    return this.cacheStorage.has(book.cacheName);
  }

  async deleteObsoleteBookCaches(names, resetId, signal, retiredBook) {
    for (const name of names) {
      if (!await this.ownsBookCache(name, retiredBook, signal)) continue;
      const active = await this.readActiveState(signal);
      if (active.resetId !== resetId) return;
      const staging = await this.readRecord("staging", true, signal, active);
      checkCanceled(signal);
      if (name !== active.manifest?.cacheName && name !== staging?.cacheName) await this.cacheStorage.delete(name);
    }
  }

  async canReclaimBytes(staging, needed, signal) {
    if (!staging) return false;
    const timeout = new OfflineDownloadError("timeout", "Checking space in the interrupted download timed out.");
    const check = async (action, parent, timeoutMs) => {
      try { return await withOfflineDeadline(action, parent, timeoutMs, timeout); }
      catch (error) {
        if (error === timeout) return false;
        throw error;
      }
    };
    const { cacheName, downloadId } = staging;
    return check(async (scanSignal) => {
      if (!await check((cacheSignal) => this.ownsBookCache(cacheName, staging, cacheSignal), scanSignal, chunkReadTimeoutMs)) return false;
      for (const index of staging.completed) {
        const expected = chunkByteLength(staging, index);
        const url = offlineChunkUrl(this.baseUrl, downloadId, index);
        const valid = await check(async (cacheSignal) => {
          const response = await this.cacheStorage.match(url, { cacheName });
          if (!response || (!response.ok && !cacheSignal.aborted)) return false;
          return readExactChunk(response.body, expected, cacheSignal);
        }, scanSignal, chunkReadTimeoutMs);
        if (valid) needed -= expected;
        if (needed <= 0) return true;
      }
      return false;
    }, signal, RECLAIM_CHECK_TIMEOUT_MS);
  }

  removePublishedBook(saved) {
    return this.commitRemoval(saved.downloadId);
  }

  async commitRemoval(downloadId, options = {}) {
    const marker = { status: "removed", downloadId };
    try {
      return await this.commitActive(marker, options);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
    }
    try {
      return await this.commitActive(marker, { ...options, cacheRecord: false });
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      throw new OfflineDownloadError("quota", "The browser does not have enough storage to save the removal.");
    }
  }

  async retireStaging() {
    const timeout = new OfflineDownloadError("storage-timeout", "Retiring the incomplete download timed out.");
    const { resetId } = await withOfflineDeadline((signal) => this.readActiveState(signal), undefined, chunkReadTimeoutMs, timeout);
    try {
      await this.writeRecord("staging", null);
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      throw new OfflineDownloadError("quota", "The browser does not have enough storage to save the cancellation.");
    }
    return resetId;
  }

  async reclaimStagingCache(manifest, signal) {
    if (!await this.ownsBookCache(manifest.cacheName, manifest, signal)) return;
    checkCanceled(signal);
    await this.cacheStorage.delete(manifest.cacheName);
  }

  async readStagingState(includeUnpublished, signal, activeState) {
    const key = offlineMetaUrl(this.baseUrl, "staging");
    const verifyCandidate = async (record) => {
      const manifest = record?.manifest;
      if (!validManifest(manifest, "downloading") || record.cacheName !== manifest.cacheName) return null;
      activeState ??= await this.readActiveState(signal);
      if (activeState.manifest?.downloadId === manifest.downloadId
        || (activeState.resetId && !String(manifest.downloadId).startsWith(activeState.resetId + "."))) return null;
      // Cancellation can reach the book cache before the staging record is cleared.
      checkCanceled(signal);
      const cacheName = manifest.cacheName;
      const original = await responseJson(await this.cacheStorage.match(offlineManifestUrl(this.baseUrl), { cacheName }), signal);
      if (original?.status === "removed") return null;
      checkCanceled(signal);
      const repair = await responseJson(await this.cacheStorage.match(offlineMetaUrl(this.baseUrl, "manifest-repair"), { cacheName }), signal);
      const local = repairedManifest(original, repair, cacheName, manifest);
      if (!local && (!includeUnpublished || !await this.cacheStorage.has(cacheName))) return null;
      checkCanceled(signal);
      return validManifest(local, "downloading") && sameDownload(local, manifest) ? local : manifest;
    };
    const readCandidate = async (cacheName) => {
      checkCanceled(signal);
      return verifyCandidate(await responseJson(await this.cacheStorage.match(key, { cacheName }), signal));
    };
    const current = await this.control.read("staging", signal);
    if (current !== undefined) {
      return { manifest: await verifyCandidate(current), authoritative: true };
    }
    const staged = await readCandidate(this.stagingMetaCacheName) ?? await readCandidate(OFFLINE_META_CACHE);
    if (staged) return { manifest: staged, authoritative: false };
    activeState ??= await this.readActiveState(signal);
    const manifest = activeState.recoveredStaging;
    return { manifest: await verifyCandidate({ cacheName: manifest?.cacheName, manifest }), authoritative: false };
  }

  readActiveState(signal, requireControl = false) {
    checkCanceled(signal);
    return readActiveState(this.baseUrl, async (url, cacheName) => {
      checkCanceled(signal);
      return responseJson(await this.cacheStorage.match(url, { cacheName }), signal);
    }, signal, this.cacheStorage, requireControl);
  }

  async readRecord(type, includeUnpublished = false, signal, activeState) {
    checkCanceled(signal);
    if (type === "staging") return (await this.readStagingState(includeUnpublished, signal, activeState)).manifest;
    const record = activeState ?? await this.readActiveState(signal);
    if (includeUnpublished) {
      const saved = record?.manifest;
      if (saved?.status === "removed" && typeof saved.downloadId === "string" && saved.downloadId) return saved;
      if (saved?.status === "needs-config" && saved.cacheName === record.cacheName
        && validManifest({ ...saved, status: "ready" }, "ready")) return saved;
      if (saved?.status === "needs-audio" && saved.cacheName === record.cacheName
        && validManifest({ ...saved, status: "downloading" })) return saved;
    }
    return validManifest(record?.manifest, "ready") && record.cacheName === record.manifest.cacheName ? record.manifest : null;
  }

  async writeRecord(type, manifest, signal) {
    if (type === "active") return this.commitActive(manifest, { signal });
    checkCanceled(signal);
    try {
      await this.control.write({ staging: manifest ? { cacheName: manifest.cacheName, manifest } : null }, signal);
    } catch (error) {
      if (error?.name === "TimeoutError") throw new OfflineDownloadError("storage-timeout", "Saving the incomplete download record timed out.");
      throw error;
    }
  }

  async commitActive(manifest, { signal, resetId, recoveredStaging, consumeStaging = false, cacheRecord = true } = {}) {
    const timeout = new OfflineDownloadError("storage-timeout", "Saving the active download timed out.");
    const target = cacheRecord ? activeCandidatePrefix(this.baseUrl) + createDownloadId() : undefined;
    let opening = false;
    try {
      const { record, previous } = await withOfflineDeadline(async (currentSignal) => {
        const previous = await this.readActiveState(currentSignal, true);
        checkCanceled(currentSignal);
        if (resetId === undefined && previous.resetId && manifest?.cacheName
          && !String(manifest.downloadId).startsWith(previous.resetId + ".")) {
          throw new OfflineDownloadError("conflict", "The download was cleared in another tab.");
        }
        const record = { schemaVersion: OFFLINE_SCHEMA_VERSION, revision: previous.revision + 1,
          resetId: resetId ?? previous.resetId, cacheName: manifest?.cacheName, manifest };
        const draft = resetId === undefined ? (recoveredStaging ?? previous.recoveredStaging) : null;
        if (draft && draft.downloadId !== manifest?.downloadId) record.recoveredStaging = draft;
        if (target) {
          opening = true;
          const cache = await this.cacheStorage.open(target);
          if (currentSignal.aborted) this.deleteActiveCandidate(target);
          checkCanceled(currentSignal);
          await cache.put(offlineMetaUrl(this.baseUrl, "active"), jsonResponse(record));
          checkCanceled(currentSignal);
        }
        return { record, previous };
      }, signal, ACTIVE_WRITE_TIMEOUT_MS, timeout);
      const publication = { active: { cacheName: target, previousCacheName: previous.journalCacheName,
        revision: record.revision, resetId: record.resetId, committedRecord: record } };
      if (resetId !== undefined) publication.staging = null;
      else if (recoveredStaging) publication.staging = { cacheName: recoveredStaging.cacheName, manifest: recoveredStaging };
      else if (consumeStaging) publication.staging = null;
      await this.control.write(publication, signal);
      if (previous.previousJournalCacheName) this.deleteActiveCandidate(previous.previousJournalCacheName);
      return record;
    } catch (error) {
      if (opening) this.deleteActiveCandidate(target);
      if (error?.name === "TimeoutError") throw timeout;
      throw error;
    }
  }

  deleteActiveCandidate(name) {
    void this.deletePublicationCaches([name]).catch((error) => {
      console.warn("[CompactAudioPlayer] Could not delete an unused offline publication.", error);
    });
  }

  async deletePublicationCaches(names, signal) {
    const prefix = activeCandidatePrefix(this.baseUrl);
    for (const name of names) {
      checkCanceled(signal);
      if (typeof name === "string" && name.startsWith(prefix)) await this.cacheStorage.delete(name);
    }
  }

  async reconcileRecord(type, previous, verified) {
    if (JSON.stringify(previous) !== JSON.stringify(verified)) await this.writeRecord(type, verified);
  }

  async inspectDownloads({ saved, staging: publishedStaging, stagingAuthoritative, revision, resetId }, signal) {
    const damageRevision = this.damageRevision;
    const bookNames = [];
    const journalCandidates = [];
    const journalPrefix = activeCandidatePrefix(this.baseUrl);
    const names = await this.cacheStorage.keys();
    checkCanceled(signal);
    for (const name of names) {
      checkCanceled(signal);
      if (name.startsWith(journalPrefix)) journalCandidates.push(name);
      else if (await this.ownsBookCache(name, name === publishedStaging?.cacheName ? publishedStaging : saved, signal)) bookNames.push(name);
    }
    checkCanceled(signal);
    const authoritative = Boolean(saved) || revision > 0 || stagingAuthoritative;
    const prefix = this.bookCachePrefix + resetId + ".";
    // Once the active record exists, only it and the recorded draft can be recovered.
    const eligible = bookNames.filter((name) => (!resetId || name.startsWith(prefix))
      && (!authoritative || name === saved?.cacheName || name === publishedStaging?.cacheName));
    const inspections = await Promise.all(eligible.map((name) =>
      this.inspectBookManifest(name, name === publishedStaging?.cacheName ? publishedStaging : saved, { signal })));
    checkCanceled(signal);
    const manifests = inspections.map(({ manifest }) => manifest);
    const { active, staging, damaged } = recoverDownloads(manifests.filter(Boolean), saved, publishedStaging);
    const completion = hasAllChunks(staging) && sameDownload(staging, publishedStaging)
      ? await this.completionFor(staging, publishedStaging, signal) : null;
    return { bookNames, journalCandidates, active, staging, damaged, completion, inspections, damageRevision };
  }

  async inspectionIsCurrent({ inspections, damageRevision }, signal) {
    checkCanceled(signal);
    if (damageRevision !== this.damageRevision) return false;
    const url = offlineManifestUrl(this.baseUrl);
    const repairUrl = offlineMetaUrl(this.baseUrl, "manifest-repair");
    const unchanged = await Promise.all(inspections.map(async ({ cacheName, original, repairRecord }) => {
      const current = await responseJson(await this.cacheStorage.match(url, { cacheName }), signal);
      checkCanceled(signal);
      const currentRepair = await responseJson(await this.cacheStorage.match(repairUrl, { cacheName }), signal);
      checkCanceled(signal);
      return JSON.stringify(current) === JSON.stringify(original) && JSON.stringify(currentRepair) === JSON.stringify(repairRecord)
        && (current !== null || await this.cacheStorage.has(cacheName));
    }));
    checkCanceled(signal);
    return unchanged.every(Boolean) && damageRevision === this.damageRevision;
  }

  async applyInspection({ inspections }, signal) {
    const timeout = new OfflineDownloadError("storage-write-timeout", "Saving offline repairs timed out.");
    await withOfflineDeadline(async (writeSignal) => {
      for (const { cacheName, repair, repairBase, confirmedChunks, damageRevision } of inspections) {
        if (!repair && !confirmedChunks.size) continue;
        checkCanceled(writeSignal);
        const cache = await this.cacheStorage.open(cacheName);
        checkCanceled(writeSignal);
        if (repair) {
          // A late repair is visible only while the inspected manifests still match.
          const repaired = jsonResponse({ base: repairBase, manifest: repair });
          await cache.put(offlineMetaUrl(this.baseUrl, "manifest-repair"), repaired);
        }
        for (const { url, version, damage } of confirmedChunks.values()) {
          checkCanceled(writeSignal);
          if (damageRevision !== this.damageRevision) break;
          if (url) await cache.put(url, new Response("", { headers: { [damageVersionHeader]: version } }));
          checkCanceled(writeSignal);
          if (damage && damageRevision === this.damageRevision) this.reportedChunks.get(damage.downloadId)?.delete(damage.index);
        }
      }
    }, signal, REPAIR_WRITE_TIMEOUT_MS, timeout);
  }

  applyBookInspection(inspection) {
    return this.applyInspection({ inspections: [inspection] }, inspection.signal);
  }

  async restoreLocalManifest(inspection, cacheName, saved) {
    if (!saved || saved.cacheName !== cacheName) return null;
    if (![this.bookCachePrefix, LEGACY_BOOK_CACHE_PREFIX].some((prefix) => cacheName === prefix + saved.downloadId)) return null;
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
      if (!chunk?.ok) continue;
      const expected = chunkByteLength(manifest, index);
      const length = chunk.headers.get("content-length");
      if (length != null && Number(length) !== expected) continue;
      const marker = damagedChunkUrl(this.baseUrl, manifest.downloadId, index);
      const reported = await inspection.match(marker);
      const version = reported?.headers.get(damageVersionHeader);
      const verified = version && confirmedChunkUrl(this.baseUrl, manifest.downloadId, index);
      const confirmed = verified && await inspection.match(verified);
      const needsCheck = reported && (!version || confirmed?.headers.get(damageVersionHeader) !== version);
      const reportedInMemory = this.reportedChunks.get(manifest.downloadId)?.has(index);
      if (!verifySize && !needsCheck && !reportedInMemory) {
        completed.push(index);
      } else if (await hasChunkLength(chunk, expected, inspection.signal)) {
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
      if (!completed.length) {
        let reportedDamage = false;
        for (const index of manifest.completed) {
          if (this.reportedChunks.get(manifest.downloadId)?.has(index)
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

  async inspectBookManifest(cacheName, saved, { restoreMissing = true, signal } = {}) {
    const damageRevision = this.damageRevision;
    const match = (url) => readForVerification(() => this.cacheStorage.match(url, { cacheName }), signal);
    const response = await match(offlineManifestUrl(this.baseUrl));
    const original = await readForVerification((readSignal) => responseJson(response, readSignal), signal);
    const repairResponse = await match(offlineMetaUrl(this.baseUrl, "manifest-repair"));
    const repairRecord = await readForVerification((readSignal) => responseJson(repairResponse, readSignal), signal);
    const repairBase = JSON.stringify(original);
    const restored = repairedManifest(original, repairRecord, cacheName, saved);
    const inspection = { cacheName, original, repairRecord, repairBase, restored, match, signal,
      repair: null, confirmedChunks: new Map(), damageRevision };
    inspection.manifest = await this.verifyLocalManifest(inspection, saved, restoreMissing);
    return inspection;
  }

  async verifyLocalManifest(inspection, saved, restoreMissing) {
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
    const recordedUrl = publishedStatus && this.configUrl(saved);
    const local = manifest;
    if (recordedUrl && this.configUrl(manifest) !== recordedUrl) manifest = { ...manifest, assets: saved.assets };
    const verifySize = hasAllChunks(manifest) && publishedStatus !== "ready";
    manifest = await this.verifyBookChunks(inspection, manifest, verifySize, publishedStatus);
    if (!manifest) return null;
    if (manifest !== local) inspection.repair = manifest;
    // Both startup and Resume pass an unpublished replacement through completionFor().
    if (publishedStatus === "downloading" && manifest.status === "ready") return { ...manifest, status: "downloading" };
    return manifest.status === "ready" ? this.checkReadyConfig(manifest, inspection.signal) : manifest;
  }

  async readBookManifest(cacheName, saved, options) {
    const inspection = await this.inspectBookManifest(cacheName, saved, options);
    checkCanceled(options?.signal);
    await this.applyBookInspection(inspection);
    return inspection.manifest;
  }

  async checkCompletion(staging, selection, signal) {
    const inspection = await this.inspectBookManifest(staging.cacheName, staging, { restoreMissing: false, signal });
    const stored = inspection.manifest;
    const matches = sameDownload(stored, staging) && sameOfflineSelection(stored, selection);
    const completion = matches ? await this.completionFor(stored, selection, signal) : null;
    checkCanceled(signal);
    await this.applyBookInspection(inspection);
    if (completion?.status === "downloading") {
      checkCanceled(signal);
      await this.writeRecord("staging", stored, signal);
    }
    return completion;
  }

  async completionFor(stored, selection, signal) {
    this.checkConfigUrl(stored, this.configUrl(selection));
    if (stored.status !== "downloading") return stored;
    const ready = { ...stored, status: "ready", mime: audioMimeType(stored.mime), downloadedAt: Date.now() };
    if (!validManifest(ready, "ready")) return stored;
    return this.checkReadyConfig(ready, signal);
  }

  async checkReadyConfig(ready, signal) {
    const url = this.configUrl(ready);
    if (url && !await this.cachedConfigId(ready, url, signal)) return { ...ready, status: "needs-config" };
    return ready;
  }

  async publish(manifest, signal, recoveredStaging, consumeStaging) {
    await withOfflineDeadline(async (currentSignal) => {
      const cache = await this.cacheStorage.open(manifest.cacheName);
      checkCanceled(currentSignal);
      await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
    }, signal, ACTIVE_WRITE_TIMEOUT_MS, new OfflineDownloadError("storage-timeout", "Saving the completed download timed out."));
    return this.commitActive(manifest, { signal, recoveredStaging, consumeStaging });
  }

  checkConfigUrl(manifest, requiredUrl) {
    const url = this.configUrl(manifest);
    if (requiredUrl && url !== requiredUrl) throw new OfflineDownloadError("config", "The manifest lost the required book configuration.");
    return url;
  }

  async cachedConfigId(manifest, url, signal) {
    const response = await readForVerification(() => this.cacheStorage.match(url, { cacheName: manifest.cacheName }), signal);
    if (!response?.ok) return null;
    try {
      const text = await readForVerification((readSignal) => readBookConfigText(response, readSignal), signal);
      checkCanceled(signal);
      return this.validateConfig(manifest, url, text);
    }
    catch (error) {
      if (error.code === "config") return null;
      throw error;
    }
  }

  validateConfig(manifest, url, text) {
    try { return validateOfflineBookConfig(text, url, this.baseUrl, manifest); }
    catch (error) { throw new OfflineDownloadError("config", error.message); }
  }

  async saveConfig(manifest, { url, text }, signal) {
    checkCanceled(signal);
    const cache = await this.cacheStorage.open(manifest.cacheName);
    checkCanceled(signal);
    await cache.put(url, new Response(text, { headers: { "content-type": "application/json" } }));
  }
}
