import "./offline-manifest.js?v=20";
import { isPlayerServiceWorker } from "./utils.js?v=20";

const { offlineMetaUrl, versionHeader, versionHeaderValue, bookHeader, bookHeaderValue } = globalThis.CompactPlayerOfflineManifest;
const CAPABILITIES = "compact-player-worker-capabilities";
const SETUP_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 750;
const PROBE_RETRY_DELAY_MS = 1000;
const PROBE_FAILURE_TTL_MS = 5000;

export class PlayerWorkerSetupTimeout extends Error {
  constructor() {
    super("Service worker setup timed out.");
    this.name = "PlayerWorkerSetupTimeout";
  }
}

async function withTimeout(promise, timeoutMs, error) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => error ? reject(error) : resolve(null), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function askCapabilities(worker, scope) {
  if (!worker.postMessage || typeof MessageChannel !== "function") return null;
  const channel = new MessageChannel();
  try {
    const reply = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
    });
    worker.postMessage({ type: CAPABILITIES }, [channel.port2]);
    const result = await withTimeout(reply, PROBE_TIMEOUT_MS);
    return result?.type === CAPABILITIES && result.scope === scope ? result : null;
  } catch {
    return null;
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

export class PlayerWorker {
  constructor({ baseUrl, navigatorObject, fetchImpl, scriptName, releaseSequence }) {
    this.baseUrl = baseUrl;
    this.navigator = navigatorObject;
    this.fetch = fetchImpl;
    this.script = new URL("sw.js?v=20", this.baseUrl);
    this.releaseId = /^sw-([a-f0-9]{64})\.js$/.exec(scriptName || "")?.[1];
    if (this.releaseId) this.script = new URL(scriptName, this.baseUrl);
    this.releaseSequence = Number(releaseSequence) || 0;
    this.download = null;
    this.connection = null;
    this.listening = false;
  }

  get controller() {
    const worker = this.navigator?.serviceWorker?.controller;
    return isPlayerServiceWorker(worker, this.baseUrl) ? worker : null;
  }

  listen(onDamage, onTakeover) {
    if (this.listening) return;
    const workers = this.navigator?.serviceWorker;
    workers?.addEventListener?.("message", (event) => {
      if (isPlayerServiceWorker(event.source, this.baseUrl) && event.data?.scope === this.baseUrl
        && event.data.type === "compact-player-damaged-chunk") onDamage(event.data);
    });
    workers?.addEventListener?.("controllerchange", () => {
      void this.prepare(this.download);
      if (this.controller) onTakeover?.();
    });
    this.listening = true;
  }

  async register() {
    const workers = this.navigator.serviceWorker;
    const current = this.readConnection();
    if (current && current.worker.scriptURL !== this.script.href) {
      await current.hello;
      const activeRelease = current.routes?.sequence;
      const sameRelease = this.releaseId && this.releaseId === current.routes?.releaseId;
      const newerRelease = Number.isSafeInteger(activeRelease) && activeRelease > this.releaseSequence;
      if (this.controller === current.worker && (sameRelease || newerRelease)) return;
    }
    const error = new PlayerWorkerSetupTimeout();
    await withTimeout(workers.register(this.script, { scope: new URL(this.baseUrl).pathname, updateViaCache: "none" }), SETUP_TIMEOUT_MS, error);
    await withTimeout(workers.ready, SETUP_TIMEOUT_MS, error);
  }

  readConnection() {
    const worker = this.controller;
    if (worker && this.connection?.worker === worker) return this.connection;
    clearTimeout(this.connection?.probe?.retryTimer);
    if (!worker) { this.connection = null; return null; }
    const connection = { worker, routes: null, probe: null };
    connection.hello = askCapabilities(worker, this.baseUrl).then((routes) => { connection.routes = routes; });
    this.connection = connection;
    return this.connection;
  }

  get canWriteOfflineJournal() {
    const worker = this.controller;
    return !worker || (this.connection?.worker === worker && this.connection.routes?.offlineJournal === 1);
  }

  async supportsOfflineWrites() {
    await this.readConnection()?.hello;
    return this.canWriteOfflineJournal;
  }

  prepare(download) {
    this.download = download;
    const connection = this.readConnection();
    if (!connection) return Promise.resolve();
    const offline = this.navigator.onLine === false;
    const previous = connection.probe;
    if (previous && previous.id === download?.downloadId && previous.offline === offline
      && (previous.retryAfter == null || Date.now() < previous.retryAfter)) return previous.promise;
    clearTimeout(previous?.retryTimer);
    return this.probeAudio(connection, download, offline, true);
  }

  probeAudio(connection, download, offline, allowRetry) {
    const probe = { id: download?.downloadId, offline, audio: "", retryAfter: null, retryTimer: null };
    connection.probe = probe;
    const current = () => this.connection === connection && connection.worker === this.controller
      && connection.probe === probe && (this.navigator.onLine === false) === offline;
    probe.promise = connection.hello.then(async () => {
      if (connection.routes || !download || !current()) return;
      let audio = await this.verifyAudio(this.audioUrl(download), download) ? "route" : "";
      if (!audio && offline && current() && await this.verifyAudio(download.sourceUrl, download)) audio = "legacy";
      if (!current()) return;
      probe.audio = audio;
      if (audio) return;
      probe.retryAfter = Date.now() + PROBE_FAILURE_TTL_MS;
      if (allowRetry) probe.retryTimer = setTimeout(() => {
        if (current()) void this.probeAudio(connection, this.download, offline, false);
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
    const controller = new AbortController();
    try {
      const request = this.fetch(url, { method: "HEAD", cache: "no-store", signal: controller.signal });
      const response = await withTimeout(request, PROBE_TIMEOUT_MS);
      if (!response) controller.abort();
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
    const current = this.connection;
    if (!download || !current || current.worker !== this.controller) return null;
    if (current.routes?.audio === true) return { url: this.audioUrl(download), kind: "saved" };
    if (current.probe?.id !== download.downloadId) return null;
    if (current.probe.audio === "route") return { url: this.audioUrl(download), kind: "saved" };
    if (current.probe.audio === "legacy" && this.navigator.onLine === false) return { url: download.sourceUrl, kind: "saved" };
    return null;
  }

  allowNetworkSource() {
    if (this.navigator?.onLine !== false || !this.navigator?.serviceWorker?.controller) return true;
    const current = this.connection;
    return current?.worker === this.controller
      && (current?.routes?.audio === true || current?.probe?.audio === "route");
  }

  coverUrl(source, episodeId, book) {
    const base = new URL(this.baseUrl);
    if (new URL(source).origin !== base.origin) return source;
    const current = this.connection;
    if (!current || current.worker !== this.controller
      || !(current.routes?.cover === true || current.probe?.audio === "route") || !episodeId || !book.id) return null;
    const url = new URL(offlineMetaUrl(this.baseUrl, "cover"));
    url.searchParams.set("url", source);
    url.searchParams.set("version", String(book.cacheVersion ?? 1));
    url.searchParams.set("book", episodeId);
    url.searchParams.set("config", book.id);
    return url.href;
  }
}
