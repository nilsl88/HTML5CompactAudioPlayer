import { fetchWithRetry } from "./utils.js";
import { parseWebVtt } from "./vtt.js";
import { loadEmbeddedMp4Chapters } from "./mp4-chapters.js";

export const CHAPTER_REQUEST_TIMEOUT_MS = 20000;

export function parseChapterText(text) {
  const value = String(text || "");
  return { text: value, cues: parseWebVtt(value) };
}

export async function loadChapterFile(url, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS,
} = {}) {
  const response = await fetchWithRetry(url, {
    fetchImpl,
    cache: "default",
    credentials: "same-origin",
    signal,
    timeoutMs,
  });
  if (!response.ok) throw new Error(`Chapter request failed with HTTP ${response.status}.`);
  return parseChapterText(await response.text());
}

export async function loadChapters({ mode = "none", vttUrl = "", sourceUrl = "", sourceMime = "", signal, fetchImpl = globalThis.fetch, timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS } = {}) {
  if (mode === "none") return { kind: "none", text: "", cues: [] };
  const canReadEmbedded = /^audio\/mp4(?:;|$)/i.test(String(sourceMime)) || /\.(?:m4a|m4b)(?:[?#]|$)/i.test(String(sourceUrl));
  const loadEmbedded = async () => {
    if (!canReadEmbedded || !sourceUrl) throw new Error("The active source does not contain readable MP4 chapters.");
    return { kind: "embedded", text: "", cues: await loadEmbeddedMp4Chapters(sourceUrl, { signal, fetchImpl, timeoutMs }) };
  };
  if (mode === "embedded") return loadEmbedded();
  if (mode === "vtt") {
    if (!vttUrl) return { kind: "vtt", text: "", cues: [] };
    return { kind: "vtt", ...await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs }) };
  }
  if (mode === "auto") {
    if (vttUrl) {
      try {
        const result = { kind: "vtt", ...await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs }) };
        if (result.cues.length) return result;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }
    try { return await loadEmbedded(); }
    catch (error) {
      if (error?.name === "AbortError") throw error;
      return { kind: "none", text: "", cues: [] };
    }
  }
  return { kind: "none", text: "", cues: [] };
}
