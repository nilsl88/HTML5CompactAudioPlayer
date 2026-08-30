import test from "node:test";
import assert from "node:assert/strict";
import { CHAPTER_REQUEST_TIMEOUT_MS, loadChapterFile, loadChapters } from "../js/chapters.js";
import { loadEmbeddedMp4Chapters, loadEmbeddedMp4Cover } from "../js/mp4-chapters.js";

function concatBytes(...values) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function atom(type, payload) {
  const bytes = new Uint8Array(8 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length, false);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function neroMetadata() {
  const title1 = new TextEncoder().encode("Intro");
  const title2 = new TextEncoder().encode("Chapter 1");
  const payload = new Uint8Array(27 + title1.length + title2.length);
  const view = new DataView(payload.buffer);
  payload.set([0, 0, 0, 0, 0, 0, 0, 0, 2]);
  view.setBigUint64(9, 0n, false);
  payload[17] = title1.length;
  payload.set(title1, 18);
  const second = 18 + title1.length;
  view.setBigUint64(second, 600000000n, false);
  payload[second + 8] = title2.length;
  payload.set(title2, second + 9);
  return atom("moov", atom("chpl", payload));
}

function coverMetadata(image, type) {
  const data = new Uint8Array(8 + image.length);
  new DataView(data.buffer).setUint32(0, type, false);
  data.set(image, 8);
  return {
    file: atom("moov", atom("udta", atom("meta", concatBytes(new Uint8Array(4), atom("ilst", atom("covr", atom("data", data))))))),
    image,
  };
}

function rangedFetch(file, total = 262144) {
  const bytes = new Uint8Array(total);
  bytes.set(file);
  return async (_url, options) => {
    const match = String(options.headers.Range).match(/bytes=(\d+)-(\d+)/);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    return {
      status: 206,
      headers: { get: (name) => name === "Content-Range" ? `bytes ${start}-${end}/${total}` : null },
      arrayBuffer: async () => bytes.slice(start, end + 1).buffer,
    };
  };
}

test("chapter requests use the browser cache and parse WebVTT", async () => {
  let requestOptions;
  const fetchImpl = async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      text: async () => "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nOpening",
    };
  };

  const result = await loadChapterFile("https://example.test/chapters.vtt", { fetchImpl });

  assert.equal(requestOptions.cache, "default");
  assert.equal(requestOptions.credentials, "same-origin");
  assert.equal(result.cues[0].title, "Opening");
  assert.equal(CHAPTER_REQUEST_TIMEOUT_MS, 20000);
});

test("chapter requests report HTTP failures", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    loadChapterFile("https://example.test/missing.vtt", { fetchImpl }),
    /HTTP 404/,
  );
});

test("reads Nero embedded chapters with one metadata range", async () => {
  const chapters = await loadEmbeddedMp4Chapters("https://example.test/book.m4b", { fetchImpl: rangedFetch(neroMetadata()) });
  assert.deepEqual(chapters, [
    { start: 0, end: 60, title: "Intro" },
    { start: 60, end: null, title: "Chapter 1" },
  ]);
});

test("reads JPEG cover artwork from MP4 metadata", async () => {
  const metadata = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 13);
  const cover = await loadEmbeddedMp4Cover("https://example.test/book.m4b", { fetchImpl: rangedFetch(metadata.file) });
  assert.equal(cover.mime, "image/jpeg");
  assert.deepEqual(cover.data, metadata.image);
});

test("reads PNG cover artwork from MP4 metadata", async () => {
  const metadata = coverMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), 14);
  const cover = await loadEmbeddedMp4Cover("https://example.test/book.m4a", { fetchImpl: rangedFetch(metadata.file) });
  assert.equal(cover.mime, "image/png");
  assert.deepEqual(cover.data, metadata.image);
});

test("auto mode keeps usable WebVTT ahead of embedded metadata", async () => {
  let requests = 0;
  const result = await loadChapters({
    mode: "auto",
    vttUrl: "https://example.test/chapters.vtt",
    sourceUrl: "https://example.test/book.m4b",
    sourceMime: "audio/mp4; codecs=\"mp4a.40.2\"",
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200, text: async () => "WEBVTT\n\n00:00.000 --> 00:10.000\nOpening" };
    },
  });
  assert.equal(result.kind, "vtt");
  assert.equal(result.cues[0].title, "Opening");
  assert.equal(requests, 1);
});
