import { parseContentRange } from "./http-range.js";
import "./offline-manifest.js";
import { createAbortError } from "./utils.js";

const { audioMimeType, strongETag, strongLastModified, downloadHeader: OFFLINE_DOWNLOAD_HEADER } = globalThis.CompactPlayerOfflineManifest;
export const OFFLINE_CHUNK_SIZE = 8 * 1024 * 1024;
const RANGE_IDLE_TIMEOUT_MS = 20_000;

export class OfflineDownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OfflineDownloadError";
    this.code = code;
  }
}

export function checkCanceled(signal) {
  if (signal?.aborted) throw createAbortError("Download canceled");
}

export { parseContentRange };

export function chunkBounds(index, totalSize, chunkSize = OFFLINE_CHUNK_SIZE) {
  const start = index * chunkSize;
  return { start, end: Math.min(totalSize - 1, start + chunkSize - 1) };
}

function rangeValidator(manifest) {
  return manifest.etag ? strongETag(manifest.etag) : strongLastModified(manifest);
}

export function sameAudioRevision(previous, next) {
  const validator = rangeValidator(next);
  return previous.totalSize === next.totalSize && Boolean(validator && validator === rangeValidator(previous));
}

function downloadMimeType(contentType, sourceMime) {
  const type = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream") return audioMimeType(sourceMime);
  // Servers can label an audio-only file with its container's video or application type.
  return audioMimeType(type.replace(/^(?:video|application)\/(mp4|ogg|webm)$/, "audio/$1"));
}

function validateAudioMime(response, sourceMime, expectedMime) {
  const mime = downloadMimeType(response.headers.get("content-type"), sourceMime);
  if (!mime || (expectedMime && mime !== audioMimeType(expectedMime))) {
    throw new OfflineDownloadError("mime", "The response does not match the expected audio MIME type.");
  }
  return mime;
}

function validateResponseOrigin(response, sourceUrl) {
  if (response.url && new URL(response.url).origin !== new URL(sourceUrl).origin) {
    throw new OfflineDownloadError("cross-origin", "Offline downloads require audio from this site.");
  }
}

// Keep at most one storage chunk plus the current network buffer in memory.
async function* splitAudioRange(body, length, chunkSize, readNetwork) {
  const incomplete = () => new OfflineDownloadError("incomplete", "The audio range has an unexpected length.");
  if (!body) throw incomplete();
  const reader = body.getReader();
  let remaining = length;
  let chunk = new Uint8Array(Math.min(remaining, chunkSize));
  let filled = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await readNetwork(async () => {
        let part;
        do { part = await reader.read(); } while (!part.done && !part.value.byteLength);
        return part;
      });
      if (done) break;
      if (value.byteLength > remaining) throw incomplete();
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(chunk.length - filled, value.byteLength - offset);
        chunk.set(value.subarray(offset, offset + count), filled);
        offset += count;
        filled += count;
        remaining -= count;
        if (filled === chunk.length && remaining > 0) {
          yield chunk;
          chunk = new Uint8Array(Math.min(remaining, chunkSize));
          filled = 0;
        }
      }
    }
    if (remaining !== 0) throw incomplete();
    finished = true;
    yield chunk;
  } finally {
    if (!finished) void reader.cancel().catch(() => { /* The network may already have aborted. */ });
    reader.releaseLock();
  }
}

export async function inspectAudioRange(fetchImpl, url, sourceMime, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Range: "bytes=0-0", [OFFLINE_DOWNLOAD_HEADER]: "1" },
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  const range = parseContentRange(response.headers.get("content-range"));
  try { await response.body?.cancel(); } catch {}
  validateResponseOrigin(response, url);
  if (response.status !== 206 || !range || range.start !== 0 || range.end !== 0) {
    throw new OfflineDownloadError("range", "The audio server does not support offline downloads.");
  }
  const mime = validateAudioMime(response, sourceMime);
  return {
    mime,
    totalSize: range.total,
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
    responseDate: response.headers.get("date") || "",
  };
}

async function fetchAudioRange(fetchImpl, manifest, start, end, validator, signal) {
  const headers = { Range: `bytes=${start}-${end}`, [OFFLINE_DOWNLOAD_HEADER]: "1" };
  if (validator) headers["If-Range"] = validator;
  const response = await fetchImpl(manifest.sourceUrl, {
    headers,
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
  try {
    validateResponseOrigin(response, manifest.sourceUrl);
    const range = parseContentRange(response.headers.get("content-range"));
    const responseVersion = response.headers.get(manifest.etag ? "etag" : "last-modified");
    if (response.status !== 206 || !range || range.start !== start || range.end !== end || range.total !== manifest.totalSize
      || (validator && responseVersion !== null && responseVersion !== validator)) {
      throw new OfflineDownloadError("changed", "The audio file changed during the download.");
    }
    validateAudioMime(response, manifest.mime, manifest.mime);
    return response;
  } catch (error) {
    await response.body?.cancel();
    throw error;
  }
}

async function* readAudioRange(fetchImpl, manifest, start, end, validator, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(createAbortError("Download canceled"));
  checkCanceled(signal);
  signal?.addEventListener("abort", cancel, { once: true });

  // Only network waits count. Playback and Cache Storage can suspend the consumer between chunks.
  async function readNetwork(read) {
    if (controller.signal.aborted) throw controller.signal.reason;
    const timer = setTimeout(() => controller.abort(new OfflineDownloadError("timeout", "No audio data received.")), RANGE_IDLE_TIMEOUT_MS);
    let interrupt;
    const interrupted = new Promise((_, reject) => { interrupt = () => reject(controller.signal.reason); });
    controller.signal.addEventListener("abort", interrupt, { once: true });
    try { return await Promise.race([interrupted, read()]); }
    finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", interrupt);
    }
  }
  try {
    const response = await readNetwork(() => fetchAudioRange(fetchImpl, manifest, start, end, validator, controller.signal));
    yield* splitAudioRange(response.body, end - start + 1, manifest.chunkSize, readNetwork);
  } finally {
    signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

export async function* downloadChunks(fetchImpl, manifest, signal, waitForPriority) {
  const completed = new Set(manifest.completed);
  const validator = rangeValidator(manifest);
  let index = 0;
  while (index < manifest.totalChunks) {
    if (completed.has(index)) { index++; continue; }
    const { start, end: chunkEnd } = chunkBounds(index, manifest.totalSize, manifest.chunkSize);
    // Without a validator all bytes must come from the same HTTP response.
    const end = validator ? chunkEnd : manifest.totalSize - 1;
    await waitForPriority(signal);
    checkCanceled(signal);
    for await (const bytes of readAudioRange(fetchImpl, manifest, start, end, validator, signal)) {
      checkCanceled(signal);
      const chunkStart = index * manifest.chunkSize;
      const headers = {
        "content-type": manifest.mime,
        "content-length": String(bytes.length),
        "x-compact-player-start": String(chunkStart),
        "x-compact-player-end": String(chunkStart + bytes.length - 1),
      };
      yield { index, chunk: new Response(bytes, { headers }) };
      index++;
      if (!validator && index < manifest.totalChunks) {
        await waitForPriority(signal);
        checkCanceled(signal);
      }
    }
  }
}
