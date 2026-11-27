import { createAbortError, fetchWithRetry } from "./utils.js?v=25";
import "./bounded-response.js?v=25";
import "./offline-manifest.js?v=25";

const { versionHeader } = globalThis.CompactPlayerOfflineManifest;
const { isHtmlResponse } = globalThis.CompactPlayerResponse;

async function probeStatus(fetchImpl, url, options, signal, timeoutMs) {
  try {
    const state = await fetchWithRetry(url, {
      ...options, fetchImpl, signal, timeoutMs, retries: 1, cache: "no-store", credentials: "same-origin",
    }, (response) => {
      void response.body?.cancel()?.catch(() => { /* A canceled fetch may have closed the stream. */ });
      if (response.headers?.get?.(versionHeader) != null) return "unknown";
      // Some static hosts return an HTML page at missing media URLs with a success status.
      if (response.ok && isHtmlResponse(response)) return "unknown";
      return stateFromStatus(response.status);
    });
    if (signal?.aborted) throw createAbortError();
    return state;
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unknown";
  }
}

function stateFromStatus(status) {
  if ([200, 206, 401, 403].includes(status)) return "available";
  if (status === 404 || status === 410) return "missing";
  return "unknown";
}

function combineProbeResults(head, range) {
  if (head === "available" || range === "available") return "available";
  return head === "missing" && range === "missing" ? "missing" : "unknown";
}

export async function probeUrl(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = 8000 } = {}) {
  if (!url || signal?.aborted) return "unknown";
  const head = await probeStatus(fetchImpl, url, { method: "HEAD" }, signal, timeoutMs);
  if (head === "available") return head;
  const range = await probeStatus(fetchImpl, url, { method: "GET", headers: { Range: "bytes=0-0" } }, signal, timeoutMs);
  return combineProbeResults(head, range);
}

export async function scanSources(sources, options = {}) {
  const { concurrency = 3, signal, onResult } = options;
  const results = sources.map((source) => ({ ...source }));
  let next = 0;
  async function worker() {
    while (next < sources.length && !signal?.aborted) {
      const index = next;
      next += 1;
      const source = results[index];
      const availability = await probeUrl(source.url, options);
      if (signal?.aborted) return;
      source.availability = availability;
      onResult?.(source, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return results;
}
