import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { deferred, Element, openPlayerPage } from "./player-page.mjs";
import { CHAPTER_REQUEST_TIMEOUT_MS, loadChapterFile, loadChapters } from "../js/chapters.js";
import { PlayerStorage } from "../js/storage.js";
import { decodeMp4ChapterTitle, loadEmbeddedMp4Chapters, loadEmbeddedMp4Cover } from "../js/mp4-chapters.js";
import { RangeReader } from "../js/mp4-metadata.js";
import { createCoverView } from "../js/cover.js";
import { ChapterSession } from "../js/chapter-session.js";

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

function neroMetadata(secondStart = 60) {
  const title1 = new TextEncoder().encode("Intro");
  const title2 = new TextEncoder().encode("Chapter 1");
  const payload = new Uint8Array(27 + title1.length + title2.length);
  const view = new DataView(payload.buffer);
  payload.set([0, 0, 0, 0, 0, 0, 0, 0, 2]);
  view.setBigUint64(9, 0n, false);
  payload[17] = title1.length;
  payload.set(title1, 18);
  const second = 18 + title1.length;
  view.setBigUint64(second, BigInt(secondStart) * 10_000_000n, false);
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

test("chapter cache keeps catalog aliases separate even when configuration IDs and URLs match", async () => {
  const values = new Map();
  const records = {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
  };
  const storage = new PlayerStorage(records, "https://example.test/");
  let title = "A";
  let requests = 0;
  const session = new ChapterSession({
    fetchImpl: async () => { requests++; return new Response(`WEBVTT\n\n00:00.000 --> 00:01.000\n${title}`); },
    openCache: storage.chapterCache.bind(storage), onStart() {}, onLoaded() {}, onFailure: assert.fail,
  });
  const book = { id: "same-config", cacheVersion: 1, languages: { en: {
    chapterSource: "vtt", chapters: "chapters.vtt", baseUrl: "https://example.test/shared/",
  } } };
  session.reset(book, "en", null, "catalog-a");
  await session.load();
  assert.equal(session.cues[0].title, "A");
  title = "B";
  session.reset(book, "en", null, "catalog-b");
  await session.load();
  assert.equal(session.cues[0].title, "B");
  assert.equal(requests, 2);
  session.reset(book, "en", null, "catalog-a");
  await session.load();
  assert.equal(session.cues[0].title, "A");
  assert.equal(requests, 2);
});

test("chapter session rejects another downloaded book and retries without caching its cues", async () => {
  const { versionHeader, versionHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const identityHeader = "x-compact-player-offline-book";
  let savedBook = ["catalog-a", "book-a"];
  const writes = [];
  const failures = [];
  const session = new ChapterSession({
    fetchImpl: async () => new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nChapter", {
      headers: { [versionHeader]: versionHeaderValue(1), [identityHeader]: encodeURIComponent(JSON.stringify(savedBook)) },
    }),
    openCache: () => ({ read: () => null, beginWrite() {}, write: (entry) => writes.push(entry) }),
    onStart() {}, onLoaded() {}, onFailure: (error) => failures.push(error),
  });
  const book = { id: "book-b", cacheVersion: 1, languages: { en: {
    chapterSource: "vtt", chapters: "chapters.vtt", baseUrl: "https://example.test/shared/",
  } } };
  session.reset(book, "en", null, "catalog-b");
  await session.load();
  assert.equal(session.status, "failed");
  assert.match(failures[0].message, /different book/i);
  assert.equal(writes.length, 0);
  savedBook = ["catalog-b", "book-b"];
  await session.load({ force: true });
  assert.equal(session.status, "loaded");
  assert.equal(session.cues[0].title, "Chapter");
  assert.equal(writes.length, 1);
});

