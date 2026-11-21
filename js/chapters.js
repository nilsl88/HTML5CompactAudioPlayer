import { fetchTextWithRetry } from "./utils.js";
import { parseWebVtt } from "./vtt.js";
import { loadEmbeddedMp4Chapters } from "./mp4-chapters.js";

export const CHAPTER_REQUEST_TIMEOUT_MS = 20000;

export function parseChapterText(text) {
  const value = String(text || "");
  const cues = parseWebVtt(value);
  // Older chapter files can omit the header but still contain usable timestamped cues.
  if (!/^\uFEFF?WEBVTT(?=[ \t\r\n]|$)/.test(value) && (!cues.length || /^\s*</.test(value))) return null;
  return { text: value, cues };
}

export async function loadChapterFile(url, {
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS,
  revalidate = false,
} = {}) {
  const response = await fetchTextWithRetry(url, {
    fetchImpl,
    cache: revalidate ? "no-cache" : "default",
    credentials: "same-origin",
    signal,
    timeoutMs,
  });
  if (!response.ok) throw new Error(`Chapter request failed with HTTP ${response.status}.`);
  const chapters = parseChapterText(response.text);
  if (!chapters) throw new Error("The chapter file does not contain WebVTT.");
  return chapters;
}

export async function loadChapters({ mode = "none", vttUrl = "", sourceUrl = "", sourceMime = "", signal, fetchImpl = globalThis.fetch, timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS, revalidate = false } = {}) {
  if (mode === "none") return { kind: "none", text: "", cues: [] };
  const canReadEmbedded = /^audio\/mp4(?:;|$)/i.test(String(sourceMime)) || /\.(?:m4a|m4b)(?:[?#]|$)/i.test(String(sourceUrl));
  const loadEmbedded = async () => {
    if (!canReadEmbedded || !sourceUrl) throw new Error("The active source does not contain readable MP4 chapters.");
    return { kind: "embedded", text: "", cues: await loadEmbeddedMp4Chapters(sourceUrl, { signal, fetchImpl, timeoutMs }) };
  };
  if (mode === "embedded") return loadEmbedded();
  if (mode === "vtt") {
    if (!vttUrl) return { kind: "vtt", text: "", cues: [] };
    return { kind: "vtt", ...await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs, revalidate }) };
  }
  if (mode === "auto") {
    let vttError;
    if (vttUrl) {
      try {
        const result = { kind: "vtt", ...await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs, revalidate }) };
        if (result.cues.length) return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        vttError = error;
      }
    }
    if (canReadEmbedded && sourceUrl) {
      const result = await loadEmbedded();
      if (result.cues.length || !vttError) return result;
    }
    if (vttError) throw vttError;
  }
  return { kind: "none", text: "", cues: [] };
}
