import { parseContentRange } from "./http-range.js?v=22";
import { findTopLevelAtom } from "./mp4-atoms.js?v=22";
import { createAbortError, fetchWithRetry, metadataRequestCache } from "./utils.js?v=22";
import { withOfflineDeadline } from "./offline-transfer.js?v=22";
import "./offline-manifest.js?v=22";

const { checkResponseVersion, strongETag, strongLastModified } = globalThis.CompactPlayerOfflineManifest;

export const MP4_METADATA_CHUNK_BYTES = 256 * 1024;
export const MP4_METADATA_LIMIT_BYTES = 16 * 1024 * 1024;
const MP4_METADATA_CACHE_MS = 30000;
export const MP4_METADATA_MAX_REQUESTS = 128;
const metadataRequestsByFetch = new WeakMap();

async function readMetadataBytes(body, length, signal) {
  if (!body) throw new Error("The audio metadata range was truncated.");
  const bytes = new Uint8Array(length);
  const reader = body.getReader();
  let offset = 0;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => { /* The transport may already have aborted. */ }); };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (done) {
        finished = true;
        break;
      }
      if (value.byteLength > bytes.length - offset) throw new Error("The audio metadata range exceeded its declared length.");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== bytes.length) throw new Error("The audio metadata range was truncated.");
    return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished && !signal?.aborted) cancel();
    reader.releaseLock();
  }
}

export class RangeReader {
  constructor(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = 20000, cacheVersion, bookIdentity,
    deadline = Date.now() + timeoutMs } = {}, {
    first, total = 0, validator = null, responseUrl = null, requestsUsed = 0,
  } = {}) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.deadline = deadline;
    this.requestsUsed = requestsUsed;
    this.cacheVersion = cacheVersion;
    this.bookIdentity = bookIdentity;
    this.first = first;
    this.total = total;
    this.validator = validator;
    this.responseUrl = responseUrl;
  }

  async read(start, end) {
    if (this.signal?.aborted) throw createAbortError();
    if (end <= start || end - start > MP4_METADATA_LIMIT_BYTES || (this.total && end > this.total)) {
      throw new Error("MP4 metadata range is invalid or too large.");
    }
    const cached = this.first?.subarray(start, end);
    const missingStart = start + (cached?.length || 0);
    if (missingStart === end) return cached;
    const remaining = this.deadline - Date.now();
    const timeout = new DOMException("MP4 metadata loading timed out.", "TimeoutError");
    if (remaining <= 0) throw timeout;
    if (this.requestsUsed >= MP4_METADATA_MAX_REQUESTS) throw new Error("MP4 metadata exceeded the request limit.");
    const headers = { Range: `bytes=${missingStart}-${end - 1}` };
    const location = globalThis.location;
    const urls = [this.url, this.responseUrl ?? this.url];
    if (this.validator && (!location?.origin || urls.every((url) => new URL(url, location.href).origin === location.origin))) {
      headers["If-Range"] = this.validator.value;
    }
    const bytes = await withOfflineDeadline((signal) => fetchWithRetry(this.url, {
      fetchImpl: (...args) => {
        if (this.requestsUsed >= MP4_METADATA_MAX_REQUESTS) throw new Error("MP4 metadata exceeded the request limit.");
        this.requestsUsed++;
        return this.fetchImpl(...args);
      },
      cache: metadataRequestCache(this.cacheVersion),
      credentials: "same-origin",
      headers,
      signal,
      timeoutMs: remaining,
      retries: 2,
    }, (response, readSignal) => this.readRange(response, missingStart, end, readSignal)), this.signal, remaining, timeout);
    if (!cached?.length) return bytes;
    const combined = new Uint8Array(end - start);
    combined.set(cached);
    combined.set(bytes, cached.length);
    return combined;
  }

  async readRange(response, start, end, signal) {
    if (response.status !== 206) throw new Error("The audio server does not support metadata byte ranges.");
    checkResponseVersion(response, this.cacheVersion, this.bookIdentity);
    const range = parseContentRange(response.headers?.get?.("Content-Range"));
    if (!range || (this.total && this.total !== range.total)) throw new Error("The audio server returned an invalid metadata range.");
    const expectedEnd = Math.min(end, range.total) - 1;
    if (range.start !== start || range.end !== expectedEnd) throw new Error("The audio server returned an invalid metadata range.");
    const responseUrl = String(response.url || this.url).split("#", 1)[0];
    if (this.responseUrl != null && this.responseUrl !== responseUrl) {
      throw new Error("The MP4 metadata URL changed during loading.");
    }
    if (this.validator && response.headers.get(this.validator.header) !== this.validator.value) {
      throw new Error("The MP4 metadata version changed during loading.");
    }
    const bytes = await readMetadataBytes(response.body, range.end - start + 1, signal);
    if (!this.total) {
      const etag = strongETag(response.headers.get("ETag"));
      const lastModified = strongLastModified({
        lastModified: response.headers.get("Last-Modified"), responseDate: response.headers.get("Date"),
      });
      this.validator = etag ? { header: "ETag", value: etag }
        : lastModified ? { header: "Last-Modified", value: lastModified } : null;
    }
    this.total = range.total;
    this.responseUrl = responseUrl;
    return bytes;
  }
}

