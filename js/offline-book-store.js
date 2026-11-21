import "./offline-manifest.js";
import { validateOfflineBookConfig } from "./book-config.js";
import { OfflineDownloadError } from "./offline-transfer.js";

const { validManifest, metaCache: OFFLINE_META_CACHE, schemaVersion: OFFLINE_SCHEMA_VERSION,
  offlineMetaUrl, offlineManifestUrl, offlineChunkUrl } = globalThis.CompactPlayerOfflineManifest;
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

export function recoverDownloads(manifests, saved, publishedStaging) {
  // After an explicit removal only a later staging download can become the saved book.
  if (saved?.status === "removed") manifests = manifests.filter((manifest) =>
    manifest.status === "downloading" || manifest.downloadId === publishedStaging?.downloadId);
  const newest = (status, published, by) => {
    const candidates = manifests.filter((manifest) => manifest.status === status);
    return candidates.find((manifest) => manifest.cacheName === published?.cacheName)
      || candidates.sort((a, b) => b[by] - a[by])[0] || null;
  };
  const damaged = newest("needs-config", saved, "downloadedAt");
  const publishedNeedsConfig = damaged && damaged.cacheName === saved?.cacheName;
  const active = publishedNeedsConfig ? null : newest("ready", saved, "downloadedAt");
  const staging = newest("downloading", publishedStaging, "createdAt");
  return { active, damaged, staging };
}

export class OfflineBookStore {
  constructor(baseUrl, cacheStorage) {
    this.baseUrl = baseUrl;
    this.cacheStorage = cacheStorage;
    this.bookCachePrefix = OFFLINE_BOOK_CACHE_PREFIX + encodeURIComponent(new URL(baseUrl).pathname) + ":";
  }

  async metaCache() { return this.cacheStorage.open(OFFLINE_META_CACHE); }

  configUrl(manifest) {
    return Array.isArray(manifest?.assets) && manifest.assets.find((asset) => asset?.required)?.url;
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
}
