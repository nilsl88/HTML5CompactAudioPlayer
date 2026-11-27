// Loaded by the classic service worker. readChunk returns the response for one saved audio chunk.
function parseRange(value, totalSize) {
  if (!value) return { start: 0, end: totalSize - 1, partial: false };
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) return null;
    end = Math.min(end, totalSize - 1);
  }
  return { start, end, partial: true };
}

async function readStoredAudioChunk(response, expected, signal) {
  const bytes = new Uint8Array(expected);
  const { readVerifiedChunk } = globalThis.CompactPlayerOfflineManifest;
  return await readVerifiedChunk(response, expected, signal, bytes) ? bytes : null;
}

async function downloadedMediaResponse(request, manifest, readChunk, {
  readBody = readStoredAudioChunk, reportInvalidChunk = () => {}, finish = () => {},
} = {}) {
  const { chunkByteLength, strongETag, strongLastModified, versionHeader, versionHeaderValue,
    bookHeader, bookHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const headers = {
    "accept-ranges": "bytes",
    "content-length": String(manifest.totalSize),
    "content-type": manifest.mime,
    [versionHeader]: versionHeaderValue(manifest.cacheVersion),
    [bookHeader]: bookHeaderValue(manifest.episodeId, manifest.configBookId),
  };
  const etag = strongETag(manifest.etag);
  const lastModified = strongLastModified(manifest);
  if (etag) headers.etag = etag;
  if (lastModified) headers["last-modified"] = lastModified;
  if (request.method === "HEAD") return new Response(null, { headers });

  const condition = request.headers.get("if-range");
  const allowRange = condition === null || (condition !== "" && (condition === etag || condition === lastModified));
  const range = parseRange(allowRange ? request.headers.get("range") : null, manifest.totalSize);
  if (!range) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${manifest.totalSize}` } });
  }
  const firstChunk = Math.floor(range.start / manifest.chunkSize);
  const lastChunk = Math.floor(range.end / manifest.chunkSize);
  let index = firstChunk;
  let firstResponse = await readChunk(index, request.signal);
  if (!firstResponse) {
    reportInvalidChunk(index);
    return null;
  }
  const streamAbort = new AbortController();
  const { signal } = streamAbort;
  let abortRequest;
  const finishStream = () => {
    request.signal.removeEventListener("abort", abortRequest);
    finish();
  };
  const cancelStream = (reason) => {
    streamAbort.abort(reason);
    void firstResponse?.body?.cancel().catch(() => { /* An unread chunk can already have errored. */ });
    firstResponse = null;
    finishStream();
  };
  const stream = new ReadableStream({
    start(controller) {
      abortRequest = () => {
        controller.error(request.signal.reason);
        cancelStream(request.signal.reason);
      };
      if (request.signal.aborted) abortRequest();
      else request.signal.addEventListener("abort", abortRequest, { once: true });
    },
    async pull(controller) {
      try {
        const response = firstResponse || await readChunk(index, signal);
        firstResponse = null;
        if (signal.aborted) return;
        if (!response) {
          reportInvalidChunk(index);
          throw new Error("A downloaded audio chunk is missing.");
        }
        let data;
        try { data = await readBody(response, chunkByteLength(manifest, index), signal); }
        catch (error) {
          if (!signal.aborted && error?.name !== "TimeoutError" && error?.name !== "AbortError") reportInvalidChunk(index);
          throw error;
        }
        if (signal.aborted) return;
        if (!data) {
          reportInvalidChunk(index);
          throw new Error("A downloaded audio chunk is incomplete.");
        }
        const chunkStart = index * manifest.chunkSize;
        const from = Math.max(0, range.start - chunkStart);
        const to = Math.min(data.length, range.end - chunkStart + 1);
        controller.enqueue(data.subarray(from, to));
        if (++index > lastChunk) {
          controller.close();
          finishStream();
        }
      } catch (error) {
        if (!signal.aborted) finishStream();
        throw error;
      }
    },
    cancel: cancelStream,
  }, { highWaterMark: 0 });
  if (range.partial) {
    headers["content-length"] = String(range.end - range.start + 1);
    headers["content-range"] = `bytes ${range.start}-${range.end}/${manifest.totalSize}`;
  }
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}

function createOfflineAudioRoutes({ scope, readActive, openCache, withAudioCacheDeadline, bodyTimeoutMs, reportDamage }) {
  const { matchesChunkHeaders, offlineChunkUrl } = globalThis.CompactPlayerOfflineManifest;
  const { cancelResponseBody } = globalThis.CompactPlayerResponse;

  function readChunk(cache, manifest, index, parent) {
    return withAudioCacheDeadline(async (signal) => {
      const response = await cache.match(offlineChunkUrl(scope, manifest.downloadId, index));
      if (!signal.aborted && matchesChunkHeaders(response, manifest, index)) return response;
      cancelResponseBody(response?.body);
      return null;
    }, parent);
  }

  function cachedMediaResponse(request, manifest, cache, finish = () => {}) {
    return downloadedMediaResponse(request, manifest, (index, parent) => readChunk(cache, manifest, index, parent), {
      readBody: (response, expected, parent) => withAudioCacheDeadline(
        (signal) => readStoredAudioChunk(response, expected, signal), parent, bodyTimeoutMs),
      reportInvalidChunk: (index) => finish(reportDamage(cache, manifest, index)),
      finish,
    });
  }

  async function cachedAudioRequest(request, { manifest, cache }, signal, finish = () => {}) {
    if (request.method === "HEAD") {
      const first = await readChunk(cache, manifest, 0, signal);
      cancelResponseBody(first?.body);
      if (!first) {
        if (!signal?.aborted) finish(reportDamage(cache, manifest, 0));
        return null;
      }
    }
    const media = await cachedMediaResponse(request, manifest, cache, finish);
    if (!signal?.aborted) return media;
    cancelResponseBody(media?.body);
    return null;
  }

  async function savedAudioResponse(request, url, finish) {
    try {
      const download = await withAudioCacheDeadline(async (signal) => {
        const manifest = await readActive(signal);
        if (signal.aborted || !manifest || url.searchParams.get("download") !== manifest.downloadId) return null;
        const cache = await openCache(manifest.cacheName);
        return { manifest, cache };
      }, request.signal);
      if (download) {
        const media = await cachedAudioRequest(request, download, request.signal, finish);
        if (media) return media;
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      if (request.signal.aborted) throw error;
      console.warn("[CompactAudioPlayer] Could not read saved audio.", error);
      return new Response(null, { status: 503 });
    }
  }

  return { cachedMediaResponse, cachedAudioRequest, savedAudioResponse };
}
