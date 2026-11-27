export const UNKNOWN_TIME = "—:—";

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeLanguageTag(value) {
  const base = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  if (base === "no" || base === "nn") return "nb";
  return base === "dk" ? "da" : base;
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
  const path = raw.split(/[?#]/, 1)[0].replace(/[\t\r\n]/g, "")
    .replace(/%2e/gi, ".").replace(/%2f|%5c/gi, "/");
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(path)) return "";
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

export function metadataRequestCache(cacheVersion, revalidate = false) {
  return revalidate || cacheVersion != null ? "no-cache" : "default";
}

export async function readBoundedText(response, signal, maxBytes, tooLarge) {
  const body = response.body;
  if (signal?.aborted) {
    void body?.cancel().catch(() => { /* The fetch may already have canceled the stream. */ });
    throw createAbortError();
  }
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let ended = false;
  const cancel = () => {
    if (ended) return;
    ended = true;
    void reader.cancel().catch(() => { /* A failed stream can reject cancellation. */ });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw createAbortError();
      if (done) {
        ended = true;
        return text + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function fetchWithRetry(url, options = {}, readResponse) {
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
    let response;
    try {
      response = await fetchImpl(url, { ...fetchOptions, signal: controller.signal });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === retries - 1) {
        return readResponse ? await readResponse(response, controller.signal) : response;
      }
      lastError = new Error(`Request failed with HTTP ${response.status}`);
      controller.abort();
    } catch (error) {
      // Once headers arrive, the caller decides how to handle a failed body or invalid range.
      if (response || signal?.aborted || attempt === retries - 1) throw error;
      lastError = error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (readResponse) controller.abort();
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

export function fetchTextWithRetry(url, options, readText = (response) => response.text()) {
  return fetchWithRetry(url, options, async (response, signal) => ({
    ok: response.ok, status: response.status, headers: response.headers, text: response.ok ? await readText(response, signal) : "",
  }));
}

export function clearChildren(element) {
  element?.replaceChildren();
}

export function setText(element, value) {
  if (element) element.textContent = String(value ?? "");
}

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isPlayerServiceWorker(worker, baseUrl) {
  try {
    const url = new URL(worker?.scriptURL);
    const scope = new URL(".", baseUrl);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
    const file = url.pathname.slice(scope.pathname.length);
    return file === "sw.js" || /^sw-[a-f0-9]{64}\.js$/.test(file);
  } catch {
    return false;
  }
}
