import { normalizeLibrary, parseBookConfig, parseJson, readBookConfigText } from "./config.js?v=25";
export { validateOfflineBookConfig } from "./offline-selection.js?v=25";
import { createAbortError, fetchTextWithRetry, fetchWithRetry, readBoundedText } from "./utils.js?v=25";
import "./offline-manifest.js?v=25";

const { versionHeader, networkStatusHeader } = globalThis.CompactPlayerOfflineManifest;
const MAX_CACHED_CONFIGS = 24;

function isDownloadedResponse(response) {
  return response.headers?.get?.(versionHeader) != null;
}

export function readLibraryText(response, signal) {
  return readBoundedText(response, signal, 2 * 1024 ** 2, () => new Error("Library catalog exceeds 2 MiB."));
}

export function fetchLibraryCatalog(url, fetchImpl, signal) {
  return fetchWithRetry(url, { fetchImpl, signal, cache: "no-store", credentials: "same-origin" }, async (response, readSignal) => {
    if (!response.ok) return null;
    const library = normalizeLibrary(parseJson(await readLibraryText(response, readSignal), "media/library.json"));
    return { library, fromDownload: isDownloadedResponse(response) };
  });
}

function isBookId(id, library) {
  return library.byId.has(id) || (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "..");
}

export function queryBookId(searchParams, library) {
  const id = searchParams.get("book") || searchParams.get("episode") || "";
  return isBookId(id, library) ? id : "";
}

