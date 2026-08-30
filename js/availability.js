async function cancelBody(response) {
  try { await response.body?.cancel(); } catch {}
}

async function requestProbe(fetchImpl, url, options, signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, cache: "no-store", credentials: "same-origin", signal: controller.signal }); }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}

function stateFromStatus(status) {
  if ((status >= 200 && status < 300) || status === 401 || status === 403) return "available";
  if (status === 404 || status === 410) return "missing";
  return "unknown";
}

export async function probeUrl(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = 8000 } = {}) {
  if (!url || signal?.aborted) return "unknown";
  let headState = "unknown";
  try {
    const head = await requestProbe(fetchImpl, url, { method: "HEAD" }, signal, timeoutMs);
    headState = stateFromStatus(head.status);
    await cancelBody(head);
    if (headState === "available") return headState;
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  try {
    const range = await requestProbe(fetchImpl, url, { method: "GET", headers: { Range: "bytes=0-0" } }, signal, timeoutMs);
    const rangeState = stateFromStatus(range.status);
    await cancelBody(range);
    return rangeState === "unknown" ? (headState === "missing" ? "unknown" : headState) : rangeState;
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unknown";
  }
}

export async function scanSources(sources, options = {}) {
  const { concurrency = 3, signal, onResult } = options;
  let next = 0;
  async function worker() {
    while (next < sources.length && !signal?.aborted) {
      const index = next;
      next += 1;
      const source = sources[index];
      const availability = await probeUrl(source.url, options);
      if (signal?.aborted) return;
      source.availability = availability;
      onResult?.(source, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return sources;
}