async function readMp4Metadata(url, options = {}) {
  const reader = new RangeReader(url, options);
  reader.first = await reader.read(0, MP4_METADATA_CHUNK_BYTES);
  const moov = await findTopLevelAtom(reader, "moov");
  if (!moov) throw new Error("The MP4 metadata box was not found.");
  const moovBytes = await reader.read(moov.start, moov.start + moov.size);
  const moovBuffer = moovBytes.buffer.slice(moovBytes.byteOffset, moovBytes.byteOffset + moovBytes.byteLength);
  return { moovBuffer, first: reader.first, total: reader.total, validator: reader.validator,
    responseUrl: reader.responseUrl, requestsUsed: reader.requestsUsed };
}

function metadataRequestMap(fetchImpl) {
  let requests = metadataRequestsByFetch.get(fetchImpl);
  if (!requests) {
    requests = new Map();
    metadataRequestsByFetch.set(fetchImpl, requests);
  }
  return requests;
}

function consumeMetadataRequest(entry, requests, key, signal) {
  entry.consumers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      entry.consumers -= 1;
      if (!entry.settled && entry.consumers === 0) {
        entry.controller.abort();
        if (requests.get(key) === entry) requests.delete(key);
      }
      callback(value);
    };
    const abort = () => finish(reject, createAbortError());
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal?.aborted) abort();
  });
}

export function loadMp4Metadata(url, options = {}) {
  if (options.signal?.aborted) return Promise.reject(createAbortError());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return Promise.reject(new Error("Fetch is unavailable."));
  const requests = metadataRequestMap(fetchImpl);
  const version = options.cacheVersion == null ? null : String(options.cacheVersion);
  const key = JSON.stringify([String(url), version, options.bookIdentity?.episodeId || "", options.bookIdentity?.configBookId || "",
    Number(options.timeoutMs) || 20000]);
  let entry = requests.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, consumers: 0, settled: false, promise: null };
    entry.promise = readMp4Metadata(url, { ...options, fetchImpl, signal: controller.signal }).then(
      (value) => {
        entry.settled = true;
        value.discard = () => { if (requests.get(key) === entry) requests.delete(key); };
        const timer = setTimeout(() => { if (requests.get(key) === entry) requests.delete(key); }, MP4_METADATA_CACHE_MS);
        timer?.unref?.();
        return value;
      },
      (error) => {
        entry.settled = true;
        if (requests.get(key) === entry) requests.delete(key);
        throw error;
      },
    );
    requests.set(key, entry);
  }
  return consumeMetadataRequest(entry, requests, key, options.signal);
}
