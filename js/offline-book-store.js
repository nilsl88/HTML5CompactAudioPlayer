import "./offline-manifest.js";
import { sameOfflineSelection, manifestMatchesSelection, validateOfflineBookConfig } from "./offline-selection.js";
export { sameOfflineSelection, manifestMatchesSelection } from "./offline-selection.js";
import { OFFLINE_CHUNK_SIZE, OfflineDownloadError, sameAudioRevision, checkCanceled } from "./offline-transfer.js";

const { validManifest, audioMimeType, metaCache: OFFLINE_META_CACHE, schemaVersion: OFFLINE_SCHEMA_VERSION,
  offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, chunkByteLength } = globalThis.CompactPlayerOfflineManifest;
export const OFFLINE_BOOK_CACHE_PREFIX = "compact-player-offline-book-v2-";
const LEGACY_BOOK_CACHE_PREFIX = "compact-player-offline-book-v1-";

export async function responseJson(response) {
  if (!response) return null;
  const text = await response.text();
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

async function hasChunkLength(response, expected) {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes === expected;
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
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
    this.bookCachePrefix = OFFLINE_BOOK_CACHE_PREFIX + encodeURIComponent(new URL(baseUrl).pathname) + ":";
  }

  stagingManifest(selection, preflight) {
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
      createdAt: Date.now(),
      downloadedAt: 0,
    };
    if (!validManifest(manifest, "downloading")) throw new OfflineDownloadError("manifest", "Invalid offline download manifest.");
    return manifest;
  }

  async openStagingFiles(manifest) {
    const cache = await this.cacheStorage.open(manifest.cacheName);
    return {
      writeManifest: (current) => cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(current)),
      writeChunk: (index, response) => cache.put(offlineChunkUrl(this.baseUrl, manifest.downloadId, index), response),
      writeAsset: (url, response) => cache.put(url, response),
    };
  }

  async clearDownloads() {
    const saved = await this.readRecord("active", true);
    const partial = await this.readRecord("staging", true);
    for (const name of await this.ownedBookCacheNames(saved, partial)) await this.cacheStorage.delete(name);
    await this.writeRecord("active", null);
    await this.writeRecord("staging", null);
  }

  async metaCache() { return this.cacheStorage.open(OFFLINE_META_CACHE); }

  configUrl(manifest) {
    return Array.isArray(manifest?.assets) && manifest.assets.find((asset) => asset?.required)?.url;
  }

  async ownsBookCache(name, published) {
    if (typeof name !== "string") return false;
    if (name.startsWith(this.bookCachePrefix)) return true;
    if (!name.startsWith(LEGACY_BOOK_CACHE_PREFIX)) return false;
    // Legacy names contain only a download ID. The manifest URL identifies the installation.
    if (await this.cacheStorage.match(offlineManifestUrl(this.baseUrl), { cacheName: name })) return true;
    if (name !== published?.cacheName || name !== LEGACY_BOOK_CACHE_PREFIX + published.downloadId) return false;
    for (const index of published.completed || []) {
      if (await this.cacheStorage.match(offlineChunkUrl(this.baseUrl, published.downloadId, index), { cacheName: name })) return true;
    }
    return false;
  }

  async ownedBookCacheNames(...records) {
    const owned = [];
    for (const name of await this.cacheStorage.keys()) {
      if (await this.ownsBookCache(name, records.find((record) => record?.cacheName === name))) owned.push(name);
    }
    return owned;
  }

  async deleteOwnedBookCache(name, published) {
    if (await this.ownsBookCache(name, published)) await this.cacheStorage.delete(name);
  }

  async canReclaimBytes(staging, needed, signal) {
    if (!staging || !await this.ownsBookCache(staging.cacheName, staging)) return false;
    for (const index of staging.completed) {
      checkCanceled(signal);
      const key = offlineChunkUrl(this.baseUrl, staging.downloadId, index);
      const response = await this.cacheStorage.match(key, { cacheName: staging.cacheName });
      if (response?.ok) needed -= (await response.blob()).size;
      if (needed <= 0) return true;
    }
    return false;
  }

  async removePublishedBook(saved, staging) {
    let marked = false;
    try {
      await this.writeRecord("active", { status: "removed", downloadId: saved.downloadId });
      marked = true;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // Reclaim older copies first so recovery cannot select one if the removal is interrupted.
      for (const name of await this.ownedBookCacheNames(saved)) {
        if (name !== saved.cacheName && name !== staging?.cacheName) await this.deleteOwnedBookCache(name);
      }
    }
    await this.deleteOwnedBookCache(saved.cacheName, saved);
    if (!marked) await this.writeRecord("active", null);
  }

  async removeStaging(manifest) {
    if (!manifest || !await this.ownsBookCache(manifest.cacheName, manifest)) return this.writeRecord("staging", null);
    const cache = await this.cacheStorage.open(manifest.cacheName);
    try {
      await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse({ status: "removed", downloadId: manifest.downloadId }));
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      // A stale central record cannot restore a cache that no longer exists.
      await this.cacheStorage.delete(manifest.cacheName);
      return this.writeRecord("staging", null);
    }
    await this.writeRecord("staging", null);
    await this.cacheStorage.delete(manifest.cacheName);
  }

  async readRecord(type, includeUnpublished = false) {
    const response = await this.cacheStorage.match(offlineMetaUrl(this.baseUrl, type), { cacheName: OFFLINE_META_CACHE });
    const record = await responseJson(response);
    if (type === "active" && includeUnpublished) {
      const saved = record?.manifest;
      if (saved?.status === "removed" && typeof saved.downloadId === "string" && saved.downloadId) return saved;
      if (saved?.status === "needs-config" && saved.cacheName === record.cacheName
        && validManifest({ ...saved, status: "ready" }, "ready")) return saved;
      if (saved?.status === "needs-audio" && saved.cacheName === record.cacheName
        && validManifest({ ...saved, status: "downloading" })) return saved;
    }
    const status = type === "active" ? "ready" : "downloading";
    if (!validManifest(record?.manifest, status) || record.cacheName !== record.manifest.cacheName) return null;
    if (type === "staging") {
      // Cancellation can reach the book cache before the staging record is cleared.
      const local = await responseJson(await this.cacheStorage.match(offlineManifestUrl(this.baseUrl), { cacheName: record.cacheName }));
      if (local?.status === "removed" || (!local && !includeUnpublished)) return null;
    }
    return record.manifest;
  }

  async writeRecord(type, manifest) {
    const key = offlineMetaUrl(this.baseUrl, type);
    if (!manifest && !await this.cacheStorage.match(key, { cacheName: OFFLINE_META_CACHE })) return;
    const cache = await this.metaCache();
    if (manifest) await cache.put(key, jsonResponse({ schemaVersion: OFFLINE_SCHEMA_VERSION, cacheName: manifest.cacheName, manifest }));
    else await cache.delete(key);
  }

  async reconcileRecord(type, previous, verified) {
    if (JSON.stringify(previous) !== JSON.stringify(verified)) await this.writeRecord(type, verified);
  }

  async inspectDownloads(saved, publishedStaging) {
    const bookNames = await this.ownedBookCacheNames(saved, publishedStaging);
    const manifests = await Promise.all(bookNames.map((name) =>
      this.readBookManifest(name, name === publishedStaging?.cacheName ? publishedStaging : saved)));
    const { active, staging, damaged } = recoverDownloads(manifests.filter(Boolean), saved, publishedStaging);
    const completion = hasAllChunks(staging) && sameDownload(staging, publishedStaging)
      ? await this.completionFor(staging, publishedStaging) : null;
    return { bookNames, active, staging, damaged, completion };
  }

  async restoreLocalManifest(cache, cacheName, saved) {
    if (!saved || saved.cacheName !== cacheName) return null;
    if (![this.bookCachePrefix, LEGACY_BOOK_CACHE_PREFIX].some((prefix) => cacheName === prefix + saved.downloadId)) return null;
    let manifest = saved;
    if (saved.status === "needs-config") manifest = { ...saved, status: "ready" };
    if (saved.status === "needs-audio") manifest = { ...saved, status: "downloading" };
    if (!validManifest(manifest)) return null;
    const local = await this.verifyBookChunks(cache, manifest, true, saved.status);
    if (!local) return null;
    const verified = local.status === "ready" ? await this.checkReadyConfig(local) : local;
    await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(local));
    return verified;
  }

  async checkChunks(cache, manifest, verifySize) {
    const completed = [];
    for (const index of manifest.completed) {
      const chunk = await cache.match(offlineChunkUrl(this.baseUrl, manifest.downloadId, index));
      if (!chunk?.ok) continue;
      const expected = chunkByteLength(manifest, index);
      const length = chunk.headers.get("content-length");
      if (length != null && Number(length) !== expected) continue;
      if (!verifySize || await hasChunkLength(chunk, expected)) completed.push(index);
    }
    return completed;
  }

  async verifyBookChunks(cache, manifest, verifySize, publishedStatus) {
    let completed = await this.checkChunks(cache, manifest, verifySize);
    if (completed.length === manifest.completed.length) return manifest;
    if (manifest.status === "ready" && publishedStatus !== "downloading") {
      if (!publishedStatus || !completed.length) return null;
      // Check the surviving bytes before using the published book as a partial download.
      if (!verifySize) completed = await this.checkChunks(cache, { ...manifest, completed }, true);
      if (!completed.length) return null;
    }
    return { ...manifest, status: "downloading", completed };
  }

  async readBookManifest(cacheName, saved, { restoreMissing = true } = {}) {
    const cache = await this.cacheStorage.open(cacheName);
    let manifest = await responseJson(await cache.match(offlineManifestUrl(this.baseUrl)));
    if (!validManifest(manifest)) {
      if (!restoreMissing || manifest?.status === "removed" || (manifest?.downloadId && manifest.downloadId !== saved?.downloadId)
        || (manifest?.cacheName && manifest.cacheName !== cacheName)) return null;
      return this.restoreLocalManifest(cache, cacheName, saved);
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
    manifest = await this.verifyBookChunks(cache, manifest, verifySize, publishedStatus);
    if (!manifest) return null;
    if (manifest !== local) await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
    // Both startup and Resume pass an unpublished replacement through completionFor().
    if (publishedStatus === "downloading" && manifest.status === "ready") return { ...manifest, status: "downloading" };
    return manifest.status === "ready" ? this.checkReadyConfig(manifest) : manifest;
  }

  async checkCompletion(staging, selection) {
    const stored = await this.readBookManifest(staging.cacheName, staging, { restoreMissing: false });
    if (!sameDownload(stored, staging) || !sameOfflineSelection(stored, selection)) return null;
    return this.completionFor(stored, selection);
  }

  async completionFor(stored, selection) {
    this.checkConfigUrl(stored, this.configUrl(selection));
    if (stored.status !== "downloading") return stored;
    const ready = { ...stored, status: "ready", mime: audioMimeType(stored.mime), downloadedAt: Date.now() };
    if (!validManifest(ready, "ready")) {
      await this.writeRecord("staging", stored);
      return stored;
    }
    return this.checkReadyConfig(ready);
  }

  async checkReadyConfig(ready) {
    const url = this.configUrl(ready);
    if (url && !await this.cachedConfigId(ready, url)) return { ...ready, status: "needs-config" };
    return ready;
  }

  async publish(manifest) {
    const cache = await this.cacheStorage.open(manifest.cacheName);
    await cache.put(offlineManifestUrl(this.baseUrl), jsonResponse(manifest));
    await this.writeRecord("active", manifest);
  }

  checkConfigUrl(manifest, requiredUrl) {
    const url = this.configUrl(manifest);
    if (requiredUrl && url !== requiredUrl) throw new OfflineDownloadError("config", "The manifest lost the required book configuration.");
    return url;
  }

  async cachedConfigId(manifest, url) {
    const response = await this.cacheStorage.match(url, { cacheName: manifest.cacheName });
    if (!response?.ok) return null;
    const text = await response.text();
    try { return this.validateConfig(manifest, url, text); }
    catch (error) {
      if (error.code === "config") return null;
      throw error;
    }
  }

  validateConfig(manifest, url, text) {
    try { return validateOfflineBookConfig(text, url, this.baseUrl, manifest); }
    catch (error) { throw new OfflineDownloadError("config", error.message); }
  }

  async saveConfig(manifest, url, text) {
    const id = this.validateConfig(manifest, url, text);
    const cache = await this.cacheStorage.open(manifest.cacheName);
    await cache.put(url, new Response(text, { headers: { "content-type": "application/json" } }));
    return id;
  }
}
