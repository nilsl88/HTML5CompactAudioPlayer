// The page imports this file and the classic service worker loads it with importScripts.
globalThis.CompactPlayerOfflineManifest = (() => {
  const schemaVersion = 1;
  const versionHeader = "x-compact-player-offline-version";

  // Cache versions may contain characters outside the HTTP header character set.
  function versionHeaderValue(version) {
    return encodeURIComponent(JSON.stringify(String(version ?? 1)));
  }

  function checkResponseVersion(response, expected) {
    const saved = response.headers?.get?.(versionHeader);
    if (saved != null && expected != null && saved !== versionHeaderValue(expected)) {
      throw new Error("The downloaded file belongs to a different book version.");
    }
  }

  function audioMimeType(value) {
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) return "";
    const type = value.split(";", 1)[0].trim().toLowerCase();
    return /^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "";
  }

  function validManifest(value, requiredStatus = "") {
    if (!value || value.schemaVersion !== schemaVersion) return false;
    if (!value.downloadId || !value.cacheName || !value.episodeId || !value.languageCode || !value.sourceId || !value.sourceUrl || !audioMimeType(value.mime)) return false;
    if (!Number.isSafeInteger(value.totalSize) || value.totalSize <= 0 || !Number.isSafeInteger(value.chunkSize) || value.chunkSize <= 0) return false;
    if (!Number.isSafeInteger(value.totalChunks) || value.totalChunks !== Math.ceil(value.totalSize / value.chunkSize)) return false;
    if (!Array.isArray(value.completed) || new Set(value.completed).size !== value.completed.length
      || value.completed.some((index) => !Number.isInteger(index) || index < 0 || index >= value.totalChunks)) return false;
    if (!["downloading", "ready"].includes(value.status) || (requiredStatus && value.status !== requiredStatus)) return false;
    if (value.status === "ready" && value.completed.length !== value.totalChunks) return false;
    return true;
  }

  function offlineMetaUrl(baseUrl, type) {
    return new URL(`__compact_player_offline__/${type}.json`, baseUrl).href;
  }

  function offlineManifestUrl(baseUrl) {
    return offlineMetaUrl(baseUrl, "manifest");
  }

  function offlineChunkUrl(baseUrl, downloadId, index) {
    return new URL(`__compact_player_offline__/chunks/${encodeURIComponent(downloadId)}/${index}`, baseUrl).href;
  }

  function chunkByteLength(manifest, index) {
    return Math.min(manifest.chunkSize, manifest.totalSize - index * manifest.chunkSize);
  }

  return Object.freeze({
    schemaVersion, audioMimeType, validManifest, chunkByteLength,
    metaCache: "compact-player-offline-meta-v1",
    downloadHeader: "x-compact-player-download",
    versionHeader, versionHeaderValue, checkResponseVersion,
    offlineMetaUrl, offlineManifestUrl, offlineChunkUrl,
  });
})();
