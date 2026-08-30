export const UNKNOWN_TIME = "—:—";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeLanguageTag(value) {
  const base = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return ({ no: "nb", nn: "nb", dk: "da" })[base] || base;
}

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}

export function safeUrl(value, baseUrl, { allowImageData = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allowImageData && /^data:image\/(?:png|jpeg|gif|webp|avif);/i.test(raw)) return raw;
  try {
    const url = new URL(raw, baseUrl);
    if (!/^(?:https?:)$/i.test(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "";
  }
}

export function createAbortError(message = "Operation canceled") {
  try { return new DOMException(message, "AbortError"); }
  catch { const error = new Error(message); error.name = "AbortError"; return error; }
}

export async function fetchWithRetry(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    retries = 2,
    timeoutMs = 8000,
    signal,
    retryDelayMs = 500,
    ...fetchOptions
  } = options;

  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (signal?.aborted) throw createAbortError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === retries - 1) return response;
      lastError = new Error(`Request failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === retries - 1) throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
    await new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const timer = setTimeout(finish, retryDelayMs * (attempt + 1));
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(createAbortError()); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  throw lastError || new Error("Request failed");
}

export function clearChildren(element) {
  element?.replaceChildren();
}

export function setText(element, value) {
  if (element) element.textContent = String(value ?? "");
}
