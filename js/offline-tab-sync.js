import { withOfflineLock } from "./offline-lock.js?v=25";
import { checkCanceled, OfflineDownloadError, withOfflineDeadline } from "./offline-transfer.js?v=25";

const PUBLISHED_DOWNLOAD_CHANGED = "published-download-changed";
const SYNC_TIMEOUT_MS = 3000;
const LOCK_RECHECK_MS = 3000;

export class OfflineTabSync {
  constructor({ name, navigatorObject, canRead, waitForPublished, isLocallyBusy, readPublished, getDraft, inspectDraft, onSync }) {
    Object.assign(this, { name, navigatorObject, canRead, waitForPublished, isLocallyBusy, readPublished, getDraft, inspectDraft, onSync });
    this.channel = null;
    this.job = null;
    this.deferred = false;
    this.lockStatus = "free";
    this.retry = null;
  }

  get lockBusy() { return this.lockStatus === "busy"; }
  get lockUnavailable() { return this.lockStatus === "unavailable"; }

  listen(BroadcastChannel) {
    if (this.channel || !this.canRead() || typeof BroadcastChannel !== "function") return;
    try {
      this.channel = new BroadcastChannel(this.name);
      this.channel.addEventListener("message", ({ data }) => {
        if (data === PUBLISHED_DOWNLOAD_CHANGED) void this.request(true, { changed: true });
      });
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not listen for offline changes in other tabs.", error);
    }
  }

  announce() {
    try { this.channel?.postMessage(PUBLISHED_DOWNLOAD_CHANGED); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not tell other tabs about the offline change.", error); }
  }

  request(syncStaging = true, { changed = false } = {}) {
    if (!this.canRead()) return Promise.resolve();
    if (this.job) {
      if (changed || (syncStaging && !this.job.syncStaging)) this.job.next = Boolean(this.job.next || syncStaging);
      return this.job.promise;
    }
    const job = { syncStaging, next: null };
    job.promise = Promise.resolve().then(async () => {
      try {
        do {
          await this.sync(job.syncStaging);
          job.syncStaging = job.next;
          job.next = null;
        } while (job.syncStaging !== null);
      } finally {
        this.job = null;
      }
    });
    this.job = job;
    return job.promise;
  }

  deferIfBusy() {
    if (!this.isLocallyBusy()) return false;
    this.deferred = true;
    return true;
  }

  operationSettled() {
    if (!this.deferred || this.isLocallyBusy()) return;
    this.deferred = false;
    void this.request(true, { changed: true });
  }

  async checkLock(signal) {
    try {
      return await withOfflineLock(this.navigatorObject, this.name, () => "free", () => "busy");
    } catch (error) {
      checkCanceled(signal);
      if (this.lockStatus === "free") console.warn("[CompactAudioPlayer] Could not check the offline write lock.", error);
      return ["SecurityError", "NotAllowedError", "NotSupportedError"].includes(error?.name) ? "unavailable" : "busy";
    }
  }

  async sync(syncStaging) {
    const timeout = new OfflineDownloadError("storage-read-timeout", "Checking the published download timed out.");
    try {
      await withOfflineDeadline(async (signal) => {
        await this.waitForPublished();
        checkCanceled(signal);
        for (let attempt = 0; attempt < 2; attempt++) {
          if (this.deferIfBusy()) return;
          const read = await this.readPublished(syncStaging, signal);
          checkCanceled(signal);
          if (!read) continue;
          if (this.deferIfBusy()) return;

          const draft = read.records.staging;
          let lock = draft ? await this.checkLock(signal) : "free";
          checkCanceled(signal);
          if (this.deferIfBusy()) return;
          const completion = draft && lock === "free" ? await this.inspectDraft(draft, signal) : null;
          if (completion && !signal.aborted) lock = await this.checkLock(signal);
          checkCanceled(signal);
          if (!await read.isCurrent()) continue;
          checkCanceled(signal);
          if (this.deferIfBusy()) return;
          if (syncStaging) this.updateLockStatus(lock);
          this.onSync(read.records, syncStaging ? { completion: lock === "free" ? completion : null } : null);
          return;
        }
      }, undefined, SYNC_TIMEOUT_MS, timeout);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not sync the published offline book.", error);
      if (syncStaging && error?.code === "storage-read-timeout") await this.sync(false);
    }
  }

  updateLockStatus(status) {
    this.lockStatus = status;
    clearTimeout(this.retry);
    this.retry = null;
    if (this.lockBusy) {
      this.retry = setTimeout(async () => {
        this.retry = null;
        await this.request(true, { changed: true });
        if (this.lockBusy && this.getDraft() && this.retry === null) this.updateLockStatus("busy");
      }, LOCK_RECHECK_MS);
      this.retry?.unref?.();
    }
  }
}
