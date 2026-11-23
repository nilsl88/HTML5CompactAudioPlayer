import { normalizeLibrary, parseBookConfig, parseJson } from "./config.js?v=19";
export { validateOfflineBookConfig } from "./offline-selection.js?v=19";
import { createAbortError, fetchTextWithRetry, fetchWithRetry } from "./utils.js?v=19";
import "./offline-manifest.js?v=19";

function isDownloadedResponse(response) {
  return response.headers?.get?.(globalThis.CompactPlayerOfflineManifest.versionHeader) != null;
}

export function fetchLibraryCatalog(url, fetchImpl) {
  return fetchWithRetry(url, { fetchImpl, cache: "no-store", credentials: "same-origin" }, async (response) => {
    if (!response.ok) return null;
    const library = normalizeLibrary(parseJson(await response.text(), "media/library.json"));
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

function waitForConfig(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(createAbortError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export class BookConfigStore {
  constructor({ library, documentBaseUrl, downloadedConfig = null, fetchImpl = globalThis.fetch, retries = 2, retryDelayMs = 500, timeoutMs = 8000 }) {
    this.library = library;
    this.downloadedConfig = downloadedConfig;
    this.documentBaseUrl = documentBaseUrl;
    this.fetchOptions = { fetchImpl, retries, retryDelayMs, timeoutMs, credentials: "same-origin" };
    this.cache = new Map();
    this.requests = new Map();
    this.titlesRequest = null;
  }

  setLibrary(library, { fromDownload = false } = {}) {
    const recordedId = this.downloadedConfig?.id;
    const saved = !fromDownload && recordedId && this.cache.get(this.configKey(recordedId));
    this.library = library;
    if (!fromDownload) this.downloadedConfig = null;
    if (saved?.fromDownload && this.configUrls(recordedId).includes(saved.configUrl)) {
      this.cache.set(this.configKey(recordedId), saved);
    }
    const retained = new Set();
    for (const record of library.books) {
      const key = this.configKey(record.id);
      retained.add(key);
      const cached = this.cache.get(key);
      if (cached) record.title = cached.book.title;
    }
    for (const key of this.cache.keys()) if (!retained.has(key)) this.cache.delete(key);
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

  async load(id, { signal, revalidate = false } = {}) {
    while (!signal?.aborted) {
      const recordedUrl = this.downloadedConfig?.id === id ? this.downloadedConfig.url : null;
      if (!recordedUrl && !isBookId(id, this.library)) throw new Error("Invalid book identifier.");
      const key = this.configKey(id);
      try {
        const lookup = this.sharedRequest(id, key, recordedUrl, revalidate);
        const result = await waitForConfig(lookup, signal);
        if (result && !signal?.aborted && key === this.configKey(id)) return result;
      } catch (error) {
        if (signal?.aborted || key === this.configKey(id)) throw error;
      }
    }
    throw createAbortError();
  }

  sharedRequest(id, key, recordedUrl, revalidate) {
    const cached = this.cache.get(key);
    if (cached && !(revalidate && cached.fromDownload)) return Promise.resolve(cached);
    if (this.requests.has(key)) return this.requests.get(key).promise;
    const controller = new AbortController();
    const request = { id, controller };
    this.requests.set(key, request);
    const cache = cached ? "no-cache" : "default";
    request.promise = waitForConfig(this.fetchConfig(id, recordedUrl, controller.signal, cache), controller.signal).then((result) => {
      if (controller.signal.aborted) return null;
      this.cache.set(key, result);
      const record = this.library.byId.get(id);
      if (record) record.title = result.book.title;
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
    return request.promise;
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
    for (const [index, configUrl] of urls.entries()) {
      const hasFallback = index + 1 < urls.length;
      let response;
      try {
        response = await fetchTextWithRetry(configUrl, { ...this.fetchOptions, signal, cache });
        if (signal?.aborted) throw createAbortError();
      } catch (error) {
        // Fetch timeouts use AbortError; consumer signals never cancel this shared fetch.
        if (!signal?.aborted && hasFallback && ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(error?.name)) continue;
        throw error;
      }
      if (hasFallback && [404, 410].includes(response.status)) continue;
      if (!response.ok) throw new Error(`Could not load book configuration ${configUrl} (HTTP ${response.status}).`);
      const book = parseBookConfig(response.text, configUrl, this.documentBaseUrl);
      return { book, configUrl, fromDownload: isDownloadedResponse(response) };
    }
  }

  loadTitles(onError = (id, error) => console.warn(`Could not load book title (${id}).`, error), onTitle) {
    if (this.titlesRequest) return this.titlesRequest;
    const library = this.library;
    const records = library.books.filter((record) => !this.cache.has(this.configKey(record.id)));
    if (!records.length) return Promise.resolve();
    let cursor = 0;
    const worker = async () => {
      while (library === this.library && cursor < records.length) {
        const record = records[cursor]; cursor += 1;
        try { await this.load(record.id); }
        catch (error) { onError(record.id, error); continue; }
        if (library === this.library) onTitle?.(record);
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
