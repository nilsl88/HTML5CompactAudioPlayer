import "./offline-manifest.js?v=25";
import { isPlayerServiceWorker } from "./utils.js?v=25";

const { journalVersion } = globalThis.CompactPlayerOfflineManifest;
const CAPABILITIES = "compact-player-worker-capabilities";
const SETUP_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 750;
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
  constructor({ baseUrl, navigatorObject, scriptName, releaseSequence }) {
    this.baseUrl = baseUrl;
    this.navigator = navigatorObject;
    this.script = new URL("sw.js?v=25", this.baseUrl);
    this.releaseId = /^sw-([a-f0-9]{64})\.js$/.exec(scriptName || "")?.[1];
    if (this.releaseId) this.script = new URL(scriptName, this.baseUrl);
    this.releaseSequence = Number(releaseSequence) || 0;
    this.connection = null;
    this.listening = false;
  }

  get controller() {
    const worker = this.navigator?.serviceWorker?.controller;
    return isPlayerServiceWorker(worker, this.baseUrl) ? worker : null;
  }

  readControl() {
    const controller = this.controller;
    return { controller, controlled: Boolean(this.navigator?.serviceWorker?.controller),
      capabilities: this.connection?.worker === controller ? this.connection.routes : null };
  }

  connect() { return this.readConnection()?.hello; }

  listen(onDamage, onTakeover, onControllerChange) {
    if (this.listening) return;
    this.onTakeover = onTakeover;
    const workers = this.navigator?.serviceWorker;
    workers?.addEventListener?.("message", (event) => {
      if (isPlayerServiceWorker(event.source, this.baseUrl) && event.data?.scope === this.baseUrl
        && event.data.type === "compact-player-damaged-chunk") onDamage(event.data);
    });
    workers?.addEventListener?.("controllerchange", () => {
      const resumeRegistration = this.connection?.registrationDeferred;
      const connection = this.readConnection();
      onControllerChange?.();
      if (this.controller) onTakeover?.();
      if (resumeRegistration) {
        if (connection) {
          connection.registrationDeferred = true;
          void this.resumeDeferredRegistration(connection);
        } else {
          void this.register().catch((error) => {
            console.warn("[CompactAudioPlayer] Could not resume the offline worker update.", error);
          });
        }
      }
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
      if (this.controller !== current.worker) return this.register();
      if (this.controller === current.worker && (sameRelease || newerRelease)) {
        current.registrationDeferred = false;
        return;
      }
      const bridge = new URL(current.worker.scriptURL).pathname.endsWith("/sw.js");
      if (!Number.isSafeInteger(activeRelease) && this.releaseId && (!bridge || current.worker.postMessage)) {
        current.registrationDeferred = true;
        if (bridge && !current.bridgeUpdate) {
          current.bridgeUpdate = this.updateBridge(current, workers).catch((error) => {
            current.bridgeUpdate = null;
            throw error;
          });
          await current.bridgeUpdate;
        }
        return;
      }
    }
    const error = new PlayerWorkerSetupTimeout();
    await withTimeout(workers.register(this.script, { scope: new URL(this.baseUrl).pathname, updateViaCache: "none" }), SETUP_TIMEOUT_MS, error);
    await withTimeout(workers.ready, SETUP_TIMEOUT_MS, error);
    if (current && this.controller === current.worker) current.registrationDeferred = false;
  }

  async updateBridge(connection, workers) {
    const error = new PlayerWorkerSetupTimeout();
    const registration = await withTimeout(workers.getRegistration?.(this.baseUrl), SETUP_TIMEOUT_MS, error);
    // Refresh the registered URL until the active worker's release is known.
    if (registration?.active === connection.worker && this.controller === connection.worker
      && !registration.waiting && !registration.installing) {
      await withTimeout(registration.update(), SETUP_TIMEOUT_MS, error);
    }
  }

  resumeDeferredRegistration(connection) {
    if (!connection.registrationDeferred || this.connection !== connection || this.controller !== connection.worker) return;
    if (!connection.registrationRetry) {
      connection.registrationRetry = this.register().catch((error) => {
        console.warn("[CompactAudioPlayer] Could not resume the offline worker update.", error);
      }).finally(() => { connection.registrationRetry = null; });
    }
    return connection.registrationRetry;
  }

  readConnection() {
    const worker = this.controller;
    if (worker && this.connection?.worker === worker) return this.connection;
    clearTimeout(this.connection?.helloRetry);
    if (!worker) { this.connection = null; return null; }
    const connection = { worker, routes: null };
    const query = () => {
      connection.helloRetry = null;
      connection.querying = true;
      connection.hello = askCapabilities(worker, this.baseUrl).then((routes) => {
        connection.querying = false;
        if (this.connection !== connection || this.controller !== worker) return;
        if (routes) connection.routes = routes;
        if (routes) {
          this.onTakeover?.();
          if (connection.registrationDeferred) {
            void this.resumeDeferredRegistration(connection);
          }
        }
        else if (worker.postMessage && !connection.retried) {
          connection.retried = true;
          connection.helloRetry = setTimeout(query, PROBE_FAILURE_TTL_MS);
          connection.helloRetry?.unref?.();
        }
      });
    };
    connection.query = query;
    this.connection = connection;
    query();
    return this.connection;
  }

  get canWriteOfflineJournal() {
    const { controller, controlled, capabilities } = this.readControl();
    return !controlled || Boolean(controller && capabilities?.offlineJournal === journalVersion);
  }

  async supportsOfflineWrites() {
    const connection = this.readConnection();
    if (connection && !connection.routes && !connection.querying && !connection.helloRetry) connection.query();
    await connection?.hello;
    return this.canWriteOfflineJournal;
  }

  async retryCapabilities() {
    const connection = this.readConnection();
    const needsReleaseVersion = connection?.registrationDeferred && !Number.isSafeInteger(connection.routes?.sequence);
    if (connection && (!connection.routes || needsReleaseVersion) && !connection.querying && connection.worker.postMessage) {
      clearTimeout(connection.helloRetry);
      connection.query();
    }
    await connection?.hello;
    if (connection?.routes) await this.resumeDeferredRegistration(connection);
    return this.canWriteOfflineJournal;
  }

}
