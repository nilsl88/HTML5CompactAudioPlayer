// The page imports this file and the classic service worker loads it with importScripts.
globalThis.CompactPlayerOfflineManifest = (() => {
  const schemaVersion = 1;

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

  return Object.freeze({ schemaVersion, audioMimeType, validManifest });
})();