function waitForConfig(promise, signal, release) {
  if (!signal) return release ? promise.finally(release) : promise;
  if (signal.aborted) {
    release?.();
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      release?.();
      settle(result);
    };
    const abort = () => finish(reject, createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class BookConfigStore {
  constructor({ library, documentBaseUrl, downloadedConfig = null, fetchImpl = globalThis.fetch, retries = 2, retryDelayMs = 500, timeoutMs = 8000 }) {
    this.library = library;
    this.downloadedConfig = downloadedConfig;
    this.documentBaseUrl = documentBaseUrl;
    this.fetchOptions = { fetchImpl, retries, retryDelayMs, timeoutMs, credentials: "same-origin" };
    this.cache = new Map();
    this.titles = new Map();
    this.selectedKey = null;
    this.requests = new Map();
    this.titlesRequest = null;
    this.closed = false;
  }

  close() {
    this.closed = true;
    for (const { controller } of this.requests.values()) controller.abort();
    this.requests.clear();
  }

  setLibrary(library, { fromDownload = false } = {}) {
    const recordedId = this.downloadedConfig?.id;
    const saved = !fromDownload && recordedId && this.cache.get(this.configKey(recordedId));
    this.library = library;
    if (!fromDownload) this.downloadedConfig = null;
    if (saved?.fromDownload && this.configUrls(recordedId).includes(saved.configUrl)) {
      const key = this.configKey(recordedId);
      this.rememberConfig(key, saved);
      this.titles.set(key, saved.book.title);
    }
    const retained = new Set();
    for (const record of library.books) {
      const key = this.configKey(record.id);
      retained.add(key);
      const title = this.titles.get(key) ?? this.cache.get(key)?.book.title;
      if (title) record.title = title;
    }
    for (const key of this.cache.keys()) if (!retained.has(key)) this.cache.delete(key);
    for (const key of this.titles.keys()) if (!retained.has(key)) this.titles.delete(key);
    for (const [key, request] of this.requests) {
      if (key === this.configKey(request.id)) continue;
      this.requests.delete(key);
      request.controller.abort();
    }
  }

  configKey(id) {
    const recordedUrl = this.downloadedConfig?.id === id ? this.downloadedConfig.url : null;
    return JSON.stringify([id, recordedUrl, this.library.byId.get(id)?.folder || id]);
  }

  async load(id, { signal, revalidate = false, titleOnly = false } = {}) {
    while (!this.closed && !signal?.aborted) {
      const recordedUrl = this.downloadedConfig?.id === id ? this.downloadedConfig.url : null;
      if (!recordedUrl && !isBookId(id, this.library)) throw new Error("Invalid book identifier.");
      const key = this.configKey(id);
      try {
        const result = await this.sharedRequest(id, key, recordedUrl, revalidate, signal);
        if (result && !this.closed && !signal?.aborted && key === this.configKey(id)) {
          if (!titleOnly) this.selectedKey = key;
          this.rememberConfig(key, result);
          return result;
        }
      } catch (error) {
        if (signal?.aborted || key === this.configKey(id)) throw error;
      }
    }
    throw createAbortError();
  }

  sharedRequest(id, key, recordedUrl, revalidate, signal) {
    const cached = this.cache.get(key);
    if (cached && !(revalidate && cached.fromDownload)) return Promise.resolve(cached);
    const request = this.requests.get(key) ?? this.startRequest(id, key, recordedUrl, cached);
    request.consumers++;
    return waitForConfig(request.promise, signal, () => {
      request.consumers--;
      if (request.consumers !== 0 || this.requests.get(key) !== request) return;
      this.requests.delete(key);
      request.controller.abort();
    });
  }

  startRequest(id, key, recordedUrl, cached) {
    const controller = new AbortController();
    const request = { id, controller, consumers: 0 };
    this.requests.set(key, request);
    const cache = cached ? "no-cache" : "default";
    request.promise = waitForConfig(this.fetchConfig(id, recordedUrl, controller.signal, cache), controller.signal).then((result) => {
      if (controller.signal.aborted) return null;
      this.rememberConfig(key, result);
      const record = this.library.byId.get(id);
      if (record) {
        record.title = result.book.title;
        this.titles.set(key, record.title);
      }
      return result;
    }, (error) => {
      if (controller.signal.aborted) return null;
      if (cached) {
        console.warn("[CompactAudioPlayer] Could not revalidate the downloaded book configuration.", id, error);
        return cached;
      }
      throw error;
    }).finally(() => {
      if (this.requests.get(key) === request) this.requests.delete(key);
    });
    return request;
  }

  rememberConfig(key, result) {
    this.cache.delete(key);
    this.cache.set(key, result);
    if (this.cache.size <= MAX_CACHED_CONFIGS) return;
    for (const oldest of this.cache.keys()) {
      if (oldest === this.selectedKey) continue;
      this.cache.delete(oldest);
      break;
    }
  }

  configUrls(id, recordedUrl) {
    if (recordedUrl) {
      const root = new URL("media/", this.documentBaseUrl);
      const url = new URL(recordedUrl, root);
      if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname) || !/\/(book|episode)\.json$/.test(url.pathname)) {
        throw new Error("Invalid offline book configuration URL.");
      }
      return [url.href];
    }
    const folder = this.library.byId.get(id)?.folder || id;
    const encodedFolder = folder.split("/").map(encodeURIComponent).join("/");
    const bookBaseUrl = new URL(`media/${encodedFolder}/`, this.documentBaseUrl).href;
    return ["book.json", "episode.json"].map((name) => new URL(name, bookBaseUrl).href);
  }

  async fetchConfig(id, recordedUrl, signal, cache) {
    const urls = this.configUrls(id, recordedUrl);
    let downloaded;
    try {
      for (const [index, configUrl] of urls.entries()) {
        const hasFallback = index + 1 < urls.length;
        let response;
        try {
          response = await fetchTextWithRetry(configUrl, { ...this.fetchOptions, signal, cache }, readBookConfigText);
          if (signal?.aborted) throw createAbortError();
        } catch (error) {
          // A request timeout can fall back to episode.json. Canceling the shared read ends both attempts.
          if (!signal?.aborted && hasFallback && ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(error?.name)) continue;
          throw error;
        }
        if (hasFallback && [404, 410].includes(response.status)) continue;
        if (!response.ok) throw new Error(`Could not load book configuration ${configUrl} (HTTP ${response.status}).`);
        const book = parseBookConfig(response.text, configUrl, this.documentBaseUrl);
        const result = { book, configUrl, fromDownload: isDownloadedResponse(response) };
        const networkStatus = response.headers?.get?.(networkStatusHeader);
        if (hasFallback && result.fromDownload && ["404", "410", "network-error"].includes(networkStatus)) {
          downloaded = result;
          continue;
        }
        return result;
      }
    } catch (error) {
      if (downloaded && !signal?.aborted) return downloaded;
      throw error;
    }
  }

  loadTitles(onError = (id, error) => console.warn(`Could not load book title (${id}).`, error), onTitle) {
    if (this.closed) return Promise.resolve();
    if (this.titlesRequest) return this.titlesRequest;
    const library = this.library;
    const records = library.books.filter((record) => !this.titles.has(this.configKey(record.id)));
    if (!records.length) return Promise.resolve();
    let cursor = 0;
    const worker = async () => {
      while (!this.closed && library === this.library && cursor < records.length) {
        const record = records[cursor]; cursor += 1;
        try { await this.load(record.id, { titleOnly: true }); }
        catch (error) { if (!this.closed) onError(record.id, error); continue; }
        if (!this.closed && library === this.library) onTitle?.(record);
      }
    };
    const request = Promise.all(Array.from({ length: Math.min(2, records.length) }, () => worker())).then(() => {
      if (library !== this.library) {
        this.titlesRequest = null;
        return this.loadTitles(onError, onTitle);
      }
    });
    this.titlesRequest = request;
    const clear = () => { if (this.titlesRequest === request) this.titlesRequest = null; };
    void request.then(clear, clear);
    return request;
  }
}