test("downloaded chapters and MP4 metadata must match the selected book identity", async () => {
  const { versionHeader, versionHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const bookHeader = "x-compact-player-offline-book";
  const identity = { episodeId: "catalog-b", configBookId: "book-b" };
  const cachedHeaders = (episodeId, configBookId) => ({
    [versionHeader]: versionHeaderValue(1),
    [bookHeader]: encodeURIComponent(JSON.stringify([episodeId, configBookId])),
  });
  const text = "WEBVTT\n\n00:00.000 --> 00:01.000\nBook A";
  const url = "https://example.test/shared.vtt";
  const chapterFetch = (episodeId, configBookId) => async () => new Response(text, {
    headers: cachedHeaders(episodeId, configBookId),
  });
  await assert.rejects(loadChapterFile(url, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: chapterFetch("catalog-a", "book-a"),
  }), /different book/i);
  assert.equal((await loadChapterFile(url, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: chapterFetch("catalog-b", "book-b"),
  })).cues[0].title, "Book A");
  assert.equal((await loadChapterFile(url, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: chapterFetch("catalog-b", null),
  })).cues[0].title, "Book A");
  await assert.rejects(loadChapterFile(url, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: async () => new Response(text, { headers: { [versionHeader]: versionHeaderValue(1) } }),
  }), /different book/i);
  assert.equal((await loadChapterFile(url, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: async () => new Response(text),
  })).cues[0].title, "Book A");

  const file = neroMetadata();
  const source = "https://example.test/shared.m4b";
  const range = rangedFetch(file, file.length);
  const mp4Fetch = (episodeId, configBookId) => async (...args) => {
    const response = await range(...args);
    const original = response.headers.get("Content-Range");
    response.headers = new Headers({ "Content-Range": original, ...cachedHeaders(episodeId, configBookId) });
    return response;
  };
  await assert.rejects(loadEmbeddedMp4Chapters(source, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: mp4Fetch("catalog-a", "book-a"),
  }), /different book/i);
  assert.equal((await loadEmbeddedMp4Chapters(source, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: mp4Fetch("catalog-b", "book-b"),
  })).length, 2);
  await assert.rejects(loadEmbeddedMp4Cover(source, {
    cacheVersion: 1, bookIdentity: identity, fetchImpl: mp4Fetch("catalog-a", "book-a"),
  }), /different book/i);
  let requests = 0;
  const savedBookA = mp4Fetch("catalog-a", "book-a");
  const sharedFetch = async (...args) => { requests++; return savedBookA(...args); };
  await Promise.all([
    loadEmbeddedMp4Cover(source, { cacheVersion: 1, bookIdentity: { episodeId: "catalog-a", configBookId: "book-a" }, fetchImpl: sharedFetch }),
    loadEmbeddedMp4Chapters(source, { cacheVersion: 1, bookIdentity: { episodeId: "catalog-a", configBookId: "book-a" }, fetchImpl: sharedFetch }),
  ]);
  assert.equal(requests, 1);
  await assert.rejects(loadEmbeddedMp4Chapters(source, { cacheVersion: 1, bookIdentity: identity, fetchImpl: sharedFetch }), /different book/i);
  assert.equal(requests, 2);
});

