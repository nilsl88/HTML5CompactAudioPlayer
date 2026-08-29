import { fetchWithRetry } from "./utils.js";
import { parseWebVtt } from "./vtt.js";

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
