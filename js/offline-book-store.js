import "./offline-manifest.js?v=25";
import "./bounded-response.js?v=25";
import { OfflineBookInspector, repairedManifest, readForVerification, sameDownload, useRecordedMetadata } from "./offline-inventory.js?v=25";
export { hasAllChunks } from "./offline-inventory.js?v=25";
import { readBookConfigText } from "./config.js?v=25";
import { OfflineJournal, createRecordId, jsonResponse, responseJson } from "./offline-journal.js?v=25";
import { sameOfflineSelection, validateOfflineBookConfig } from "./offline-selection.js?v=25";
export { sameOfflineSelection, manifestMatchesSelection } from "./offline-selection.js?v=25";
import { OFFLINE_CHUNK_SIZE, OfflineDownloadError, checkCanceled, withOfflineDeadline } from "./offline-transfer.js?v=25";

const { validManifest, audioMimeType, metaCache: OFFLINE_META_CACHE, schemaVersion: OFFLINE_SCHEMA_VERSION,
  offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, damageVersionHeader, chunkByteLength,
  requiredConfigUrl, offlineConfigCacheUrl,
  chunkReadTimeoutMs, readExactChunk, matchesChunkHeaders } = globalThis.CompactPlayerOfflineManifest;
const { cancelResponseBody } = globalThis.CompactPlayerResponse;
export const OFFLINE_BOOK_CACHE_PREFIX = "compact-player-offline-book-v2-";
const LEGACY_BOOK_CACHE_PREFIX = "compact-player-offline-book-v1-";
const STAGING_META_CACHE_PREFIX = "compact-player-offline-staging-v1:";
const ACTIVE_WRITE_TIMEOUT_MS = 20_000;
const RECLAIM_CHECK_TIMEOUT_MS = 20_000;
const REPAIR_WRITE_TIMEOUT_MS = 3000;

export function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.code === 22 || error?.code === 1014;
}

export class OfflineBookStore {
  constructor(baseUrl, cacheStorage) {
    this.baseUrl = baseUrl;
    this.cacheStorage = cacheStorage;
    this.journal = new OfflineJournal(baseUrl, () => this.cacheStorage);
    const scope = encodeURIComponent(new URL(baseUrl).pathname);
    this.bookCachePrefix = OFFLINE_BOOK_CACHE_PREFIX + scope + ":";
    this.stagingMetaCacheName = STAGING_META_CACHE_PREFIX + scope;
    this.reportedChunks = new Map();
    this.damageVersions = new Map();
    this.damageRevision = 0;
    this.inspector = new OfflineBookInspector(baseUrl, {
      match: (cacheName, url, signal) => this.matchCachedResponse(cacheName, url, signal),
      matchesCacheName: (name, id) => name === this.bookCachePrefix + id || name === LEGACY_BOOK_CACHE_PREFIX + id,
      checkReadyConfig: (manifest, signal) => this.checkReadyConfig(manifest, signal),
      snapshotDamageVersions: () => new Map(this.damageVersions),
      hasDamageReport: (id, index) => this.reportedChunks.get(id)?.has(index),
    });
  }

  reportDamagedChunk(downloadId, index) {
    this.damageRevision++;
    this.damageVersions.set(downloadId, this.damageRevision);
    if (!this.reportedChunks.has(downloadId)) this.reportedChunks.set(downloadId, new Set());
    this.reportedChunks.get(downloadId).add(index);
  }

  forgetDamage(downloadId) {
    if (this.reportedChunks.delete(downloadId)) {
      this.damageVersions.delete(downloadId);
      this.damageRevision++;
    }
  }

  forgetUnreferencedDamage(downloadIds, revision) {
    if (revision !== this.damageRevision) return;
    const retained = new Set(downloadIds);
    for (const downloadId of this.reportedChunks.keys()) {
      if (!retained.has(downloadId)) this.forgetDamage(downloadId);
    }
  }

  setDamageEpoch(resetId) {
    if (!resetId) return;
    for (const downloadId of this.reportedChunks.keys()) {
      if (!String(downloadId).startsWith(resetId + ".")) this.forgetDamage(downloadId);
    }
  }

  newResetId() { return createRecordId(); }

  get control() { return this.journal.control; }

  stagingManifest(selection, preflight, resetId) {
    const id = createRecordId();
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
    return requiredConfigUrl(manifest);
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

  async readStagingState(includeUnpublished, signal, activeState, snapshot) {
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
      return validManifest(local, "downloading") && sameDownload(local, manifest) ? useRecordedMetadata(local, manifest) : manifest;
    };
    const readCandidate = async (cacheName) => {
      checkCanceled(signal);
      return verifyCandidate(await responseJson(await this.cacheStorage.match(key, { cacheName }), signal));
    };
    const current = snapshot ? snapshot.staging : await this.control.read("staging", signal);
    if (current !== undefined) {
      return { manifest: await verifyCandidate(current), authoritative: true };
    }
    const staged = await readCandidate(this.stagingMetaCacheName) ?? await readCandidate(OFFLINE_META_CACHE);
    if (staged) return { manifest: staged, authoritative: false };
    activeState ??= await this.readActiveState(signal);
    const manifest = activeState.recoveredStaging;
    return { manifest: await verifyCandidate({ cacheName: manifest?.cacheName, manifest }), authoritative: false };
  }

  readActiveState(signal, requireControl = false, snapshot) {
    return this.journal.readActiveState(signal, requireControl, snapshot);
  }

  readControlSnapshot(signal) { return this.journal.readControlSnapshot(signal); }

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

