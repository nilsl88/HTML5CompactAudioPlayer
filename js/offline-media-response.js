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

async function downloadedMediaResponse(request, manifest, readChunk, reportInvalidChunk = async () => {}) {
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
  let firstResponse;
  try { firstResponse = await readChunk(index); }
  catch (error) {
    await reportInvalidChunk(index);
    throw error;
  }
  if (!firstResponse) {
    await reportInvalidChunk(index);
    return null;
  }
  let canceled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      let response;
      try { response = firstResponse || await readChunk(index); }
      catch (error) {
        if (!canceled) await reportInvalidChunk(index);
        throw error;
      }
      firstResponse = null;
      if (canceled) return;
      if (!response) {
        await reportInvalidChunk(index);
        throw new Error("A downloaded audio chunk is missing.");
      }
      let data;
      try { data = new Uint8Array(await response.arrayBuffer()); }
      catch (error) {
        if (!canceled) await reportInvalidChunk(index);
        throw error;
      }
      if (canceled) return;
      const chunkStart = index * manifest.chunkSize;
      if (data.length !== chunkByteLength(manifest, index)) {
        await reportInvalidChunk(index);
        throw new Error("A downloaded audio chunk is incomplete.");
      }
      const from = Math.max(0, range.start - chunkStart);
      const to = Math.min(data.length, range.end - chunkStart + 1);
      controller.enqueue(data.subarray(from, to));
      if (++index > lastChunk) controller.close();
    },
    cancel() { canceled = true; firstResponse = null; },
  }, { highWaterMark: 0 });
  if (range.partial) {
    headers["content-length"] = String(range.end - range.start + 1);
    headers["content-range"] = `bytes ${range.start}-${range.end}/${manifest.totalSize}`;
  }
  return new Response(stream, { status: range.partial ? 206 : 200, headers });
}
