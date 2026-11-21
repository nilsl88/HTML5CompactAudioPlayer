import { isMp4Audio } from "./codecs.js";
import { fetchWithRetry, metadataRequestCache } from "./utils.js";
import { parseWebVtt } from "./vtt.js";
import { loadEmbeddedMp4Chapters } from "./mp4-chapters.js";
import "./offline-manifest.js";

const { checkResponseVersion } = globalThis.CompactPlayerOfflineManifest;

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
  cacheVersion,
} = {}) {
  const text = await fetchWithRetry(url, {
    fetchImpl,
    cache: metadataRequestCache(cacheVersion, revalidate),
    credentials: "same-origin",
    signal,
    timeoutMs,
  }, (response) => {
    if (!response.ok) throw new Error(`Chapter request failed with HTTP ${response.status}.`);
    checkResponseVersion(response, cacheVersion);
    return response.text();
  });
  const chapters = parseChapterText(text);
  if (!chapters) throw new Error("The chapter file does not contain WebVTT.");
  return chapters;
}

export async function loadChapters({
  mode = "none", vttUrl = "", sourceUrl = "", sourceMime = "", cacheVersion,
  signal, fetchImpl = globalThis.fetch, timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS, revalidate = false, cache,
} = {}) {
  const empty = { kind: "none", text: "", cues: [] };
  if (mode === "none") return empty;
  const cached = revalidate ? null : cache?.read();
  if (cached?.kind === "embedded" && mode !== "vtt") return cached;
  const save = (result) => {
    if (!signal?.aborted) cache?.write(result);
    return result;
  };
  const loadVtt = async () => {
    const parsed = cached?.kind === "vtt" && parseChapterText(cached.text);
    if (parsed) return { kind: "vtt", ...parsed };
    cache?.beginWrite();
    const result = await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs, cacheVersion, revalidate: revalidate || Boolean(cached) });
    return save({ kind: "vtt", ...result });
  };
  const canReadEmbedded = isMp4Audio({ mime: sourceMime, url: sourceUrl });
  const loadEmbedded = async () => {
    if (!canReadEmbedded || !sourceUrl) return empty;
    const stored = cached?.kind === "vtt" && cache.readSource();
    if (stored?.kind === "embedded") return stored;
    cache?.beginWrite();
    const cues = await loadEmbeddedMp4Chapters(sourceUrl, { signal, fetchImpl, timeoutMs, cacheVersion });
    return save({ kind: "embedded", text: "", cues });
  };
  if (mode === "embedded") return loadEmbedded();
  if (mode === "vtt") {
    if (!vttUrl) return { kind: "vtt", text: "", cues: [] };
    return loadVtt();
  }
  if (mode === "auto") {
    let vttError;
    if (vttUrl) {
      try {
        const result = await loadVtt();
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
  return empty;
}