  writeRecord(type, manifest, signal) {
    if (type === "active") return this.commitActive(manifest, { signal });
    return this.journal.writeStaging(manifest, signal);
  }

  commitActive(manifest, options) { return this.journal.commitActive(manifest, options); }

  deletePublicationCaches(names, signal) { return this.journal.deletePublicationCaches(names, signal); }

  async reconcileRecord(type, previous, verified) {
    if (JSON.stringify(previous) !== JSON.stringify(verified)) await this.writeRecord(type, verified);
  }

  async listBookCaches(saved, publishedStaging, signal) {
    const bookNames = [];
    const journalCandidates = [];
    const names = await this.cacheStorage.keys();
    checkCanceled(signal);
    for (const name of names) {
      checkCanceled(signal);
      if (name.startsWith(this.journal.cachePrefix)) journalCandidates.push(name);
      else if (await this.ownsBookCache(name, name === publishedStaging?.cacheName ? publishedStaging : saved, signal)) bookNames.push(name);
    }
    return { bookNames, journalCandidates };
  }

  belongsToEpoch(cacheName, resetId) {
    return !resetId || cacheName.startsWith(this.bookCachePrefix + resetId + ".");
  }

  async inspectionIsCurrent({ inspections }, signal) {
    checkCanceled(signal);
    const damageUnchanged = () => inspections.every(({ downloadId, damageVersion }) => this.damageVersions.get(downloadId) === damageVersion);
    if (!damageUnchanged()) return false;
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
    return unchanged.every(Boolean) && damageUnchanged();
  }

  async hasCachedChunks(manifest, signal) {
    for (const index of manifest.completed) {
      checkCanceled(signal);
      const url = offlineChunkUrl(this.baseUrl, manifest.downloadId, index);
      const chunk = await this.cacheStorage.match(url, { cacheName: manifest.cacheName });
      cancelResponseBody(chunk?.body);
      checkCanceled(signal);
      if (!matchesChunkHeaders(chunk, manifest, index)) return false;
    }
    return true;
  }

  async applyInspection({ inspections }, signal) {
    const timeout = new OfflineDownloadError("storage-write-timeout", "Saving offline repairs timed out.");
    await withOfflineDeadline(async (writeSignal) => {
      for (const { cacheName, repair, repairBase, confirmedChunks, downloadId, damageVersion } of inspections) {
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
          if (damageVersion !== this.damageVersions.get(downloadId)) break;
          if (url) await cache.put(url, new Response("", { headers: { [damageVersionHeader]: version } }));
          checkCanceled(writeSignal);
          if (damage && damageVersion === this.damageVersions.get(downloadId)) {
            const reported = this.reportedChunks.get(damage.downloadId);
            reported?.delete(damage.index);
            if (reported?.size === 0) {
              this.reportedChunks.delete(damage.downloadId);
              this.damageVersions.delete(damage.downloadId);
            }
          }
        }
      }
    }, signal, REPAIR_WRITE_TIMEOUT_MS, timeout);
  }

  inspectBookManifest(cacheName, saved, options) {
    return this.inspector.inspectBookManifest(cacheName, saved, options);
  }

  async readBookManifest(cacheName, saved, options) {
    const inspection = await this.inspectBookManifest(cacheName, saved, options);
    checkCanceled(options?.signal);
    await this.applyInspection({ inspections: [inspection] }, options?.signal);
    return inspection.manifest;
  }

  async checkCompletion(staging, selection, signal) {
    const inspection = await this.inspectBookManifest(staging.cacheName, staging, { restoreMissing: false, signal });
    const stored = inspection.manifest;
    const matches = sameDownload(stored, staging) && sameOfflineSelection(stored, selection);
    const completion = matches ? await this.completionFor(stored, selection, signal) : null;
    checkCanceled(signal);
    await this.applyInspection({ inspections: [inspection] }, signal);
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

  async matchCachedResponse(cacheName, url, signal) {
    let response;
    try {
      await readForVerification(async (readSignal) => {
        const cached = await this.cacheStorage.match(url, { cacheName });
        if (readSignal?.aborted) {
          cancelResponseBody(cached?.body);
          checkCanceled(readSignal);
        }
        response = cached;
      }, signal);
      checkCanceled(signal);
      return response;
    } catch (error) {
      cancelResponseBody(response?.body);
      throw error;
    }
  }

  async cachedConfigId(manifest, url, signal) {
    const assetUrl = offlineConfigCacheUrl(this.baseUrl, manifest);
    const response = await this.matchCachedResponse(manifest.cacheName, assetUrl, signal);
    if (signal?.aborted || !response?.ok) {
      cancelResponseBody(response?.body);
      checkCanceled(signal);
      return null;
    }
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

  async saveConfig(manifest, { text }, signal) {
    checkCanceled(signal);
    const cache = await this.cacheStorage.open(manifest.cacheName);
    checkCanceled(signal);
    // Drafts with audio survive a timeout, so each repair needs its own cache key.
    const revision = manifest.completed.length || manifest.configRevision ? createRecordId() : undefined;
    const stored = revision ? { ...manifest, configRevision: revision } : manifest;
    const key = offlineConfigCacheUrl(this.baseUrl, stored);
    await cache.put(key, new Response(text, { headers: { "content-type": "application/json" } }));
    if (revision && signal?.aborted) {
      void cache.delete(key).catch((error) => console.warn("[CompactAudioPlayer] Could not remove an interrupted configuration write.", error));
    }
    checkCanceled(signal);
    return stored;
  }
}
