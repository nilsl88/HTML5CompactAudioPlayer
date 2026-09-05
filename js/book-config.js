import { normalizeBook, parseJson } from "./config.js";
import { createAbortError, fetchWithRetry } from "./utils.js";

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
  constructor({ library, documentBaseUrl, fetchImpl = globalThis.fetch, retries = 2, retryDelayMs = 500, timeoutMs = 8000 }) {
    this.library = library;
    this.documentBaseUrl = documentBaseUrl;
    this.fetchOptions = { fetchImpl, retries, retryDelayMs, timeoutMs, cache: "default", credentials: "same-origin" };
    this.cache = new Map();
    this.requests = new Map();
    this.titlesRequest = null;
  }

  load(id, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (!isBookId(id, this.library)) return Promise.reject(new Error("Invalid book identifier."));
    if (this.cache.has(id)) return waitForConfig(Promise.resolve(this.cache.get(id)), signal);
    if (!this.requests.has(id)) {
      const request = this.fetchConfig(id).then((result) => {
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

  async fetchConfig(id) {
    const folder = this.library.byId.get(id)?.folder || id;
    const encodedFolder = folder.split("/").map(encodeURIComponent).join("/");
    const bookBaseUrl = new URL(`media/${encodedFolder}/`, this.documentBaseUrl).href;
    for (const filename of ["book.json", "episode.json"]) {
      const configUrl = new URL(filename, bookBaseUrl).href;
      let response;
      let text;
      try {
        response = await fetchWithRetry(configUrl, this.fetchOptions);
        if (response.ok) text = await response.text();
      } catch (error) {
        // Fetch timeouts use AbortError; consumer signals never cancel this shared fetch.
        if (filename === "book.json" && ["TypeError", "NetworkError", "TimeoutError", "AbortError"].includes(error?.name)) continue;
        throw error;
      }
      if (filename === "book.json" && [404, 410].includes(response.status)) continue;
      if (!response.ok) throw new Error(`Could not load book configuration ${configUrl} (HTTP ${response.status}).`);
      const raw = parseJson(text, `media/${folder}/${filename}`);
      const book = normalizeBook(raw, { bookBaseUrl, documentBaseUrl: this.documentBaseUrl });
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
