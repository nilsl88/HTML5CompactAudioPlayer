import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { openPlayerPage } from "./player-page.mjs";
import { CHAPTER_REQUEST_TIMEOUT_MS, loadChapterFile, loadChapters } from "../js/chapters.js";
import { decodeMp4ChapterTitle, loadEmbeddedMp4Chapters, loadEmbeddedMp4Cover } from "../js/mp4-chapters.js";

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

for (const [format, load] of [["WebVTT", loadChapterFile], ["MP4", loadEmbeddedMp4Chapters]]) {
  test(`canceling a ${format} chapter request interrupts a body that is already being read`, async () => {
    const outer = new AbortController();
    let transport, response, body;
    const fetchImpl = async (_url, { signal }) => {
      transport = signal;
      const stream = new ReadableStream({ start(controller) { body = controller; } });
      signal.addEventListener("abort", () => body.error(signal.reason), { once: true });
      response = new Response(stream, { status: 206, headers: { "content-range": "bytes 0-7/8" } });
      return response;
    };
    const result = load("https://example.test/chapters", { fetchImpl, signal: outer.signal });
    await settle();
    assert.ok(response.bodyUsed);
    outer.abort();
    const aborted = transport.aborted;
    if (!aborted) body.close();
    await assert.rejects(result, { name: "AbortError" });
    assert.ok(aborted);
  });
}

test("reads Nero embedded chapters with one metadata range", async () => {
  const chapters = await loadEmbeddedMp4Chapters("https://example.test/book.m4b", { fetchImpl: rangedFetch(neroMetadata()) });
  assert.deepEqual(chapters, [
    { start: 0, end: 60, title: "Intro" },
    { start: 60, end: null, title: "Chapter 1" },
  ]);
});

test("embedded chapters show an empty state on Opus and reload on AAC selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = { id: "book", defaultLanguage: "en", debug: { showAllQualities: true }, languages: {
    en: { chapterSource: "embedded", sources: { opus: { 96: "book.webm" }, aac: { 96: "book.m4b" } } },
  } };
  const requests = [];
  const fetchRange = rangedFetch(neroMetadata());
  const { audio, elements } = await openPlayerPage(t, book, (url, options) => {
    requests.push(url);
    return fetchRange(url, options);
  });
  const list = elements.get("chaptersList");
  assert.equal(list.children[0].textContent, "No chapters for this audio source.");
  assert.deepEqual(requests, []);
  assert.equal(elements.get("nextChapterBtn").disabled, true);
  const quality = elements.get("qualitySelect");
  quality.value = "aac-96";
  quality.dispatchEvent(new Event("change"));
  await settle();
  assert.deepEqual(requests, ["https://example.test/media/book/book.m4b"]);
  assert.equal(list.children[0].children[0].textContent, "Intro");
  assert.equal(elements.get("nextChapterBtn").disabled, false);
  assert.ok(!audio.src);
});

test("reconnecting retries failed embedded chapters without a WebVTT URL", async (t) => {
  for (const mode of ["embedded", "auto"]) {
    await t.test(mode, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const errors = t.mock.method(console, "error", () => {});
      const book = {
        id: "book", defaultLanguage: "en",
        languages: { en: { chapterSource: mode, sources: { aac: { 128: "book.m4b" } } } },
      };
      const metadata = rangedFetch(neroMetadata());
      const requests = [];
      const { audio, elements, navigator, window } = await openPlayerPage(t, book, (url, options) => {
        requests.push({ url, range: options.headers?.Range });
        if (requests.length === 1) return new Response(null, { status: 404 });
        return metadata(url, options);
      });
      const list = elements.get("chaptersList");
      assert.equal(requests.length, 1);
      assert.equal(list.children[0].className, "chapter-load-error");
      navigator.onLine = false;
      window.dispatchEvent(new Event("offline"));
      navigator.onLine = true;
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      await settle();
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0]);
      assert.equal(list.children[0].children[0].textContent, "Intro");
      assert.ok(!audio.src);
      assert.equal(errors.mock.callCount(), 1);
    });
  }
});