test("embedded chapters have the same result from the network and both offline cache paths", async () => {
  const values = new Map();
  const storage = new PlayerStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    key: (index) => [...values.keys()][index],
    get length() { return values.size; },
  });
  const sourceUrl = "https://example.test/offline-edition.m4b";
  const vttUrl = "https://example.test/chapters.vtt";
  const cache = storage.chapterCache("edition", "en", 1, sourceUrl, vttUrl);
  const online = await loadChapters({ mode: "embedded", sourceUrl, cache, fetchImpl: rangedFetch(neroMetadata()) });
  assert.equal(online.cues.length, 2);
  const options = { sourceUrl, cache, fetchImpl: assert.fail };
  assert.deepEqual(await loadChapters({ ...options, mode: "embedded" }), online);
  cache.write({ kind: "vtt", text: "WEBVTT\n" });
  assert.deepEqual(await loadChapters({ ...options, mode: "auto", vttUrl }), online);
});

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
  const { audio, elements } = await openPlayerPage(book, (url, options) => {
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

test("switching source reschedules availability checks after the new chapters and an idle period", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const config = { id: "book", defaultLanguage: "en", debug: { showAllQualities: true },
    languages: { en: { chapterSource: "embedded", sources: { opus: { 96: "book.webm" }, aac: { 96: "book.m4b" } } } } };
  const metadata = deferred();
  const probes = [];
  const range = rangedFetch(neroMetadata());
  const { elements } = await openPlayerPage(config, async (url, options) => {
    if (options.method === "HEAD") {
      probes.push(url);
      return new Response(null, { status: 200 });
    }
    await metadata.promise;
    return range(url, options);
  });
  const quality = elements.get("qualitySelect");
  quality.value = "aac-96";
  quality.dispatchEvent(new Event("change"));
  t.mock.timers.tick(3000);
  assert.deepEqual(probes, []);
  metadata.resolve();
  await settle();
  assert.deepEqual(probes, []);
  t.mock.timers.tick(1500);
  await settle();
  assert.deepEqual(probes.map((url) => new URL(url).pathname).sort(), ["/media/book/book.m4b", "/media/book/book.webm"]);
});

test("chapter sleep follows the active source after quality changes and automatic fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const config = { id: "book", defaultLanguage: "en", debug: { showAllQualities: true },
    languages: { en: { chapterSource: "embedded", sources: { opus: { 96: "book.webm" }, aac: { 96: "book.m4b", 64: "other.m4b" } } } } };
  const original = rangedFetch(neroMetadata());
  const other = rangedFetch(neroMetadata(90));
  const { audio, elements } = await openPlayerPage(config, (url, options) =>
    url.endsWith("other.m4b") ? other(url, options) : original(url, options), new Map(),
    { navigator: { language: "en", onLine: true, userAgent: "iPhone" } });
  const quality = elements.get("qualitySelect");
  const timer = elements.get("sleepBtn");
  async function select(id) {
    quality.value = id;
    quality.dispatchEvent(new Event("change"));
    await settle();
  }
  for (const action of ["select", "fallback"]) {
    await select("aac-96");
    elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
    await settle();
    assert.match(timer.dataset.tooltip, /End of chapter/);
    if (action === "select") await select("opus-96");
    else {
      elements.get("playPauseBtn").dispatchEvent(new Event("click"));
      audio.error = { code: 3 };
      audio.dispatchEvent(new Event("error"));
      await settle();
      assert.ok(audio.src.endsWith("book.webm"));
    }
    assert.equal(timer.dataset.tooltip, "Sleep timer", action);
  }
  elements.get("sleepList").children[1].dispatchEvent(new Event("click"));
  await select("aac-96");
  assert.match(timer.dataset.tooltip, /5 min/);
  elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
  await settle();
  await select("aac-64");
  audio.dispatchEvent(new Event("loadedmetadata"));
  audio.currentTime = 60;
  audio.dispatchEvent(new Event("timeupdate"));
  assert.match(timer.dataset.tooltip, /End of chapter/);
  audio.currentTime = 90;
  audio.dispatchEvent(new Event("timeupdate"));
  assert.equal(timer.dataset.tooltip, "Sleep timer");
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
      const { audio, elements, navigator, window } = await openPlayerPage(book, (url, options) => {
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
  const { elements } = await openPlayerPage(book, (url, options) => {
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

function uint32Fields(...fields) {
  const view = new DataView(new ArrayBuffer(4 * fields.length));
  fields.forEach((value, index) => view.setUint32(4 * index, value));
  return new Uint8Array(view.buffer);
}

function quickTimeChapterFile(count, sizeTable, sample = Uint8Array.of(0, 1, 65), padding = 0, gap = 0, mapping = null,
  { referenceIds = [2], referencePayload = null, trackId = 2, otherTrackIds = [] } = {}) {
  const stride = sample.length + gap;
  const data = new Uint8Array(padding + (count - 1) * stride + sample.length);
  for (let i = padding; i < data.length; i += stride) data.set(sample, i);
  const media = atom("mdat", data);
  const offsets = gap ? Array.from({ length: count }, (_, i) => 8 + padding + i * stride) : [8 + padding];
  const references = atom("trak", atom("tref", atom("chap", referencePayload || uint32Fields(...referenceIds))));
  const samples = atom("stbl", concatBytes(
    atom("stts", uint32Fields(0, 1, count, 1000)),
    atom("stsc", uint32Fields(0, 1, ...(mapping || [1, gap ? 1 : count, 1]))),
    atom("stco", uint32Fields(0, offsets.length, ...offsets)),
    atom("stsz", sizeTable),
  ));
  const track = atom("trak", concatBytes(atom("tkhd", uint32Fields(0, 0, 0, trackId)),
    atom("mdia", concatBytes(atom("mdhd", uint32Fields(0, 0, 0, 1000)), atom("minf", samples)))));
  const others = otherTrackIds.map((id) => atom("trak", atom("tkhd", uint32Fields(0, 0, 0, id))));
  return concatBytes(media, atom("moov", concatBytes(references, track, ...others)));
}

test("missing referenced QuickTime tracks fail without caching and succeed on retry", async () => {
  const url = "https://example.test/referenced.m4b";
  const cacheWrites = [];
  const cache = { read: () => null, beginWrite() {}, write: (result) => cacheWrites.push(result) };
  let file = quickTimeChapterFile(2, uint32Fields(0, 3, 2), undefined, 0, 0, null,
    { referenceIds: [2], trackId: 3 });
  let requests = 0;
  const fetchImpl = (url, options) => {
    requests++;
    return rangedFetch(file, file.length)(url, options);
  };
  const load = () => loadChapters({ mode: "embedded", sourceUrl: url, sourceMime: "audio/mp4", cache, fetchImpl });
  await assert.rejects(load(), /QuickTime.*track/i);
  assert.equal(cacheWrites.length, 0);
  file = quickTimeChapterFile(2, uint32Fields(0, 3, 2), undefined, 0, 0, null,
    { referenceIds: [9, 2], otherTrackIds: [3] });
  const result = await load();
  assert.deepEqual(result.cues, [
    { start: 0, end: 1, title: "A" }, { start: 1, end: null, title: "A" },
  ]);
  assert.equal(requests, 2);
  assert.deepEqual(cacheWrites, [result]);

  const noReferences = quickTimeChapterFile(2, uint32Fields(0, 3, 2), undefined, 0, 0, null, { referenceIds: [] });
  assert.deepEqual(await loadEmbeddedMp4Chapters("https://example.test/no-references.m4b",
    { fetchImpl: rangedFetch(noReferences, noReferences.length) }), []);

  let partial = quickTimeChapterFile(2, uint32Fields(0, 3, 2), undefined, 0, 0, null,
    { referencePayload: Uint8Array.of(0, 2) });
  const partialWrites = [];
  const partialCache = { read: () => null, beginWrite() {}, write: (value) => partialWrites.push(value) };
  let partialRequests = 0;
  const fetchPartial = (url, options) => {
    partialRequests++;
    return rangedFetch(partial, partial.length)(url, options);
  };
  const loadPartial = () => loadChapters({ mode: "embedded", sourceUrl: "https://example.test/partial.m4b",
    sourceMime: "audio/mp4", cache: partialCache, fetchImpl: fetchPartial });
  await assert.rejects(loadPartial(), /QuickTime.*reference/i);
  assert.equal(partialWrites.length, 0);
  partial = quickTimeChapterFile(2, uint32Fields(0, 3, 2));
  assert.equal((await loadPartial()).cues.length, 2);
  assert.equal(partialRequests, 2);
  assert.equal(partialWrites.length, 1);
});

test("incomplete QuickTime chapter tables fail without caching and succeed on retry", async () => {
  const good = quickTimeChapterFile(2, uint32Fields(0, 3, 2));
  const badFiles = [
    ...[[1, 1, 1], [1, 0, 1], [2, 1, 1]].map((mapping) =>
      quickTimeChapterFile(2, uint32Fields(0, 3, 2), undefined, 0, 0, mapping)),
    quickTimeChapterFile(2, uint32Fields(0, 0, 2, 3)),
    ...["mdhd", "stbl", "stts", "stsc", "stsz", "stco"].map((name) => {
      const bytes = good.slice();
      const offset = bytes.findIndex((_, index) =>
        name === String.fromCharCode(...bytes.subarray(index, index + 4)));
      assert.notEqual(offset, -1);
      bytes[offset] = 120;
      return bytes;
    }),
  ];
  const shortTiming = good.slice();
  const timingOffset = shortTiming.findIndex((_, index) =>
    "stts" === String.fromCharCode(...shortTiming.subarray(index, index + 4)));
  new DataView(shortTiming.buffer).setUint32(timingOffset + 12, 1);
  badFiles.push(shortTiming);
  for (let file of badFiles) {
    let written;
    let requests = 0;
    const cache = { read: () => null, beginWrite() {}, write: (result) => { written = result; } };
    const fetchImpl = (url, options) => {
      requests++;
      return rangedFetch(file, file.length)(url, options);
    };
    const options = { mode: "embedded", sourceUrl: "https://example.test/broken.m4b",
      sourceMime: "audio/mp4", fetchImpl, cache };
    await assert.rejects(loadChapters(options), /QuickTime.*mapping/i);
    assert.equal(written, undefined);
    file = good;
    const result = await loadChapters(options);
    assert.equal(requests, 2);
    assert.deepEqual(result.cues, [
      { start: 0, end: 1, title: "A" }, { start: 1, end: null, title: "A" },
    ]);
    assert.equal(written, result);
  }
});

test("MP4 metadata and QuickTime samples reject a changed strong HTTP validator", async () => {
  const sample = Uint8Array.of(0, 1, 65);
  const firstSample = 300_000;
  const file = quickTimeChapterFile(2, uint32Fields(0, sample.length, 2), sample, firstSample - 8);
  const moovStart = firstSample + sample.length * 2;
  const modified = "Wed, 04 Mar 2026 11:00:00 GMT";
  const date = "Wed, 04 Mar 2026 12:00:00 GMT";
  for (const scenario of ["changed-moov", "changed-sample", "changed-date", "missing-etag", "range-ignored", "stable", "no-validator", "weak-etag"]) {
    const requests = [];
    let revisionSwitched = false;
    const fetchImpl = async (_url, options) => {
      const range = options.headers.Range;
      const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(first);
      const end = Math.min(Number(last), file.length - 1);
      const isSample = start === firstSample;
      const isMoov = start >= moovStart;
      const changed = revisionSwitched || (scenario === "changed-sample" && isSample) || (scenario === "changed-moov" && isMoov);
      const changedDate = scenario === "changed-date" && isSample;
      const headers = new Headers({ "Content-Range": `bytes ${start}-${end}/${file.length}`, Date: date });
      if (scenario !== "no-validator" && scenario !== "changed-date" && !(scenario === "missing-etag" && isSample)) {
        headers.set("ETag", scenario === "weak-etag" ? 'W/"old"' : changed ? '"new"' : '"old"');
      }
      if (scenario === "changed-date") headers.set("Last-Modified", changedDate ? date : modified);
      requests.push({ range, condition: options.headers["If-Range"] });
      if (scenario === "range-ignored" && isSample) return new Response(file, { status: 200, headers });
      return new Response(file.slice(start, end + 1), { status: 206, headers });
    };
    const result = loadEmbeddedMp4Chapters("https://example.test/versioned.m4b", { fetchImpl });
    if (scenario.startsWith("changed") || scenario === "missing-etag" || scenario === "range-ignored") {
      await assert.rejects(result, /metadata|range|version/i, scenario);
    } else {
      assert.equal((await result).length, 2, scenario);
    }
    const expected = scenario === "no-validator" || scenario === "weak-etag" ? undefined
      : scenario === "changed-date" ? modified : '"old"';
    assert.equal(requests[0].condition, undefined);
    assert.ok(requests.length > 1);
    assert.ok(requests.slice(1).every((request) => request.condition === expected), scenario);
    if (scenario === "changed-sample") {
      revisionSwitched = true;
      const previousRequests = requests.length;
      assert.equal((await loadEmbeddedMp4Chapters("https://example.test/versioned.m4b", { fetchImpl })).length, 2);
      assert.equal(requests[previousRequests].range, "bytes=0-262143");
      assert.equal(requests[previousRequests].condition, undefined);
    }
  }
});

test("cross-origin MP4 ranges compare exposed ETags without requiring an If-Range preflight", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://player.test/") });
  try {
    const requests = [];
    const fetchImpl = async (_url, options) => {
      requests.push(options.headers);
      const start = requests.length - 1;
      return new Response(Uint8Array.of(start), { status: 206, headers: {
        "Content-Range": `bytes ${start}-${start}/2`, ETag: start ? '"new"' : '"old"',
      } });
    };
    const reader = new RangeReader("https://cdn.test/book.m4b", { fetchImpl });
    await reader.read(0, 1);
    await assert.rejects(reader.read(1, 2), /version changed/);
    assert.equal(requests[1]["If-Range"], undefined);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else delete globalThis.location;
  }
});

test("QuickTime chapters reuse the initial range and fetch neighboring titles together", async () => {
  const count = 100;
  const sample = Uint8Array.of(0, 1, 65);
  const prefix = 256 * 1024;
  for (const [firstSample, gap] of [[8, 0], [prefix - 1, 0], [prefix + 100_000, 4], [prefix, 4000], [prefix, 5000]]) {
    const file = quickTimeChapterFile(count, uint32Fields(0, sample.length, count), sample, firstSample - 8, gap);
    const offsets = Array.from({ length: count }, (_, i) => firstSample + i * (sample.length + gap));
    const mediaEnd = offsets.at(-1) + sample.length;
    for (let i = 0; i < count; i++) file[offsets[i] + 2] = 65 + i % 26;
    const requests = [];
    const fetchRange = rangedFetch(file, file.length);
    const cues = await loadEmbeddedMp4Chapters("https://example.test/chapters.m4b", {
      fetchImpl: (url, options) => {
        requests.push(options.headers.Range);
        return fetchRange(url, options);
      },
    });
    assert.deepEqual(cues, Array.from({ length: count }, (_, i) => ({
      start: i, end: i + 1 < count ? i + 1 : null, title: String.fromCharCode(65 + i % 26),
    })));
    assert.equal(requests[0], `bytes=0-${prefix - 1}`);
    const titleReads = requests.slice(1).filter((range) => Number(range.match(/^bytes=(\d+)/)[1]) < mediaEnd);
    if (file.length <= prefix) assert.equal(requests.length, 1);
    else if (gap === 5000) assert.deepEqual(titleReads, offsets.map((offset) => `bytes=${offset}-${offset + sample.length - 1}`));
    else if (gap === 4000) assert.deepEqual(titleReads, [
      `bytes=${offsets[0]}-${offsets[65] + sample.length - 1}`, `bytes=${offsets[66]}-${mediaEnd - 1}`,
    ]);
    else assert.deepEqual(titleReads, [`bytes=${Math.max(prefix, firstSample)}-${mediaEnd - 1}`]);
  }
});

test("QuickTime titles follow the UTF-16 byte order and replace previously misdecoded cached titles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = { id: "book", defaultLanguage: "en", languages: { en: {
    chapterSource: "embedded", sources: { aac: { 64: "book.m4b" } },
  } } };
  const url = "https://example.test/media/book/book.m4b";
  const key = "embedded:" + url;
  const storedKey = "compactPlayer@%2F:compactPlayer:chapters:book:en:1:" + encodeURIComponent(key);
  for (const bytes of [[0xfe, 0xff, 0, 0xc5, 0, 0x6c], [0xff, 0xfe, 0xc5, 0, 0x6c, 0]]) {
    const sample = Uint8Array.of(0, bytes.length, ...bytes, 0, 0, 0, 8);
    const file = quickTimeChapterFile(1, uint32Fields(0, sample.length, 1), sample);
    const fetchImpl = rangedFetch(file, file.length);
    const cues = await loadEmbeddedMp4Chapters(url, { fetchImpl });
    assert.deepEqual(cues, [{ start: 0, end: null, title: "Ål" }]);
    const saved = new Map([[storedKey, JSON.stringify({ kind: "embedded", sourceKey: key,
      cues: [{ start: 0, end: null, title: "\uFFFE\uC500\u6C00" }] })]]);
    const page = await openPlayerPage(book, fetchImpl, saved);
    assert.equal(page.elements.get("chaptersList").children[0].children[0].textContent, "Ål");
    assert.deepEqual(JSON.parse(saved.get(storedKey)).cues, cues);
  }
});

