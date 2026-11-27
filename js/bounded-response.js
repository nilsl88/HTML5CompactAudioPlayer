globalThis.CompactPlayerResponse = (() => {
  const coverMaxBytes = 16 * 1024 ** 2;

  function isHtmlResponse(response) {
    const type = response.headers?.get?.("content-type")?.split(";", 1)[0].trim().toLowerCase();
    return type === "text/html" || type === "application/xhtml+xml";
  }

  function cancelResponseBody(stream) {
    void stream?.cancel().catch(() => { /* The response body may already have failed. */ });
  }

  async function readResponseBytes(body, maxBytes, signal) {
    if (signal?.aborted) {
      cancelResponseBody(body);
      throw signal.reason;
    }
    let bytes = new Uint8Array(0);
    if (!body) return bytes;
    const reader = body.getReader();
    let offset = 0;
    let ended = false;
    const cancel = () => {
      if (ended) return;
      ended = true;
      cancelResponseBody(reader);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (!ended) {
        const { done, value } = await reader.read();
        if (signal?.aborted) throw signal.reason;
        ended = done;
        if (done) break;
        const size = offset + value.byteLength;
        if (size > maxBytes) return null;
        if (size > bytes.length) {
          const expanded = new Uint8Array(Math.min(maxBytes, Math.max(size, bytes.length * 2)));
          expanded.set(bytes.subarray(0, offset));
          bytes = expanded;
        }
        bytes.set(value, offset);
        offset = size;
      }
      return bytes.subarray(0, offset);
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  }

  function responseWithDecodedBody(response, bytes) {
    // Fetch exposes decoded bytes, even when the server sends a compressed response.
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
  }

  return { coverMaxBytes, isHtmlResponse, cancelResponseBody, readResponseBytes, responseWithDecodedBody };
})();