test("an unordered embedded cache reloads the chapter list and current title from the active source", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = "https://example.test/media/book/audio.m4b";
  const book = { id: "book", defaultLanguage: "en", languages: {
    en: { chapterSource: "embedded", sources: { aac: { 96: "audio.m4b" } } },
  } };
  const sourceKey = "embedded:" + url;
  const cacheKey = "compactPlayer@%2F:compactPlayer:chapters:book:en:1:" + encodeURIComponent(sourceKey);
  const saved = new Map([[cacheKey, JSON.stringify({ kind: "embedded", sourceKey,
    cues: [{ start: 30, end: null, title: "Later" }, { start: 0, end: 30, title: "Opening" }] })]]);
  const requests = [];
  const range = rangedFetch(neroMetadata());
  const { elements } = await openPlayerPage(t, book, (url, options) => {
    requests.push(url);
    return range(url, options);
  }, saved);
  assert.deepEqual(requests, [url]);
  assert.deepEqual(elements.get("chaptersList").children.map((row) => row.children[0].textContent), ["Intro", "Chapter 1"]);
  assert.match(elements.get("bookMeta").textContent, /Intro$/);
  assert.deepEqual(JSON.parse(saved.get(cacheKey)).cues.map((cue) => cue.start), [0, 60]);
});

test("finds MP4 metadata after a large media-data atom", async () => {
  const metadata = neroMetadata();
  const total = 17 * 1024 * 1024;
  const moovStart = total - metadata.length;
  const file = new Uint8Array(total);
  const view = new DataView(file.buffer);
  view.setUint32(0, moovStart, false);
  file.set(new TextEncoder().encode("mdat"), 4);
  file.set(metadata, moovStart);
  const chapters = await loadEmbeddedMp4Chapters("https://example.test/large-book.m4b", { fetchImpl: rangedFetch(file, total) });
  assert.equal(chapters.length, 2);
  assert.equal(chapters[1].title, "Chapter 1");
});

test("decodes QuickTime chapter text without trailing format data", () => {
  const title = new TextEncoder().encode("Opening Credits");
  const sample = concatBytes(new Uint8Array([0, title.length]), title, new TextEncoder().encode("encd"), new Uint8Array([0, 0, 0, 1]));
  assert.equal(decodeMp4ChapterTitle(sample), "Opening Credits");
});

test("reads JPEG cover artwork from MP4 metadata", async () => {
  const metadata = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 13);
  const cover = await loadEmbeddedMp4Cover("https://example.test/book.m4b", { fetchImpl: rangedFetch(metadata.file) });
  assert.equal(cover.mime, "image/jpeg");
  assert.deepEqual(cover.data, metadata.image);
});

test("a late cover image load after a language change cannot replace the current cover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { file } = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 13);
  const range = rangedFetch(file);
  const revoked = t.mock.method(URL, "revokeObjectURL");
  const { elements, audio } = await openPlayerPage(t, {
    id: "sample", defaultLanguage: "en", title: { en: "One", da: "To" }, coverSource: "embedded",
    languages: { en: { sources: { aac: { 96: "en.m4b" } } }, da: { sources: { aac: { 96: "da.m4b" } } } },
  }, range);
  const image = elements.get("coverImg");
  const firstUrl = image.src;
  const oldLoad = image.onload;
  assert.match(firstUrl, /^blob:/);
  const language = elements.get("langSelect");
  language.value = "da";
  language.dispatchEvent(new Event("change"));
  await settle();
  assert.ok(revoked.mock.calls.some((call) => call.arguments[0] === firstUrl));
  oldLoad();
  assert.equal(elements.get("coverButton").hidden, true);
  assert.notEqual(image.src, firstUrl);
  image.onload();
  assert.equal(image.alt, "To");
  assert.equal(elements.get("coverButton").hidden, false);
  assert.ok(!audio.src);
});

test("reads PNG cover artwork from MP4 metadata", async () => {
  const metadata = coverMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), 14);
  const cover = await loadEmbeddedMp4Cover("https://example.test/book.m4a", { fetchImpl: rangedFetch(metadata.file) });
  assert.equal(cover.mime, "image/png");
  assert.deepEqual(cover.data, metadata.image);
});

test("shares one MP4 metadata range between chapters and cover", async () => {
  const cover = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 13);
  const file = atom("moov", concatBytes(neroMetadata().subarray(8), cover.file.subarray(8)));
  let requests = 0;
  const baseFetch = rangedFetch(file);
  const fetchImpl = async (...args) => { requests += 1; return baseFetch(...args); };
  const [chapters, artwork] = await Promise.all([
    loadEmbeddedMp4Chapters("https://example.test/shared-book.m4b", { fetchImpl }),
    loadEmbeddedMp4Cover("https://example.test/shared-book.m4b", { fetchImpl }),
  ]);
  assert.equal(chapters.length, 2);
  assert.equal(artwork.mime, "image/jpeg");
  assert.equal(requests, 1);
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
