import "./offline-manifest.js?v=25";
import { readBoundedText } from "./utils.js?v=25";
import { checkCanceled, OfflineDownloadError, withOfflineDeadline } from "./offline-transfer.js?v=25";

const { activeCandidatePrefix, offlineControl, offlineMetaUrl, readActiveState, schemaVersion } = globalThis.CompactPlayerOfflineManifest;
const ACTIVE_WRITE_TIMEOUT_MS = 20_000;

export function createRecordId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function responseJson(response, signal) {
  if (!response) return null;
  const text = await readBoundedText(response, signal, Infinity);
  checkCanceled(signal);
  try { return JSON.parse(text); }
  catch { return null; }
}

export function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

export class OfflineJournal {
  constructor(baseUrl, getCacheStorage) {
    this.baseUrl = baseUrl;
    this.getCacheStorage = getCacheStorage;
    this.cachePrefix = activeCandidatePrefix(baseUrl);
  }

  get control() { return offlineControl(this.baseUrl, this.getCacheStorage()); }

  readActiveState(signal, requireControl = false, snapshot) {
    checkCanceled(signal);
    const storage = this.getCacheStorage();
    return readActiveState(this.baseUrl, async (url, cacheName) => {
      checkCanceled(signal);
      return responseJson(await storage.match(url, { cacheName }), signal);
    }, signal, storage, requireControl, snapshot);
  }

  async readControlSnapshot(signal) {
    try {
      const [active, staging] = await this.control.readMany(["active", "staging"], signal);
      return { active, staging };
    } catch (error) {
      if (signal?.aborted || !["NotSupportedError", "SecurityError", "NotAllowedError"].includes(error?.name)) throw error;
      return null;
    }
  }

  async writeStaging(manifest, signal) {
    checkCanceled(signal);
    try {
      await this.control.write({ staging: manifest ? { cacheName: manifest.cacheName, manifest } : null }, signal);
    } catch (error) {
      if (error?.name === "TimeoutError") throw new OfflineDownloadError("storage-timeout", "Saving the incomplete download record timed out.");
      throw error;
    }
  }

  // The caller holds the installation's write lock while publishing.
  async commitActive(manifest, { signal, resetId, recoveredStaging, consumeStaging = false, cacheRecord = true } = {}) {
    const timeout = new OfflineDownloadError("storage-timeout", "Saving the active download timed out.");
    const target = cacheRecord ? this.cachePrefix + createRecordId() : undefined;
    let opening = false;
    try {
      const { record, previous } = await withOfflineDeadline(async (currentSignal) => {
        const previous = await this.readActiveState(currentSignal, true);
        checkCanceled(currentSignal);
        if (resetId === undefined && previous.resetId && manifest?.cacheName
          && !String(manifest.downloadId).startsWith(previous.resetId + ".")) {
          throw new OfflineDownloadError("conflict", "The download was cleared in another tab.");
        }
        const record = { schemaVersion, revision: previous.revision + 1,
          resetId: resetId ?? previous.resetId, cacheName: manifest?.cacheName, manifest };
        const draft = resetId === undefined ? (recoveredStaging ?? previous.recoveredStaging) : null;
        if (draft && draft.downloadId !== manifest?.downloadId) record.recoveredStaging = draft;
        if (target) {
          opening = true;
          const cache = await this.getCacheStorage().open(target);
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
    const storage = this.getCacheStorage();
    for (const name of names) {
      checkCanceled(signal);
      if (typeof name === "string" && name.startsWith(this.cachePrefix)) await storage.delete(name);
    }
  }
}