test("QuickTime chapter sizes respect the sample limit and require a complete size table", async () => {
  for (const [count, table, expected] of [
    [10_001, uint32Fields(0, 3, 10_001), 10_000],
    [10_001, uint32Fields(0, 0, 10_001, ...Array(10_001).fill(3)), 10_000],
    [2, uint32Fields(0, 0, 2, 3, 3), 2],
    [2, uint32Fields(0, 0, 2, 3), 0],
    [2, uint32Fields(0, 3), 0],
  ]) {
    const file = quickTimeChapterFile(count, table);
    const result = loadEmbeddedMp4Chapters("https://example.test/sample-sizes.m4b", { fetchImpl: rangedFetch(file, file.length) });
    if (!expected) {
      await assert.rejects(result, /QuickTime.*mapping/i);
      continue;
    }
    const cues = await result;
    assert.equal(cues.length, expected);
    assert.deepEqual(cues.at(-1), { start: expected - 1, end: null, title: "A" });
  }
});

test("reads JPEG cover artwork from MP4 metadata", async () => {
  const metadata = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 13);
  const cover = await loadEmbeddedMp4Cover("https://example.test/book.m4b", { fetchImpl: rangedFetch(metadata.file) });
  assert.equal(cover.mime, "image/jpeg");
  assert.deepEqual(cover.data, metadata.image);
});

