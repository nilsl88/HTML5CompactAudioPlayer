import { isMp4Audio } from "./codecs.js?v=19";
import { fetchWithRetry, metadataRequestCache } from "./utils.js?v=19";
import { parseWebVtt } from "./vtt.js?v=19";
import { loadEmbeddedMp4Chapters } from "./mp4-chapters.js?v=19";
import "./offline-manifest.js?v=19";

const { checkResponseVersion } = globalThis.CompactPlayerOfflineManifest;

export const CHAPTER_REQUEST_TIMEOUT_MS = 20000;

function embeddedChapters(cues) {
  return { kind: "embedded", text: "", cues };
}

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
  bookIdentity,
} = {}) {
  const text = await fetchWithRetry(url, {
    fetchImpl,
    cache: metadataRequestCache(cacheVersion, revalidate),
    credentials: "same-origin",
    signal,
    timeoutMs,
  }, (response) => {
    if (!response.ok) throw new Error(`Chapter request failed with HTTP ${response.status}.`);
    checkResponseVersion(response, cacheVersion, bookIdentity);
    return response.text();
  });
  const chapters = parseChapterText(text);
  if (!chapters) throw new Error("The chapter file does not contain WebVTT.");
  return chapters;
}

export async function loadChapters({
  mode = "none", vttUrl = "", sourceUrl = "", sourceMime = "", cacheVersion, bookIdentity,
  signal, fetchImpl = globalThis.fetch, timeoutMs = CHAPTER_REQUEST_TIMEOUT_MS, revalidate = false, cache,
  online = true, fallbackCues, onFallback,
} = {}) {
  const empty = { kind: "none", text: "", cues: [] };
  if (mode === "none") return empty;
  const cached = revalidate ? null : cache?.read();
  if (cached?.kind === "embedded" && (mode === "embedded" || (mode === "auto" && !vttUrl))) {
    return embeddedChapters(cached.cues);
  }
  const save = (result) => {
    if (!signal?.aborted) cache?.write(result);
    return result;
  };
  const loadVtt = async () => {
    const parsed = cached?.kind === "vtt" && parseChapterText(cached.text);
    if (parsed) return { kind: "vtt", ...parsed };
    cache?.beginWrite();
    const result = await loadChapterFile(vttUrl, { signal, fetchImpl, timeoutMs, cacheVersion, bookIdentity, revalidate: revalidate || Boolean(cached) });
    return save({ kind: "vtt", ...result });
  };
  const canReadEmbedded = isMp4Audio({ mime: sourceMime, url: sourceUrl });
  const loadEmbedded = async () => {
    if (!canReadEmbedded || !sourceUrl) return empty;
    if (fallbackCues?.length) return embeddedChapters(fallbackCues);
    const stored = cached?.kind === "vtt" ? cache.readSource() : cached;
    if (stored?.kind === "embedded") return embeddedChapters(stored.cues);
    cache?.beginWrite();
    const cues = await loadEmbeddedMp4Chapters(sourceUrl, { signal, fetchImpl, timeoutMs, cacheVersion, bookIdentity });
    return save(embeddedChapters(cues));
  };
  if (mode === "embedded") return loadEmbedded();
  if (mode === "vtt") {
    if (!vttUrl) return { kind: "vtt", text: "", cues: [] };
    return loadVtt();
  }
  if (mode === "auto") {
    let vttError;
    if (vttUrl) {
      // A validated empty VTT has its own cache entry. Embedded cues alone leave the VTT lookup pending.
      if (cached?.kind === "embedded" && cached.cues.length) {
        const fallback = { ...embeddedChapters(cached.cues), retryVtt: true };
        if (!online) return fallback;
        onFallback?.(fallback);
      }
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
      if (!vttError) return result;
      if (result.cues.length) return { ...result, retryVtt: true };
    }
    if (vttError) throw vttError;
  }
  return empty;
}
