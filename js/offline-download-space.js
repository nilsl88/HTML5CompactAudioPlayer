import { manifestMatchesSelection } from "./offline-selection.js?v=25";
import { checkCanceled, OfflineDownloadError, sameAudioRevision, withOfflineDeadline } from "./offline-transfer.js?v=25";
import "./offline-manifest.js?v=25";

const { chunkByteLength, validManifest } = globalThis.CompactPlayerOfflineManifest;
const ESTIMATE_TIMEOUT_MS = 750;
const MIN_RESERVE_BYTES = 16 * 1024 ** 2;

export function completedBytes(manifest) {
  if (!validManifest(manifest)) return 0;
  return manifest.completed.reduce((total, index) => total + chunkByteLength(manifest, index), 0);
}

export function canResumeTransfer(staging, selection, representation) {
  return manifestMatchesSelection(staging, selection) && sameAudioRevision(staging, representation);
}

export class OfflineDownloadSpace {
  constructor({ getStorage, canReclaimBytes }) {
    this.getStorage = getStorage;
    this.canReclaimBytes = canReclaimBytes;
  }

  async estimateAvailableBytes(signal) {
    try {
      const estimate = await withOfflineDeadline(() => this.getStorage()?.estimate?.(), signal, ESTIMATE_TIMEOUT_MS);
      if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) return Math.max(0, estimate.quota - estimate.usage);
    } catch {
      checkCanceled(signal);
    }
    return null;
  }

  async inspect(selection, representation, staging, signal) {
    const canResume = canResumeTransfer(staging, selection, representation);
    const remainingBytes = representation.totalSize - (canResume ? completedBytes(staging) : 0);
    const availableBytes = await this.estimateAvailableBytes(signal);
    const reserve = Math.max(MIN_RESERVE_BYTES, Math.ceil(representation.totalSize * .05));
    return { remainingBytes, availableBytes, requiredBytes: remainingBytes + reserve, canResume };
  }

  async checkBeforeWrite(selection, preflight, { staging, saved }, signal) {
    const space = await this.inspect(selection, preflight, staging, signal);
    const availableForAssets = space.availableBytes == null ? Infinity : Math.max(0, space.availableBytes - space.requiredBytes);
    const current = { ...preflight, ...space, availableForAssets, reclaimStaging: false };
    if (current.availableBytes == null || current.availableBytes >= current.requiredBytes) return current;
    const deficit = current.requiredBytes - current.availableBytes;
    const replacing = !current.canResume && staging && staging.cacheName !== saved?.cacheName;
    const fits = replacing && completedBytes(staging) >= deficit && await this.canReclaimBytes(staging, deficit, signal);
    checkCanceled(signal);
    if (!fits) throw new OfflineDownloadError("quota", "Insufficient browser storage.");
    return { ...current, reclaimStaging: true };
  }

  async requestPersistence() {
    try {
      return await this.getStorage()?.persist?.() ?? null;
    } catch { return false; }
  }
}