test("an embedded cover follows a new quality or fallback after the first file fails", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { file } = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 13);
  const range = rangedFetch(file);
  for (const change of ["quality", "fallback", "external cover"]) {
    const requests = [];
    const book = { id: "sample", defaultLanguage: "en", coverSource: "auto", cover: "cover.jpg",
      languages: { en: { sources: { aac: { 96: "new.m4b", 128: "old.m4b" } } } } };
    const { audio, elements } = await openPlayerPage(book, (url, opts) => {
      requests.push(new URL(url).pathname.split("/").at(-1));
      if (url.endsWith("cover.jpg")) {
        return new Response(change === "external cover" ? Uint8Array.of(0xff, 0xd8, 0xff, 0xe0) : null,
          { status: change === "external cover" ? 200 : 404, headers: { "content-type": "image/jpeg" } });
      }
      return url.endsWith("old.m4b") ? new Response(null, { status: 404 }) : range(url, opts);
    });
    const image = elements.get("coverImg");
    await settle();
    if (change === "external cover") image.onload();
    if (change === "fallback") {
      elements.get("playPauseBtn").dispatchEvent(new Event("click"));
      audio.error = { code: 2 };
      audio.dispatchEvent(new Event("error"));
    } else {
      const quality = elements.get("qualitySelect");
      quality.value = "aac-96";
      quality.dispatchEvent(new Event("change"));
      assert.ok(!audio.src);
    }
    await settle();
    if (change === "external cover") {
      assert.deepEqual(requests, ["cover.jpg"]);
      assert.match(image.src, /^blob:/);
    } else {
      assert.deepEqual(requests, ["cover.jpg", "old.m4b", "new.m4b"], change);
      assert.match(image.src, /^blob:/);
      image.onload();
    }
    assert.equal(elements.get("coverButton").hidden, false);
  }
});

