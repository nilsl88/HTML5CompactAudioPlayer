import { normalizeBook, parseJson } from "./config.js";
import { buildSources } from "./source-selection.js";
import { createAbortError, fetchTextWithRetry } from "./utils.js";

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

  load(id, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    const recordedUrl = this.downloadedConfig && this.downloadedConfig.id === id ? this.downloadedConfig.url : "";
    if (!recordedUrl && !isBookId(id, this.library)) return Promise.reject(new Error("Invalid book identifier."));
    if (this.cache.has(id)) return waitForConfig(Promise.resolve(this.cache.get(id)), signal);
    if (!this.requests.has(id)) {
      const request = this.fetchConfig(id, recordedUrl).then((result) => {
        this.cache.set(id, result);
        const record = this.library.byId.get(id);
        if (record) record.title = result.book.title;
        return result;
      });
      this.requests.set(id, request);
      void request.then(() => this.requests.delete(id), () => this.requests.delete(id));
    }
    // Consumers can leave a shared title/selection request independently.
    return waitForConfig(this.requests.get(id), signal);
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

  async fetchConfig(id, recordedUrl) {
    const urls = this.configUrls(id, recordedUrl);
    for (const [index, configUrl] of urls.entries()) {
      const hasFallback = index + 1 < urls.length;
      let response;
      try {
        response = await fetchTextWithRetry(configUrl, this.fetchOptions);
      } catch (error) {
        // Fetch timeouts use AbortError; consumer signals never cancel this shared fetch.
        if (hasFallback && ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(error?.name)) continue;
        throw error;
      }
      if (hasFallback && [404, 410].includes(response.status)) continue;
      if (!response.ok) throw new Error(`Could not load book configuration ${configUrl} (HTTP ${response.status}).`);
      const book = parseBookConfig(response.text, configUrl, this.documentBaseUrl);
      return { book, configUrl };
    }
  }

  loadTitles(onError = (id, error) => console.warn(`Could not load book title (${id}).`, error)) {
    if (this.titlesRequest) return this.titlesRequest;
    const records = this.library.books.filter((record) => !this.cache.has(record.id));
    if (!records.length) return Promise.resolve();
    let cursor = 0;
    const worker = async () => {
      while (cursor < records.length) {
        const record = records[cursor]; cursor += 1;
        try { await this.load(record.id); }
        catch (error) { onError(record.id, error); }
      }
    };
    const request = Promise.all(Array.from({ length: Math.min(2, records.length) }, () => worker()));
    this.titlesRequest = request;
    void request.then(() => { this.titlesRequest = null; }, () => { this.titlesRequest = null; });
    return request;
  }
}
