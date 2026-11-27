import "./offline-manifest.js?v=25";
import { withOfflineDeadline } from "./offline-transfer.js?v=25";

const { offlineMetaUrl, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue } = globalThis.CompactPlayerOfflineManifest;
const PROBE_TIMEOUT_MS = 750;
const PROBE_RETRY_DELAY_MS = 1000;
const PROBE_FAILURE_TTL_MS = 5000;

export class OfflineWorkerRoutes {
  constructor({ baseUrl, fetchImpl, isOnline, connect, readControl, onChange = () => {} }) {
    Object.assign(this, { baseUrl, fetchImpl, isOnline, connect, readControl, onChange });
    this.probe = null;
  }

  prepare(download) {
    const ready = this.connect();
    const { controller } = this.readControl();
    const offline = !this.isOnline();
    const previous = this.probe;
    if (controller && previous?.controller === controller && previous.id === download?.downloadId
      && previous.offline === offline && (previous.retryAfter == null || Date.now() < previous.retryAfter)) return previous.promise;

    clearTimeout(previous?.retryTimer);
    this.probe = null;
    if (!controller) return Promise.resolve();
    return this.probeAudio({ controller, ready, download, offline, retry: true });
  }

  probeAudio({ controller, ready, download, offline, retry }) {
    const probe = { controller, id: download?.downloadId, offline, audio: "", retryAfter: null, retryTimer: null };
    this.probe = probe;
    const isCurrent = () => this.probe === probe && this.readControl().controller === controller && offline === !this.isOnline();
    probe.promise = Promise.resolve(ready).then(async () => {
      if (!download || !isCurrent() || this.readControl().capabilities) return;
      let audio = await this.verifyAudio(this.audioUrl(download), download) ? "route" : "";
      if (!audio && offline && isCurrent() && await this.verifyAudio(download.sourceUrl, download)) audio = "legacy";
      if (!isCurrent()) return;
      probe.audio = audio;
      if (audio) {
        this.onChange();
        return;
      }
      probe.retryAfter = Date.now() + PROBE_FAILURE_TTL_MS;
      if (retry) probe.retryTimer = setTimeout(() => {
        if (isCurrent()) void this.probeAudio({ controller, ready, download, offline, retry: false });
      }, PROBE_RETRY_DELAY_MS);
    });
    return probe.promise;
  }

  audioUrl(download) {
    const url = new URL(offlineMetaUrl(this.baseUrl, "audio"));
    url.searchParams.set("download", download.downloadId);
    return url.href;
  }

  async verifyAudio(url, download) {
    try {
      const response = await withOfflineDeadline((signal) => this.fetchImpl(url, { method: "HEAD", cache: "no-store", signal }),
        undefined, PROBE_TIMEOUT_MS);
      if (!response?.ok) return false;
      const book = response.headers.get(bookHeader);
      return response.headers.get(versionHeader) === versionHeaderValue(download.cacheVersion)
        && Number(response.headers.get("content-length")) === download.totalSize
        && response.headers.get("content-type") === download.mime
        && (book === null || book === bookHeaderValue(download.episodeId, download.configBookId));
    } catch {
      return false;
    }
  }

  savedAudio(download) {
    const { controller, capabilities } = this.readControl();
    if (!download || !controller) return null;
    if (capabilities?.audio === true) return { url: this.audioUrl(download), kind: "saved" };
    const probe = this.probe;
    if (probe?.controller !== controller || probe?.id !== download.downloadId) return null;
    if (probe.audio === "route") return { url: this.audioUrl(download), kind: "saved" };
    if (probe.audio === "legacy" && !this.isOnline()) return { url: download.sourceUrl, kind: "saved" };
    return null;
  }

  allowNetworkSource() {
    const { controlled, controller, capabilities } = this.readControl();
    if (this.isOnline() || !controlled) return true;
    return Boolean(controller && (capabilities?.audio === true
      || (this.probe?.controller === controller && this.probe.audio === "route")));
  }

  coverUrl(source, episodeId, book) {
    const base = new URL(this.baseUrl);
    if (new URL(source).origin !== base.origin) return source;
    const { controller, capabilities } = this.readControl();
    if (!controller || !episodeId || !book.id || !(capabilities?.cover === true
      || (this.probe?.controller === controller && this.probe.audio === "route"))) return null;
    const url = new URL(offlineMetaUrl(this.baseUrl, "cover"));
    url.searchParams.set("url", source);
    url.searchParams.set("version", String(book.cacheVersion ?? 1));
    url.searchParams.set("book", episodeId);
    url.searchParams.set("config", book.id);
    return url.href;
  }
}
