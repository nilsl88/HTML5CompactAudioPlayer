import { normalizeBook, normalizeLibrary, parseJson } from "./config.js";
import { buildSources } from "./source-selection.js";
import { createAbortError, fetchTextWithRetry, fetchWithRetry } from "./utils.js";
import "./offline-manifest.js";

export function fetchLibraryCatalog(url, fetchImpl) {
  return fetchWithRetry(url, { fetchImpl, cache: "no-store", credentials: "same-origin" }, async (response) => {
    if (!response.ok) return null;
    const library = normalizeLibrary(parseJson(await response.text(), "media/library.json"));
    const { versionHeader } = globalThis.CompactPlayerOfflineManifest;
    return { library, fromDownload: response.headers?.get?.(versionHeader) != null };
  });
}

function parseBookConfig(text, configUrl, documentBaseUrl) {
  const raw = parseJson(text, configUrl);
  return normalizeBook(raw, { bookBaseUrl: new URL(".", configUrl).href, documentBaseUrl });
}

export function validateOfflineBookConfig(text, configUrl, documentBaseUrl, selection) {
  const book = parseBookConfig(text, configUrl, documentBaseUrl);
  const sources = buildSources(book.languages[selection.languageCode]);
  // Legacy downloads may only have a catalog alias, without the ID from the configuration.
  if ((selection.configBookId && book.id !== selection.configBookId)
    || String(book.cacheVersion) !== String(selection.cacheVersion)
    || !sources.some((source) => source.id === selection.sourceId && source.url === selection.sourceUrl)) {
    throw new Error("The cached book configuration no longer matches the selected audio.");
  }
  return book.id;
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
    this.fetchOptions = { fetchImpl, retries, retryDelayMs, timeoutMs, cache: "default", credentials: "same-origin" };
    this.cache = new Map();
    this.requests = new Map();
    this.titlesRequest = null;
  }

  setLibrary(library, { fromDownload = false } = {}) {
    this.library = library;
    if (!fromDownload) this.downloadedConfig = null;
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

  async load(id, { signal } = {}) {
    while (!signal?.aborted) {
      const recordedUrl = this.downloadedConfig?.id === id ? this.downloadedConfig.url : null;
      if (!recordedUrl && !isBookId(id, this.library)) throw new Error("Invalid book identifier.");
      const key = this.configKey(id);
      try {
        const lookup = this.sharedRequest(id, key, recordedUrl);
        const result = await waitForConfig(lookup, signal);
        if (result && !signal?.aborted && key === this.configKey(id)) return result;
      } catch (error) {
        if (signal?.aborted || key === this.configKey(id)) throw error;
      }
    }
    throw createAbortError();
  }

  sharedRequest(id, key, recordedUrl) {
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.requests.has(key)) return this.requests.get(key).promise;
    const controller = new AbortController();
    const request = { id, controller };
    this.requests.set(key, request);
    request.promise = waitForConfig(this.fetchConfig(id, recordedUrl, controller.signal), controller.signal).then((result) => {
      if (controller.signal.aborted) return null;
      this.cache.set(key, result);
      const record = this.library.byId.get(id);
      if (record) record.title = result.book.title;
      return result;
    }, (error) => {
      if (controller.signal.aborted) return null;
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

  async fetchConfig(id, recordedUrl, signal) {
    const urls = this.configUrls(id, recordedUrl);
    for (const [index, configUrl] of urls.entries()) {
      const hasFallback = index + 1 < urls.length;
      let response;
      try {
        response = await fetchTextWithRetry(configUrl, { ...this.fetchOptions, signal });
        if (signal?.aborted) throw createAbortError();
      } catch (error) {
        // Fetch timeouts use AbortError; consumer signals never cancel this shared fetch.
        if (!signal?.aborted && hasFallback && ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(error?.name)) continue;
        throw error;
      }
      if (hasFallback && [404, 410].includes(response.status)) continue;
      if (!response.ok) throw new Error(`Could not load book configuration ${configUrl} (HTTP ${response.status}).`);
      const book = parseBookConfig(response.text, configUrl, this.documentBaseUrl);
      return { book, configUrl };
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