test("an already displayed embedded cover follows quality changes and fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const revoked = t.mock.method(URL, "revokeObjectURL");
  const oldImage = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
  const newImage = Uint8Array.of(0xff, 0xd8, 0xff, 0xe1);
  const oldRange = rangedFetch(coverMetadata(oldImage, 13).file);
  const newRange = rangedFetch(coverMetadata(newImage, 13).file);
  for (const change of ["quality", "fallback"]) {
    const requests = [];
    const book = { id: "sample", defaultLanguage: "en", coverSource: "embedded",
      languages: { en: { sources: { aac: { 96: "new.m4b", 128: "old.m4b" } } } } };
    const { audio, elements } = await openPlayerPage(book, (url, opts) => {
      requests.push(new URL(url).pathname.split("/").at(-1));
      return (url.endsWith("old.m4b") ? oldRange : newRange)(url, opts);
    });
    const image = elements.get("coverImg");
    const firstUrl = image.src;
    assert.match(firstUrl, /^blob:/);
    const oldLoad = image.onload;
    image.onload();
    assert.deepEqual([...new Uint8Array(await (await fetch(firstUrl)).arrayBuffer())], [...oldImage]);
    if (change === "fallback") {
      elements.get("playPauseBtn").dispatchEvent(new Event("click"));
      audio.error = { code: 2 };
      audio.dispatchEvent(new Event("error"));
    } else {
      const quality = elements.get("qualitySelect");
      quality.value = "aac-96";
      quality.dispatchEvent(new Event("change"));
    }
    await settle();
    assert.deepEqual(requests, ["old.m4b", "new.m4b"], change);
    assert.notEqual(image.src, firstUrl);
    assert.ok(revoked.mock.calls.some((call) => call.arguments[0] === firstUrl));
    assert.deepEqual([...new Uint8Array(await (await fetch(image.src)).arrayBuffer())], [...newImage]);
    oldLoad();
    assert.equal(elements.get("coverButton").hidden, true);
    image.onload();
    assert.equal(elements.get("coverButton").hidden, false);
  }
});

