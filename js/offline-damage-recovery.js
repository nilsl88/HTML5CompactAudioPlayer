const RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 30_000;

export class OfflineDamageRecovery {
  constructor({ canRun, inspect, sync }) {
    this.canRun = canRun;
    this.inspect = inspect;
    this.sync = sync;
    this.pending = false;
    this.check = null;
    this.retryTimer = null;
    this.retryDelay = RETRY_DELAY_MS;
  }

  report() {
    this.pending = true;
    this.resume();
  }

  resume(retryImmediately = true) {
    if (!this.canRun() || !this.pending || this.check || this.retryTimer !== null) return;
    let retry = false;
    let lockTimedOut = false;
    let retryLater = false;
    let stale = false;
    this.check = Promise.resolve().then(async () => {
      this.pending = false;
      const outcome = await this.inspect();
      lockTimedOut = outcome === "lock-timeout";
      stale = outcome === "stale";
      retryLater = ["failed", "timed-out", "busy", "stale"].includes(outcome);
      if (outcome !== "applied" && outcome !== "timed-out" && !lockTimedOut) await this.sync();
      const queued = this.pending;
      if (outcome !== "applied") this.pending = true;
      retry = outcome === "applied" || (retryImmediately && (stale || lockTimedOut
        || (queued && ["failed", "timed-out"].includes(outcome))));
    }).catch((error) => {
      this.pending = true;
      retryLater = true;
      console.warn("[CompactAudioPlayer] Could not check the damaged audio chunk.", error);
    }).finally(() => {
      this.check = null;
      if (!this.pending || (!lockTimedOut && !retryLater)) this.retryDelay = RETRY_DELAY_MS;
      if (retry && this.pending) this.resume(!lockTimedOut && !retryLater);
      else if ((lockTimedOut || retryLater) && this.pending) this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.resume(false);
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS);
  }
}
