// The page imports this file and the classic service worker loads it with importScripts.
globalThis.CompactPlayerOfflineManifest = (() => {
  const schemaVersion = 1;
  const journalVersion = 2;
  const versionHeader = "x-compact-player-offline-version";
  const bookHeader = "x-compact-player-offline-book";
  const damageVersionHeader = "x-compact-player-damage-id";
  const networkStatusHeader = "x-compact-player-offline-network-status";
  const metaCache = "compact-player-offline-meta-v1";
  const maxChunkBytes = 8 * 1024 * 1024;
  const chunkStartHeader = "x-compact-player-start";
  const chunkEndHeader = "x-compact-player-end";
  const chunkDigestHeader = "x-compact-player-sha256";
  const controlDbName = "compact-player-offline-control-v1";
  const controlStore = "records";
  const controlTimeoutMs = 3000;

  // Cache versions may contain characters outside the HTTP header character set.
  function versionHeaderValue(version) {
    return encodeURIComponent(JSON.stringify(String(version ?? 1)));
  }

  function bookHeaderValue(episodeId, configBookId) {
    return encodeURIComponent(JSON.stringify([String(episodeId), configBookId ? String(configBookId) : null]));
  }

  function checkResponseVersion(response, expected, identity) {
    const saved = response.headers?.get?.(versionHeader);
    if (saved != null && expected != null && saved !== versionHeaderValue(expected)) {
      throw new Error("The downloaded file belongs to a different book version.");
    }
    if (saved != null && identity?.episodeId && identity?.configBookId) {
      const book = response.headers?.get?.(bookHeader);
      if (book !== bookHeaderValue(identity.episodeId, identity.configBookId)
        && book !== bookHeaderValue(identity.episodeId, null)) {
        throw new Error("The downloaded file belongs to a different book.");
      }
    }
  }

  function audioMimeType(value) {
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) return "";
    const type = value.split(";", 1)[0].trim().toLowerCase();
    return /^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type) ? type : "";
  }

  function strongETag(value) {
    return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? value : "";
  }

  function strongLastModified({ lastModified, responseDate }) {
    const modified = new Date(lastModified);
    const date = new Date(responseDate);
    if (modified.toUTCString() !== lastModified || date.toUTCString() !== responseDate) return "";
    // Allow for clock skew when using a modification time as a strong validator.
    return date - modified >= 60_000 ? lastModified : "";
  }

  function validManifest(value, requiredStatus = "") {
    if (!value || value.schemaVersion !== schemaVersion) return false;
    if (!value.downloadId || !value.cacheName || !value.episodeId || !value.languageCode || !value.sourceId || !value.sourceUrl || !audioMimeType(value.mime)) return false;
    if (!Number.isSafeInteger(value.totalSize) || value.totalSize <= 0 || !Number.isSafeInteger(value.chunkSize) || value.chunkSize <= 0) return false;
    if (value.chunkSize > maxChunkBytes) return false;
    if (!Number.isSafeInteger(value.totalChunks) || value.totalChunks !== Math.ceil(value.totalSize / value.chunkSize)) return false;
    const validIndexes = (indexes) => Array.isArray(indexes) && new Set(indexes).size === indexes.length
      && indexes.every((index) => Number.isInteger(index) && index >= 0 && index < value.totalChunks);
    if (!validIndexes(value.completed) || (value.checksummedChunks !== undefined && !validIndexes(value.checksummedChunks))) return false;
    if (value.chunkRevision !== undefined && (!Number.isSafeInteger(value.chunkRevision) || value.chunkRevision < 1)) return false;
    if (!["downloading", "ready"].includes(value.status) || (requiredStatus && value.status !== requiredStatus)) return false;
    if (value.status === "ready" && value.completed.length !== value.totalChunks) return false;
    if (value.configRevision !== undefined && (typeof value.configRevision !== "string"
      || !/^[a-zA-Z0-9.-]{1,100}$/.test(value.configRevision))) return false;
    return true;
  }

  function offlineMetaUrl(baseUrl, type) {
    return new URL(`__compact_player_offline__/${type}.json`, baseUrl).href;
  }

  function requiredConfigUrl(manifest) {
    return Array.isArray(manifest?.assets) && manifest.assets.find((asset) => asset?.required)?.url;
  }

  function offlineConfigCacheUrl(baseUrl, manifest) {
    if (!manifest.configRevision) return requiredConfigUrl(manifest);
    return offlineMetaUrl(baseUrl, `config/${manifest.configRevision}`);
  }

  function activeCacheName(baseUrl, slot) {
    return `compact-player-offline-active-v1:${encodeURIComponent(new URL(baseUrl).pathname)}:${slot}`;
  }

  function activeCandidatePrefix(baseUrl) {
    return `compact-player-offline-active-v2:${encodeURIComponent(new URL(baseUrl).pathname)}:`;
  }

  function openOfflineControl(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!globalThis.indexedDB) return Promise.reject(new DOMException("Offline control storage is unavailable.", "NotSupportedError"));
    return new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(controlDbName, 1);
      let finished = false;
      const finish = (settle, value) => {
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        settle(value);
      };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject,
        new DOMException("Opening offline control storage timed out.", "TimeoutError")), controlTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      request.onupgradeneeded = () => {
        if (finished) request.transaction.abort();
        else request.result.createObjectStore(controlStore);
      };
      request.onerror = () => { if (!finished) finish(reject, request.error); };
      request.onsuccess = () => {
        if (finished) request.result.close();
        else finish(resolve, request.result);
      };
    });
  }

  async function transactOfflineControl(mode, action, signal) {
    const database = await openOfflineControl(signal);
    try {
      if (signal?.aborted) throw signal.reason;
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(controlStore, mode);
        let request, interrupted, timer;
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const interrupt = (error) => {
          interrupted ??= error;
          try { transaction.abort(); }
          catch (cause) {
            // A completed transaction still reports its actual outcome.
            if (cause.name !== "InvalidStateError") { finish(); reject(cause); }
          }
        };
        const abort = () => interrupt(signal.reason);
        transaction.oncomplete = () => {
          finish();
          resolve(Array.isArray(request) ? request.map((item) => item.result) : request?.result);
        };
        transaction.onabort = () => { finish(); reject(interrupted ?? transaction.error); };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => interrupt(new DOMException("Offline control storage timed out.", "TimeoutError")), controlTimeoutMs);
        try { request = action(transaction.objectStore(controlStore)); }
        catch (error) { interrupt(error); }
      });
    } finally { database.close(); }
  }

  function offlineControl(baseUrl, cacheStorage) {
    const injected = cacheStorage?.offlineControl?.(baseUrl);
    if (injected) return injected;
    const scope = new URL(baseUrl).pathname;
    return {
      read(key, signal) { return transactOfflineControl("readonly", (store) => store.get([scope, key]), signal); },
      readMany(keys, signal) {
        return transactOfflineControl("readonly", (store) => keys.map((key) => store.get([scope, key])), signal);
      },
      write(entries, signal) {
        return transactOfflineControl("readwrite", (store) => {
          for (const [key, value] of Object.entries(entries)) store.put(value, [scope, key]);
        }, signal);
      },
    };
  }

  async function readActiveState(baseUrl, read, signal, cacheStorage, requireControl = false, snapshot) {
    const url = offlineMetaUrl(baseUrl, "active");
    let pointer;
    try { pointer = snapshot ? snapshot.active : await offlineControl(baseUrl, cacheStorage).read("active", signal); }
    catch (error) {
      if (requireControl || signal?.aborted
        || !["NotSupportedError", "SecurityError", "NotAllowedError"].includes(error?.name)) throw error;
      const prefix = activeCandidatePrefix(baseUrl);
      if ((await cacheStorage?.keys?.())?.some((name) => name.startsWith(prefix))) throw error;
    }
    if (signal?.aborted) throw signal.reason;
    if (pointer !== undefined) {
      const { cacheName, previousCacheName, revision, resetId, committedRecord } = pointer ?? {};
      const matchesPointer = (record) => record && record.revision === revision && record.resetId === resetId;
      let current = matchesPointer(committedRecord) ? committedRecord : null;
      if (!current && typeof cacheName === "string" && cacheName.startsWith(activeCandidatePrefix(baseUrl))) {
        const cached = await read(url, cacheName);
        if (signal?.aborted) throw signal.reason;
        if (matchesPointer(cached)) current = cached;
      }
      return { ...current, revision: revision ?? 0, resetId: resetId ?? "", slot: null,
        journalCacheName: cacheName, previousJournalCacheName: previousCacheName };
    }
    const records = await Promise.all([0, 1].map((slot) => read(url, activeCacheName(baseUrl, slot))));
    if (signal?.aborted) throw signal.reason;
    let current = null;
    for (const [slot, record] of records.entries()) {
      if (Number.isSafeInteger(record?.revision) && record.revision > (current?.revision ?? 0)) {
        current = { ...record, slot };
      }
    }
    if (current) return current;
    return { ...await read(url, metaCache), revision: 0, slot: null, resetId: "" };
  }

  function offlineManifestUrl(baseUrl) {
    return offlineMetaUrl(baseUrl, "manifest");
  }

  function offlineChunkUrl(baseUrl, downloadId, index) {
    return new URL(`__compact_player_offline__/chunks/${encodeURIComponent(downloadId)}/${index}`, baseUrl).href;
  }

  function damagedChunkUrl(baseUrl, downloadId, index) {
    return new URL(`__compact_player_offline__/damaged/${encodeURIComponent(downloadId)}/${index}`, baseUrl).href;
  }

  function confirmedChunkUrl(baseUrl, downloadId, index) {
    return damagedChunkUrl(baseUrl, downloadId, index) + "/verified";
  }

  function chunkByteLength(manifest, index) {
    return Math.min(manifest.chunkSize, manifest.totalSize - index * manifest.chunkSize);
  }

  function hasRequiredChunkChecksum(response, manifest, index) {
    return !manifest.checksummedChunks?.includes(index) || /^[a-f0-9]{64}$/.test(response.headers.get(chunkDigestHeader) ?? "");
  }

  function matchesChunkHeaders(response, manifest, index) {
    if (response?.status !== 200 || !response.body) return false;
    const length = chunkByteLength(manifest, index);
    const start = manifest.chunkSize * index;
    const matches = (header, expected) => {
      const actual = response.headers.get(header);
      return actual === null || actual === String(expected);
    };
    return matches("content-length", length) && matches(chunkStartHeader, start) && matches(chunkEndHeader, start + length - 1)
      && hasRequiredChunkChecksum(response, manifest, index);
  }

  function cancelChunkRead(reader) {
    void reader.cancel().catch(() => { /* A failed stream can reject cancellation. */ });
  }

  async function readExactChunk(body, expected, signal, bytes) {
    if (!body) return false;
    if (signal?.aborted) {
      cancelChunkRead(body);
      throw signal.reason;
    }
    const reader = body.getReader();
    let received = 0;
    let ended = false;
    const cancel = () => {
      if (ended) return;
      ended = true;
      cancelChunkRead(reader);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal?.aborted) throw signal.reason;
        if (done) {
          ended = true;
          return received === expected;
        }
        if (value.byteLength > expected - received) return false;
        bytes?.set(value, received);
        received += value.byteLength;
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  }

  async function chunkDigest(bytes, signal) {
    if (signal?.aborted) throw signal.reason;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    if (signal?.aborted) throw signal.reason;
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function readVerifiedChunk(response, expected, signal, bytes) {
    const digest = response.headers.get(chunkDigestHeader);
    if (digest !== null) bytes ??= new Uint8Array(expected);
    if (!await readExactChunk(response.body, expected, signal, bytes)) return false;
    return digest === null || digest === await chunkDigest(bytes, signal);
  }

  return Object.freeze({
    schemaVersion, journalVersion, audioMimeType, strongETag, strongLastModified, validManifest, chunkByteLength,
    maxChunkBytes, chunkReadTimeoutMs: 3000, readExactChunk, matchesChunkHeaders, chunkStartHeader, chunkEndHeader,
    chunkDigest, chunkDigestHeader, readVerifiedChunk, hasRequiredChunkChecksum,
    metaCache, activeCacheName, activeCandidatePrefix, offlineControl, readActiveState,
    downloadHeader: "x-compact-player-download",
    versionHeader, versionHeaderValue, bookHeader, bookHeaderValue, networkStatusHeader, checkResponseVersion,
    offlineMetaUrl, offlineManifestUrl, offlineChunkUrl, requiredConfigUrl, offlineConfigCacheUrl,
    damagedChunkUrl, confirmedChunkUrl, damageVersionHeader,
  });
})();