test("a pending embedded cover cannot replace the cover of a newer source", async () => {
  const oldResponse = deferred();
  const newerImage = Uint8Array.of(0xff, 0xd8, 0xff, 0xe2);
  const newRange = rangedFetch(coverMetadata(newerImage, 13).file);
  const image = new Element();
  const button = new Element();
  let shown = 0;
  const view = createCoverView(image, button, {
    fetchImpl: (url, options) => url.endsWith("/old.m4b") ? oldResponse.promise : newRange(url, options),
    onShown: () => { shown++; }, onFailure: assert.fail,
  });
  const book = { cacheVersion: 1, coverSource: "embedded" };
  view.applyCover(book, "en", { url: "https://example.test/old.m4b" });
  view.applyCover(book, "en", { url: "https://example.test/new.m4b" });
  await settle();
  const latestUrl = image.src;
  assert.match(latestUrl, /^blob:/);
  const oldRange = rangedFetch(coverMetadata(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), 13).file);
  oldResponse.resolve(await oldRange("https://example.test/old.m4b", { headers: { Range: "bytes=0-262143" } }));
  await settle();
  assert.equal(image.src, latestUrl);
  assert.deepEqual([...new Uint8Array(await (await fetch(latestUrl)).arrayBuffer())], [...newerImage]);
  image.onload();
  assert.equal(shown, 1);
  view.clearCover();
});

test("auto cover follows the active source after falling back to embedded artwork", async () => {
  const image = new Element();
  const button = new Element();
  const requests = [];
  const oldImage = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
  const newImage = Uint8Array.of(0xff, 0xd8, 0xff, 0xe1);
  const view = createCoverView(image, button, {
    fetchImpl: (url, options) => {
      requests.push(url);
      const contents = url.endsWith("/old.m4b") ? oldImage : newImage;
      return rangedFetch(coverMetadata(contents, 13).file)(url, options);
    },
    onShown: () => {}, onFailure: assert.fail,
  });
  const book = { cacheVersion: 1, coverSource: "auto", cover: "missing.jpg",
    bookBaseUrl: "https://example.test/media/book/" };
  view.applyCover(book, "en", { url: "https://example.test/old.m4b" });
  image.onerror();
  await settle();
  const firstUrl = image.src;
  image.onload();
  view.applyCover(book, "en", { url: "https://example.test/new.m4b" });
  await settle();
  assert.deepEqual(requests, ["https://example.test/old.m4b", "https://example.test/new.m4b"]);
  assert.notEqual(image.src, firstUrl);
  assert.deepEqual([...new Uint8Array(await (await fetch(image.src)).arrayBuffer())], [...newImage]);
  image.onload();
  assert.equal(button.hidden, false);
  view.clearCover();
});

test("a late cover image load after a language change cannot replace the current cover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { file } = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 13);
  const range = rangedFetch(file);
  const revoked = t.mock.method(URL, "revokeObjectURL");
  const { elements, audio } = await openPlayerPage({
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

test("already cancelled chapters and covers leave MP4 range requests to active readers", async (t) => {
  const url = "https://example.test/cancelled-book.m4b";
  const signal = AbortSignal.abort();
  const fetchImpl = t.mock.fn(rangedFetch(neroMetadata()));
  for (const load of [loadEmbeddedMp4Chapters, loadEmbeddedMp4Cover]) {
    await assert.rejects(load(url, { fetchImpl, signal }), { name: "AbortError" });
  }
  assert.equal(fetchImpl.mock.callCount(), 0);

  const active = loadEmbeddedMp4Chapters(url, { fetchImpl });
  await assert.rejects(loadEmbeddedMp4Cover(url, { fetchImpl, signal }), { name: "AbortError" });
  assert.equal((await active)[0].title, "Intro");
  await assert.rejects(loadEmbeddedMp4Chapters(url, { fetchImpl, signal }), { name: "AbortError" });
  assert.equal(fetchImpl.mock.callCount(), 1);
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

test("replacing an MP4 at the same URL refreshes chapters and artwork together for its cache version", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = "https://example.test/media/shared.m4b";
  const edition = (version) => ({
    id: "edition" + version, defaultLanguage: "en", cacheVersion: version, coverSource: "embedded",
    languages: { en: { chapterSource: "embedded", sources: { aac: { 64: url } } } },
  });
  let version = 1;
  const requests = [];
  const page = await openPlayerPage(edition(1), assert.fail, new Map(), { fetch: async (requested, options) => {
    if (requested.endsWith("/library.json")) return Response.json({
      books: [{ id: "edition1" }, { id: "edition2" }], ui: { onboardingEnabled: false },
    });
    if (requested.endsWith("/book.json")) return Response.json(edition(requested.includes("/edition1/") ? 1 : 2));
    assert.equal(requested, url);
    requests.push(options.cache);
    const cover = coverMetadata(new Uint8Array([0xff, 0xd8, 0xff, version]), 13);
    const chapters = neroMetadata(version === 1 ? 60 : 90);
    return rangedFetch(atom("moov", concatBytes(chapters.subarray(8), cover.file.subarray(8))))(requested, options);
  } });
  const sourceKey = "embedded:" + url;
  for (const expected of [60, 90]) {
    if (expected === 90) {
      version = 2;
      const select = page.elements.get("bookSelect");
      select.value = "edition2";
      select.dispatchEvent(new Event("change"));
      await settle();
    }
    assert.equal(page.storage.readChapterData("edition" + version, "en", version, sourceKey).cues[1].start, expected);
    const image = await fetch(page.elements.get("coverImg").src);
    assert.equal(new Uint8Array(await image.arrayBuffer()).at(-1), version);
  }
  assert.deepEqual(requests, ["no-cache", "no-cache"]);

  const { versionHeader, versionHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const savedFile = rangedFetch(neroMetadata(60));
  const offlineFetch = async (...args) => {
    const response = await savedFile(...args);
    response.headers = new Headers({ "Content-Range": response.headers.get("Content-Range"), [versionHeader]: versionHeaderValue(1) });
    return response;
  };
  assert.equal((await loadEmbeddedMp4Chapters(url, { cacheVersion: 1, fetchImpl: offlineFetch }))[1].start, 60);
  await assert.rejects(loadEmbeddedMp4Chapters(url, { cacheVersion: 2, fetchImpl: offlineFetch }), /different book version/);
});

test("auto mode falls back from cached empty WebVTT and reuses the embedded chapters offline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const requests = [];
  const range = rangedFetch(neroMetadata());
  const visit = (chapterSource, online = true) => openPlayerPage({
    id: "book", defaultLanguage: "en",
    languages: { en: { chapterSource, chapters: "chapters.vtt", sources: { aac: { 64: "book.m4b" } } } },
  }, (url, options) => {
    requests.push(new URL(url).pathname);
    return url.endsWith(".vtt") ? new Response("WEBVTT\n") : range(url, options);
  }, saved, { navigator: { language: "en", onLine: online } });
  const empty = await visit("vtt");
  assert.equal(empty.elements.get("nextChapterBtn").disabled, true);
  for (const online of [true, false]) {
    const page = await visit("auto", online);
    assert.equal(page.elements.get("chaptersList").children[0].children[0]?.textContent, "Intro");
    assert.equal(page.elements.get("nextChapterBtn").disabled, false);
    assert.ok(!page.audio.src);
    assert.deepEqual(requests, ["/media/book/chapters.vtt", "/media/book/book.m4b"]);
  }
});

test("auto mode retries unavailable WebVTT on reconnect and reload while keeping embedded chapters offline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = { id: "book", defaultLanguage: "en", languages: { en: {
    chapterSource: "auto", chapters: "chapters.vtt", sources: { aac: { 64: "book.m4b" } },
  } } };
  const text = "WEBVTT\n\n00:00.000 --> 00:15.000\nRestored";
  for (const trigger of ["reconnect", "reload"]) {
    const saved = new Map();
    const range = rangedFetch(neroMetadata());
    const requests = [];
    let response = () => new Response(null, { status: 404 });
    const visit = (online) => openPlayerPage(book, (url, options) => {
      const filename = new URL(url).pathname.split("/").at(-1);
      requests.push(filename);
      return filename === "chapters.vtt" ? response() : range(url, options);
    }, saved, { navigator: { onLine: online, language: "en", userAgent: "iPhone" } });
    const title = (page) => page.elements.get("chaptersList").children[0]?.children[0]?.textContent;
    const initial = await visit(true);
    assert.equal(title(initial), "Intro");
    const page = await visit(false);
    assert.equal(title(page), "Intro");
    assert.deepEqual(requests, ["chapters.vtt", "book.m4b"]);

    page.navigator.onLine = true;
    page.window.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(title(page), "Intro");
    assert.deepEqual(requests, ["chapters.vtt", "book.m4b", "chapters.vtt"]);

    const server = deferred();
    response = () => server.promise;
    let restored;
    if (trigger === "reload") {
      restored = await visit(true);
      assert.equal(title(restored), "Intro");
    }
    else {
      restored = page;
      restored.elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
      await settle();
      assert.match(restored.elements.get("sleepBtn").dataset.tooltip, /End of chapter/);
      restored.window.dispatchEvent(new Event("online"));
      restored.window.dispatchEvent(new Event("online"));
      assert.equal(title(restored), "Intro");
    }
    server.resolve(new Response(text));
    await settle();
    assert.equal(title(restored), "Restored");
    assert.match(restored.elements.get("bookMeta").textContent, /Restored$/);
    if (trigger === "reconnect") {
      restored.audio.dispatchEvent(new Event("loadedmetadata"));
      restored.audio.currentTime = 15;
      restored.audio.dispatchEvent(new Event("timeupdate"));
      assert.equal(restored.elements.get("sleepBtn").dataset.tooltip, "Sleep timer");
    }
    assert.equal(title(await visit(false)), "Restored");
    assert.deepEqual(requests, ["chapters.vtt", "book.m4b", "chapters.vtt", "chapters.vtt"]);
  }
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
