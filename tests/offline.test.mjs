import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BookConfigStore } from "../js/book-config.js";
import { normalizeLibrary } from "../js/config.js";
import { buildSources, chooseDefaultSource } from "../js/source-selection.js";
import { openPlayerPage } from "./player-page.mjs";
import {
  OfflineManager,
  chunkBounds,
  completedBytes,
  manifestMatchesSelection,
  offlineChunkUrl,
  offlineManifestUrl,
  parseContentRange,
  validManifest,
} from "../js/offline.js";

class MemoryCache {
  map = new Map();
  key(input) { return typeof input === "string" ? new URL(input).href : input.url; }
  async match(input) { return this.map.get(this.key(input))?.clone(); }
  async put(input, response) { this.map.set(this.key(input), response.clone()); }
  async delete(input) { return this.map.delete(this.key(input)); }
}

class MemoryCacheStorage {
  map = new Map();
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new MemoryCache());
    return this.map.get(name);
  }
  async keys() { return [...this.map.keys()]; }
  async match(request, { cacheName }) { return this.map.get(cacheName)?.match(request); }
  async delete(name) { return this.map.delete(name); }
}

const heldLocks = new Map();
const locks = {
  async request(name, { ifAvailable }, action) {
    if (ifAvailable && heldLocks.has(name)) return action(null);
    while (heldLocks.has(name)) await heldLocks.get(name);
    let release;
    heldLocks.set(name, new Promise((resolve) => { release = resolve; }));
    try { return await action({ name }); }
    finally { heldLocks.delete(name); release(); }
  },
};

function navigatorStub(estimate = { quota: 1024 ** 3, usage: 0 }) {
  return {
    locks,
    onLine: true,
    serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) },
    storage: { estimate: async () => estimate, persist: async () => true },
  };
}

async function workerContext(globals = {}, decorateContract) {
  const context = vm.createContext({
    self: { registration: { scope: "https://example.test/" }, addEventListener() {} },
    URL, Request, Response, ReadableStream, ...globals,
  });
  const workerUrl = new URL("../sw.js", import.meta.url);
  context.importScripts = (path) => {
    assert.equal(path, "./js/offline-manifest.js");
    vm.runInContext(readFileSync(new URL(path, workerUrl), "utf8"), context);
    if (decorateContract) context.CompactPlayerOfflineManifest = decorateContract(context.CompactPlayerOfflineManifest);
  };
  vm.runInContext(await readFile(workerUrl, "utf8"), context);
  return context;
}

test("offline startup opens the recorded configuration without a catalog folder mapping", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const baseUrl = "https://example.test/";
  const configUrl = baseUrl + "media/editions/north/episode.json";
  const config = { id: "north-edition", title: { en: "North" }, defaultLanguage: "en",
    languages: { en: { sources: { opus: { 64: "audio.webm" } } } } };
  const libraryUrl = baseUrl + "media/library.json";
  const cacheStorage = new MemoryCacheStorage();
  const range = rangedFetch(10);
  const writer = new OfflineManager({ baseUrl, cacheStorage, navigatorObject: navigatorStub(), fetchImpl: (url, options) => {
    if (url === libraryUrl) return new Response(null, { status: 404 });
    if (url === configUrl) return Response.json(config);
    return range(url, options);
  } });
  await writer.init();
  const selected = { ...selection(), episodeId: "north", configBookId: config.id, sourceUrl: new URL("audio.webm", configUrl).href,
    assets: [{ url: libraryUrl }, { url: configUrl, required: true }] };
  const saved = await writer.start(selected, await writer.inspectSource(selected));
  const cache = await cacheStorage.open(saved.cacheName);
  const requests = [];
  const page = await openPlayerPage(t, config, assert.fail, new Map([["compactAudioPlayer.onboardingShown.v1", "1"]]), {
    caches: cacheStorage, navigator: { ...navigatorStub(), onLine: false },
    fetch: async (url) => { requests.push(url); return await cache.match(url) || new Response(null, { status: 404 }); },
  });
  assert.equal(page.elements.get("bookTitle").textContent, "North");
  assert.deepEqual(requests, [libraryUrl, configUrl]);
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(page.audio.src, selected.sourceUrl);
});

test("offline shell requests succeed while book metadata is unreadable", async () => {
  const baseUrl = "https://example.test/";
  const assets = new Map([["/", "cached page"], ["/player.js", "script"], ["/player.css", "style"], ["/js/config.js", "module"]]);
  const metadataReads = [];
  const context = await workerContext({
    fetch: async () => { throw new TypeError("Offline"); },
    caches: { open: async (name) => ({
      async match(request) {
        if (!name.startsWith("compact-player-app-shell:")) {
          metadataReads.push(name);
          throw new DOMException("Read failed", "UnknownError");
        }
        const value = assets.get(new URL(request.url || request).pathname);
        return value && new Response(value);
      },
    }) },
  });
  for (const [path, value] of assets) {
    const request = new Request(new URL(path + "?v=11", baseUrl));
    if (path === "/") Object.defineProperty(request, "mode", { value: "navigate" });
    assert.equal(await (await context.networkFirst(request)).text(), value);
  }
  assert.deepEqual(metadataReads, []);
});

test("the worker and player accept the same ready manifests", async () => {
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({ baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) });
  const worker = await workerContext({ caches: cacheStorage });
  const legacy = { ...selection(), schemaVersion: 1, downloadId: "old", cacheName: "book-one",
    totalSize: 10, chunkSize: 10, totalChunks: 1, completed: [0], status: "ready" };
  for (const [fields, accepted] of [
    [{}, true], [{ configBookId: "edition", mime: 'audio/webm; codecs="opus"' }, true],
    [{ mime: "text/html" }, false], [{ completed: [0, 0] }, false], [{ episodeId: "" }, false],
    [{ languageCode: "" }, false], [{ status: "downloading" }, false], [{ completed: [] }, false],
  ]) {
    await manager.writeRecord("active", { ...legacy, ...fields });
    assert.equal(Boolean(await manager.readRecord("active")), accepted, JSON.stringify(fields));
    assert.equal(Boolean(await worker.activeManifest()), accepted, JSON.stringify(fields));
  }
});

function selection(total = 10) {
  return {
    episodeId: "book",
    episodeTitle: "Book",
    languageCode: "en",
    languageLabel: "English",
    sourceId: "opus-64",
    sourceLabel: "Low quality",
    sourceUrl: "https://example.test/audio.webm",
    mime: 'audio/webm; codecs="opus"',
    cacheVersion: "1",
    assets: [],
    total,
  };
}

function rangedFetch(total, { failSecondChunk = false, contentType } = {}) {
  let chunkRequests = 0;
  return async (_url, options) => {
    const range = options.headers.Range;
    if (range === "bytes=0-0") {
      const headers = new Headers({ "content-range": `bytes 0-0/${total}`, etag: '"one"' });
      if (contentType) headers.set("content-type", contentType);
      return new Response(new Uint8Array([0]), { status: 206, headers });
    }
    const match = range.match(/^bytes=(\d+)-(\d+)$/);
    const start = Number(match[1]);
    const end = Number(match[2]);
    chunkRequests += 1;
    if (failSecondChunk && chunkRequests === 2) throw new TypeError("connection lost");
    return new Response(new Uint8Array(end - start + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${total}` },
    });
  };
}

test("validates content ranges and chunk boundaries", () => {
  assert.deepEqual(parseContentRange("bytes 0-0/512"), { start: 0, end: 0, total: 512 });
  assert.equal(parseContentRange("bytes */512"), null);
  assert.equal(parseContentRange("bytes 10-9/512"), null);
  assert.deepEqual(chunkBounds(1, 18, 10), { start: 10, end: 17 });
});

test("validates manifests and exact offline selections", () => {
  const manifest = {
    schemaVersion: 1,
    status: "ready",
    downloadId: "one",
    cacheName: "book-one",
    episodeId: "book",
    languageCode: "en",
    sourceId: "opus-64",
    sourceUrl: "https://example.test/audio.webm",
    mime: "audio/webm",
    cacheVersion: "1",
    totalSize: 18,
    chunkSize: 10,
    totalChunks: 2,
    completed: [0, 1],
  };
  assert.equal(validManifest(manifest, "ready"), true);
  assert.equal(completedBytes(manifest), 18);
  assert.equal(manifestMatchesSelection(manifest, selection()), true);
  assert.equal(manifestMatchesSelection(manifest, { ...selection(), languageCode: "da" }), false);
  assert.equal(validManifest({ ...manifest, completed: [0, 0] }), false);
});

test("downloads the selected source and promotes only a complete cache", async () => {
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({
    baseUrl: "https://example.test/",
    fetchImpl: rangedFetch(10),
    cacheStorage,
    navigatorObject: navigatorStub(),
  });
  await manager.init();
  const selected = selection();
  const preflight = await manager.inspectSource(selected);
  assert.equal(preflight.totalSize, 10);
  const manifest = await manager.start(selected, preflight);
  assert.equal(manifest.status, "ready");
  assert.equal(manager.active.sourceId, "opus-64");
  assert.equal(manager.staging, null);
  const cache = await cacheStorage.open(manifest.cacheName);
  assert.ok(await cache.match(offlineChunkUrl("https://example.test/", manifest.downloadId, 0)));
});

test("a replacement must cache a book configuration that can reopen the selected audio", async () => {
  const baseUrl = "https://example.test/";
  const cacheStorage = new MemoryCacheStorage();
  const raw = (id) => ({ id, defaultLanguage: "en", languages: { en: { sources: { opus: { 64: "audio.webm" } } } } });
  const selected = (id) => ({
    ...selection(), episodeId: id, configBookId: id === "next" ? "edition" : id,
    sourceUrl: `${baseUrl}media/${id}/audio.webm`,
    assets: [{ url: `${baseUrl}media/${id}/book.json`, required: true }],
  });
  const original = selected("book");
  const next = selected("next");
  const audioFetch = rangedFetch(10);
  let replacement;
  const options = {
    baseUrl, cacheStorage, navigatorObject: navigatorStub(),
    fetchImpl: (url, options) => {
      if (url === original.assets[0].url) return Response.json(raw("book"));
      if (url === next.assets[0].url) return replacement.clone();
      return audioFetch(url, options);
    },
  };
  const manager = new OfflineManager(options);
  await manager.init();
  const saved = await manager.start(original, await manager.inspectSource(original));
  for (const invalid of [
    new Response("<html>Service unavailable</html>"), Response.json({}), Response.json(raw("other")),
    Response.json({ ...raw("edition"), cacheVersion: 2 }),
    Response.json({ ...raw("edition"), languages: { da: raw("edition").languages.en } }),
    Response.json({ ...raw("edition"), languages: { en: { sources: { opus: { 96: "audio.webm" } } } } }),
    Response.json({ ...raw("edition"), languages: { en: { sources: { opus: { 64: "different.webm" } } } } }),
  ]) {
    replacement = invalid;
    await assert.rejects(manager.start(next, await manager.inspectSource(next)));
    const offline = new OfflineManager({ ...options, navigatorObject: { ...navigatorStub(), onLine: false } });
    await offline.init();
    assert.equal(offline.active?.downloadId, saved.downloadId);
    const cache = await cacheStorage.open(offline.active.cacheName);
    const configs = new BookConfigStore({ library: normalizeLibrary(null), documentBaseUrl: baseUrl, fetchImpl: (url) => cache.match(url) });
    assert.equal((await configs.load(offline.active.episodeId)).book.id, "book");
    assert.equal((await (await cache.match(offlineChunkUrl(baseUrl, saved.downloadId, 0))).arrayBuffer()).byteLength, 10);
  }
  replacement = Response.json(raw("edition"));
  await assert.rejects(manager.start(next, await manager.inspectSource(next), {
    waitForPriority: async () => {
      const staged = await cacheStorage.open(manager.staging.cacheName);
      await staged.put(next.assets[0].url, Response.json(raw("other")));
    },
  }), /configuration/);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal((await manager.start(next, await manager.inspectSource(next))).episodeId, "next");
});

test("a denied write lock leaves the published offline book readable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const baseUrl = "https://example.test/";
  const cacheStorage = new MemoryCacheStorage();
  const config = { id: "book", defaultLanguage: "en", title: { en: "Downloaded book" },
    languages: { en: { sources: { opus: { 64: "audio.webm", 128: "large.webm" } } } } };
  const configUrl = baseUrl + "media/book/book.json";
  const libraryUrl = baseUrl + "media/library.json";
  const ranges = rangedFetch(10);
  const writer = new OfflineManager({ baseUrl, cacheStorage, navigatorObject: navigatorStub(), fetchImpl: (url, options) => {
    if (url === configUrl) return Response.json(config);
    if (url === libraryUrl) return Response.json({ books: [{ id: "other" }, { id: "book" }], ui: { onboardingEnabled: false } });
    return ranges(url, options);
  } });
  await writer.init();
  const selected = { ...selection(), sourceUrl: new URL("audio.webm", configUrl).href,
    assets: [{ url: configUrl, required: true }, { url: libraryUrl }] };
  const saved = await writer.start(selected, await writer.inspectSource(selected));
  const remove = t.mock.method(cacheStorage, "delete");
  const put = t.mock.method(MemoryCache.prototype, "put");
  const navigator = {
    ...navigatorStub(), onLine: false, locks: { request: async () => { throw new DOMException("Denied", "SecurityError"); } },
  };
  const context = await workerContext({
    self: { registration: { scope: baseUrl }, addEventListener() {} }, caches: cacheStorage,
    fetch: async () => { throw new TypeError("Offline"); }, URL, Request, Response, ReadableStream,
  });
  const fetch = (url, options) => context.networkFirst(new Request(url, options));
  const page = await openPlayerPage(t, config, assert.fail, new Map(), {
    navigator, fetch, caches: cacheStorage, location: new URL("?book=other", baseUrl),
  });
  assert.equal(page.elements.get("bookTitle").textContent, config.title.en);
  assert.equal(page.elements.get("offlineRow").hidden, true);
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(page.audio.src, selected.sourceUrl);
  const audio = await fetch(page.audio.src, { headers: { Range: "bytes=1-3" } });
  assert.equal(audio.status, 206);
  assert.equal((await audio.arrayBuffer()).byteLength, 3);
  assert.ok((await cacheStorage.keys()).includes(saved.cacheName));
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(put.mock.callCount(), 0);
});

test("a replacement needs a valid audio MIME type and manifest before the saved book is removed", async (t) => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const manager = new OfflineManager(options);
  await manager.init();
  const first = selection();
  const previous = await manager.start(first, await manager.inspectSource(first));
  const language = { baseUrl: options.baseUrl, sources: { mp3: { 96: "next.mp3" } } };
  const source = chooseDefaultSource(buildSources(language, { canPlayType: () => "" }));
  const next = { ...first, episodeId: "next", sourceId: source.id, sourceUrl: source.url, mime: source.mime };

  for (const [invalid, contentType] of [
    [{ ...next, mime: "" }, undefined],
    [next, "text/html"],
  ]) {
    manager.fetchImpl = rangedFetch(10, { contentType });
    await assert.rejects(async () => manager.start(invalid, await manager.inspectSource(invalid)), { code: "mime" });
    const reloaded = new OfflineManager(options);
    await reloaded.init();
    assert.equal(reloaded.active?.downloadId, previous.downloadId);
    assert.ok(await cacheStorage.match(offlineChunkUrl(options.baseUrl, previous.downloadId, 0), { cacheName: previous.cacheName }));
  }

  manager.fetchImpl = rangedFetch(10, { contentType: "application/octet-stream" });
  const preflight = await manager.inspectSource(next);
  const put = MemoryCache.prototype.put;
  const corrupt = t.mock.method(MemoryCache.prototype, "put", function (url, response) {
    if (url === offlineManifestUrl(options.baseUrl)) return put.call(this, url, Response.json({}));
    return put.call(this, url, response);
  });
  await assert.rejects(manager.start(next, preflight), { code: "manifest" });
  corrupt.mock.restore();
  assert.equal((await manager.readRecord("active"))?.downloadId, previous.downloadId);
  assert.ok((await cacheStorage.keys()).includes(previous.cacheName));

  const replacement = await manager.start(next, preflight);
  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal(reloaded.active?.downloadId, replacement.downloadId);
  assert.equal(reloaded.active.mime, "audio/mpeg");
  assert.ok(validManifest(reloaded.active, "ready"));
  assert.ok(!(await cacheStorage.keys()).includes(previous.cacheName));
});

test("canceling while the final chunk is being stored preserves the previous offline book", async (t) => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const manager = new OfflineManager(options);
  await manager.init();
  const first = selection();
  const previous = await manager.start(first, await manager.inspectSource(first));
  const next = { ...first, episodeId: "next", sourceUrl: "https://example.test/next.webm" };
  let enteredWrite, releaseWrite;
  const writing = new Promise((resolve) => { enteredWrite = resolve; });
  const released = new Promise((resolve) => { releaseWrite = resolve; });
  const put = MemoryCache.prototype.put;
  t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
    if (key.includes("/chunks/")) { enteredWrite(); await released; }
    return put.call(this, key, response);
  });

  const download = manager.start(next, await manager.inspectSource(next));
  await writing;
  const partialName = manager.staging.cacheName;
  const canceled = manager.cancel();
  releaseWrite();
  await canceled;
  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal(reloaded.active?.downloadId, previous.downloadId);
  assert.equal(reloaded.staging, null);
  assert.ok(!(await cacheStorage.keys()).includes(partialName));
  const chunk = offlineChunkUrl(manager.baseUrl, previous.downloadId, 0);
  const savedChunk = await cacheStorage.match(chunk, { cacheName: previous.cacheName });
  assert.ok(savedChunk);
  assert.equal((await savedChunk.arrayBuffer()).byteLength, 10);
  await assert.rejects(download, { name: "AbortError" });
});

test("opening another tab during replacement keeps the newly activated offline book", async (t) => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const writer = new OfflineManager(options);
  const reader = new OfflineManager(options);
  await writer.init();
  const first = selection();
  const previous = await writer.start(first, await writer.inspectSource(first));
  const next = { ...first, episodeId: "next", sourceUrl: "https://example.test/next.webm" };
  const meta = await writer.metaCache();
  const put = meta.put.bind(meta);
  let entered, release;
  const activating = new Promise((resolve) => { entered = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  t.mock.method(meta, "put", async (key, response) => {
    if (key.endsWith("/active.json") && (await response.clone().json()).manifest.episodeId === next.episodeId) {
      entered();
      await resume;
    }
    return put(key, response);
  });

  const replacement = writer.start(next, await writer.inspectSource(next));
  await activating;
  try {
    await reader.init();
    assert.equal(reader.active?.downloadId, previous.downloadId);
  } finally { release(); }
  const saved = await replacement;
  await assert.rejects(reader.removeActive(), { code: "conflict" });
  await reader.refresh();
  assert.equal(reader.active?.downloadId, saved.downloadId);
  const chunk = await cacheStorage.match(offlineChunkUrl(reader.baseUrl, saved.downloadId, 0), { cacheName: saved.cacheName });
  assert.equal((await chunk.arrayBuffer()).byteLength, 10);
  assert.ok(!(await cacheStorage.keys()).includes(previous.cacheName));
});

test("refresh and reset only clean up downloads for their own installation", async () => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const first = new OfflineManager({ ...options, baseUrl: "https://example.test/books/" });
  const second = new OfflineManager({ ...options, baseUrl: "https://example.test/books/kids/" });
  const selected = selection();
  await first.init();
  const active = await first.start(selected, await first.inspectSource(selected));

  // Older releases used a random cache name and stored the manifest under the installation URL.
  const legacy = { ...active, cacheName: "compact-player-offline-book-v1-legacy", downloadId: "legacy",
    status: "downloading", totalSize: 20, chunkSize: 10, totalChunks: 2, completed: [0] };
  const partial = await cacheStorage.open(legacy.cacheName);
  await partial.put(offlineManifestUrl(first.baseUrl), Response.json(legacy));
  const chunk = offlineChunkUrl(first.baseUrl, legacy.downloadId, 0);
  await partial.put(chunk, new Response(new Uint8Array(10)));
  await first.refresh();
  assert.equal(first.staging?.downloadId, legacy.downloadId);

  await second.init();
  assert.equal(second.active, null);
  assert.equal(second.staging, null);
  assert.ok((await cacheStorage.keys()).includes(active.cacheName));
  assert.ok((await cacheStorage.keys()).includes(legacy.cacheName));
  const secondBook = await second.start(selected, await second.inspectSource(selected));
  await first.refresh();
  assert.ok((await cacheStorage.keys()).includes(secondBook.cacheName));

  await second.reset();
  assert.equal((await cacheStorage.keys()).includes(secondBook.cacheName), false);
  assert.equal((await first.readRecord("active"))?.downloadId, active.downloadId);
  assert.equal((await first.readRecord("staging"))?.downloadId, legacy.downloadId);
  await first.refresh();
  assert.equal(first.active?.downloadId, active.downloadId);
  assert.deepEqual(first.staging?.completed, [0]);
  assert.ok(await (await cacheStorage.open(legacy.cacheName)).match(chunk));

  await first.reset();
  assert.equal((await cacheStorage.keys()).includes(active.cacheName), false);
  assert.equal((await cacheStorage.keys()).includes(legacy.cacheName), false);
});

test("a temporary chunk read failure preserves the active record and offline audio across reloads", async (t) => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const manager = new OfflineManager(options);
  await manager.init();
  const selected = selection();
  const saved = await manager.start(selected, await manager.inspectSource(selected));
  const cache = await cacheStorage.open(saved.cacheName);
  const chunkUrl = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  const match = cache.match.bind(cache);
  t.mock.method(console, "warn", () => {});
  const transient = t.mock.method(cache, "match", async (url) => {
    if (url === chunkUrl) throw new DOMException("Temporarily unreadable", "UnknownError");
    return match(url);
  });

  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal((await reloaded.readRecord("active"))?.downloadId, saved.downloadId);
  assert.ok((await cacheStorage.keys()).includes(saved.cacheName));
  transient.mock.restore();
  await reloaded.refresh();
  assert.equal(reloaded.active?.downloadId, saved.downloadId);
  const audio = await cacheStorage.match(chunkUrl, { cacheName: saved.cacheName });
  assert.equal((await audio.arrayBuffer()).byteLength, 10);
});

test("does not advertise a completed download after a cached chunk is lost", async () => {
  const cacheStorage = new MemoryCacheStorage();
  const options = {
    baseUrl: "https://example.test/",
    fetchImpl: rangedFetch(10),
    cacheStorage,
    navigatorObject: navigatorStub(),
  };
  const first = new OfflineManager(options);
  await first.init();
  const selected = selection();
  const manifest = await first.start(selected, await first.inspectSource(selected));
  const cache = await cacheStorage.open(manifest.cacheName);
  await cache.delete(offlineChunkUrl("https://example.test/", manifest.downloadId, 0));
  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal(reloaded.active, null);
  assert.equal((await cacheStorage.keys()).includes(manifest.cacheName), false);
});

test("keeps completed chunks when a connection fails so download can resume", async () => {
  const total = 8 * 1024 * 1024 + 4;
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({
    baseUrl: "https://example.test/",
    fetchImpl: rangedFetch(total, { failSecondChunk: true }),
    cacheStorage,
    navigatorObject: navigatorStub(),
  });
  await manager.init();
  const selected = selection(total);
  const preflight = await manager.inspectSource(selected);
  await assert.rejects(manager.start(selected, preflight), /connection lost/);
  assert.equal(manager.phase, "paused");
  assert.deepEqual(manager.staging.completed, [0]);
  manager.fetchImpl = rangedFetch(total);
  const partialId = manager.staging.downloadId;
  const manifest = await manager.resume({
    confirmDownload(check, candidate) {
      assert.equal(check.canResume, true);
      assert.equal(check.remainingBytes, 4);
      assert.equal(candidate.sourceUrl, selected.sourceUrl);
      return true;
    },
  });
  assert.equal(manifest.downloadId, partialId);
  assert.equal(manifest.status, "ready");
  assert.deepEqual(manifest.completed, [0, 1]);
});

test("an interrupted download never combines chunks from different revisions of the same size", async () => {
  const chunkSize = 8 * 1024 * 1024;
  const total = chunkSize + 4;
  const dates = ["Mon, 02 Mar 2026 12:00:00 GMT", "Tue, 03 Mar 2026 12:00:00 GMT"];
  let revision = 0;
  const ranges = [];
  const fetchImpl = async (_url, { headers }) => {
    const [start, end] = headers.Range.slice("bytes=".length).split("-").map(Number);
    if (start === chunkSize && revision === 0) throw new TypeError("interrupted");
    if (end > 0) ranges.push({ start, condition: headers["If-Range"] });
    return new Response(new Uint8Array(end - start + 1).fill(revision + 1), {
      status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}`,
        "last-modified": dates[revision], date: "Wed, 04 Mar 2026 12:00:00 GMT" },
    });
  };
  const options = { baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(), navigatorObject: navigatorStub(), fetchImpl };
  const first = new OfflineManager(options);
  await first.init();
  const selected = selection(total);
  await assert.rejects(first.start(selected, await first.inspectSource(selected)), /interrupted/);
  assert.deepEqual(first.staging.completed, [0]);
  const reopened = new OfflineManager(options);
  await reopened.init();
  const unchanged = await reopened.inspectSource(selected);
  assert.equal(unchanged.canResume, true);
  for (const headers of [{}, { etag: 'W/"weak"' }, { "last-modified": dates[0], date: dates[0] }]) {
    reopened.fetchImpl = async () => new Response(null, { status: 206, headers: {
      "content-range": `bytes 0-0/${total}`, ...headers,
    } });
    assert.equal((await reopened.inspectSource(selected)).canResume, false);
  }
  reopened.fetchImpl = fetchImpl;
  revision = 1;
  await assert.rejects(reopened.start(selected, unchanged), { code: "changed" });
  assert.deepEqual(reopened.staging.completed, [0]);
  ranges.length = 0;
  const replacement = await reopened.inspectSource(selected);
  const ready = await reopened.start(selected, replacement);

  const cache = await options.cacheStorage.open(ready.cacheName);
  for (const index of [0, 1]) {
    const chunk = await cache.match(offlineChunkUrl(reopened.baseUrl, ready.downloadId, index));
    assert.equal(new Uint8Array(await chunk.arrayBuffer())[0], 2);
  }
  assert.equal(replacement.canResume, false);
  assert.deepEqual(ranges, [{ start: 0, condition: dates[1] }, { start: chunkSize, condition: dates[1] }]);
});

test("reports an unsupported server instead of accepting a full response", async () => {
  const manager = new OfflineManager({
    baseUrl: "https://example.test/",
    fetchImpl: async () => new Response(new Uint8Array([0]), { status: 200, headers: { "content-length": "10" } }),
    cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigatorStub(),
  });
  await manager.init();
  await assert.rejects(manager.inspectSource(selection()), (error) => error.code === "range");
});

for (const filename of ["book.json", "episode.json"]) test(`downloads and reloads offline with ${filename} after a shell upgrade`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const baseUrl = "https://example.test/";
  const raw = { id: "book", defaultLanguage: "en", title: { en: "Book" }, languages: { en: { sources: { opus: { 64: "audio.webm" } } } } };
  const library = normalizeLibrary({ books: [{ id: "book" }] });
  const audioFetch = rangedFetch(10);
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/library.json")) return Response.json({ books: [{ id: "book" }], ui: { onboardingEnabled: false } });
    if (url.endsWith(`/media/book/${filename}`)) return new Response(JSON.stringify(raw));
    if (url.endsWith("/book.json")) return new Response(null, { status: 404 });
    return audioFetch(url, options);
  };
  const configUrl = baseUrl + "media/book/" + filename;
  const cacheStorage = new MemoryCacheStorage();
  const navigator = navigatorStub();
  const page = await openPlayerPage(t, raw, assert.fail, new Map(), { fetch: fetchImpl, caches: cacheStorage, navigator, confirm: () => true });
  page.elements.get("offlineDownloadBtn").dispatchEvent(new Event("click"));
  await settle();
  const published = await workerContext({ caches: cacheStorage });
  const manifest = await published.activeManifest();
  assert.equal(manifest.episodeId, "book");
  assert.equal(manifest.episodeTitle, "Book");
  assert.equal(Object.hasOwn(manifest, "bookId"), false);
  assert.equal(manifest.assets.find((asset) => asset.required).url, configUrl);
  assert.ok(await (await cacheStorage.open(manifest.cacheName)).match(configUrl));

  const oldShell = "compact-player-app-shell:%2F:v10";
  const otherShell = "compact-player-app-shell:%2Fkids%2F:v10";
  const legacyShell = "compact-player-shell-v10";
  for (const name of [oldShell, otherShell, legacyShell]) await cacheStorage.open(name);
  const events = {};
  const context = await workerContext({
    self: { registration: { scope: baseUrl }, location: { origin: new URL(baseUrl).origin },
      addEventListener: (name, handler) => { events[name] = handler; }, clients: { claim: async () => {} } },
    caches: cacheStorage, fetch: async () => { throw new TypeError("Offline"); },
    URL, Request, Response, ReadableStream,
  });
  let activated;
  events.activate({ waitUntil: (promise) => { activated = promise; } });
  await activated;
  assert.equal((await cacheStorage.keys()).includes(oldShell), false);
  assert.ok((await cacheStorage.keys()).includes(otherShell));
  assert.ok((await cacheStorage.keys()).includes(legacyShell));
  assert.ok((await cacheStorage.keys()).includes(manifest.cacheName));

  const offlineFetch = (url, options) => context.networkFirst(new Request(url, options));
  const offlineNavigator = navigatorStub();
  offlineNavigator.onLine = false;
  const reloaded = new OfflineManager({ baseUrl, fetchImpl: offlineFetch, cacheStorage, navigatorObject: offlineNavigator });
  await reloaded.init();
  assert.equal(reloaded.active.episodeId, "book");
  const offlineConfigs = new BookConfigStore({ library, documentBaseUrl: baseUrl, fetchImpl: offlineFetch, retries: 1 });
  assert.equal((await offlineConfigs.load("book")).configUrl, configUrl);
  const response = await offlineFetch(manifest.sourceUrl, { headers: { Range: "bytes=8-9" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 8-9/10");
  assert.equal((await response.arrayBuffer()).byteLength, 2);
});

test("service worker range parser handles open and suffix requests", async () => {
  const context = await workerContext({
    self: {
      registration: { scope: "https://example.test/" },
      location: { origin: "https://example.test" },
      addEventListener() {},
    },
    caches: {},
    URL,
    Request,
    Response,
    ReadableStream,
    Set,
    Math,
    Number,
  });
  const open = vm.runInContext("parseRange('bytes=10-', 100)", context);
  const suffix = vm.runInContext("parseRange('bytes=-10', 100)", context);
  assert.deepEqual({ ...open }, { start: 10, end: 99, partial: true });
  assert.deepEqual({ ...suffix }, { start: 90, end: 99, partial: true });
  assert.equal(vm.runInContext("parseRange('bytes=0-1,4-5', 100)", context), null);
  assert.equal(vm.runInContext("parseRange('bytes=100-', 100)", context), null);

  context.mediaRequest = new Request("https://example.test/audio.webm", { headers: { Range: "bytes=3-7" } });
  context.mediaManifest = {
    downloadId: "one",
    sourceUrl: "https://example.test/audio.webm",
    mime: "audio/webm",
    totalSize: 10,
    chunkSize: 4,
  };
  context.mediaCache = {
    async match(input) {
      const index = Number(new URL(input).pathname.split("/").at(-1));
      const values = [Uint8Array.from([0, 1, 2, 3]), Uint8Array.from([4, 5, 6, 7]), Uint8Array.from([8, 9])];
      return new Response(values[index]);
    },
  };
  const response = await vm.runInContext("cachedMediaResponse(mediaRequest, mediaManifest, mediaCache)", context);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 3-7/10");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [3, 4, 5, 6, 7]);
});

test("canceling an offline range stops reads at the last requested chunk", async () => {
  const scope = "https://example.test/";
  const context = await workerContext({ self: { registration: { scope }, addEventListener() {} }, URL, Request, Response, ReadableStream });
  const reads = [];
  const bodies = [];
  const cache = {
    async match(url) {
      const index = Number(new URL(url).pathname.split("/").at(-1));
      reads.push(index);
      return { async arrayBuffer() { bodies.push(index); return Uint8Array.of(index * 2, index * 2 + 1).buffer; } };
    },
  };
  const manifest = { downloadId: "one", totalSize: 12, chunkSize: 2, mime: "audio/webm" };
  const request = new Request(scope + "audio.webm", { headers: { Range: "bytes=3-" } });
  const response = await context.cachedMediaResponse(request, manifest, cache);
  const reader = response.body.getReader();
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-length"), "9");
  assert.deepEqual([...(await reader.read()).value], [3]);
  assert.deepEqual([...(await reader.read()).value], [4, 5]);
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [1, 2]);
  assert.deepEqual(bodies, [1, 2]);

  const full = await context.cachedMediaResponse(new Request(request.url), manifest, cache);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-length"), "12");
  assert.deepEqual([...new Uint8Array(await full.arrayBuffer())], Array.from({ length: 12 }, (_, i) => i));
  const readCount = reads.length;
  const head = await context.cachedMediaResponse(new Request(request.url, { method: "HEAD" }), manifest, cache);
  assert.equal(head.headers.get("content-length"), "12");
  assert.equal(head.body, null);
  const pastEnd = await context.cachedMediaResponse(new Request(request.url, { headers: { Range: "bytes=12-" } }), manifest, cache);
  assert.equal(pastEnd.status, 416);
  assert.equal(pastEnd.headers.get("content-range"), "bytes */12");
  assert.equal(reads.length, readCount);
});

test("online audio ranges use the native browser network path", async () => {
  const events = {};
  let intercepted = false;
  let fetched = false;
  const context = await workerContext({
    self: {
      registration: { scope: "https://example.test/" },
      location: { origin: "https://example.test" },
      navigator: { onLine: true },
      addEventListener: (name, handler) => { events[name] = handler; },
    },
    fetch: async () => { fetched = true; return new Response(); },
    URL, Request, Response,
  });
  const request = new Request("https://example.test/book.m4b", { headers: { Range: "bytes=12000000-" } });
  Object.defineProperty(request, "destination", { value: "audio" });
  events.fetch({ request, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, false);
  assert.equal(fetched, false);
});

test("offline audio still serves downloaded ranges through the worker", async () => {
  const events = {};
  const context = await workerContext({
    self: {
      registration: { scope: "https://example.test/" },
      location: { origin: "https://example.test" },
      navigator: { onLine: false },
      addEventListener: (name, handler) => { events[name] = handler; },
    },
    fetch: async () => { throw new TypeError("Offline"); },
    URL, Request, Response,
  });
  context.cachedFallback = async () => new Response(new Uint8Array([7, 8]), {
    status: 206, headers: { "content-range": "bytes 7-8/10" },
  });
  const request = new Request("https://example.test/book.m4b", { headers: { Range: "bytes=7-8" } });
  Object.defineProperty(request, "destination", { value: "audio" });
  let responsePromise;
  events.fetch({ request, respondWith: (promise) => { responsePromise = promise; } });
  const response = await responsePromise;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 7-8/10");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7, 8]);
});

async function savedBookFixture() {
  const baseUrl = "https://example.test/";
  const config = { id: "book", defaultLanguage: "en", title: { en: "Saved book" },
    languages: { en: { sources: { opus: { 64: "audio.webm" }, mp3: { 64: "alternate.mp3" } } } } };
  const configUrl = new URL("media/book/book.json", baseUrl).href;
  const selected = { ...selection(), sourceUrl: new URL("audio.webm", configUrl).href,
    assets: [{ url: configUrl, required: true }] };
  const audioFetch = rangedFetch(10);
  const options = { baseUrl, cacheStorage: new MemoryCacheStorage(), navigatorObject: navigatorStub(),
    fetchImpl: (url, request) => url === configUrl ? Response.json(config) : audioFetch(url, request) };
  const manager = new OfflineManager(options);
  await manager.init();
  const saved = await manager.start(selected, await manager.inspectSource(selected));
  return { manager, saved, selected, options, config, configUrl };
}

test("a stale tab cannot delete a replacement that also needs its configuration repaired", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, selected, saved, configUrl } = await savedBookFixture();
  const caches = options.cacheStorage;
  await (await caches.open(saved.cacheName)).delete(configUrl);
  await manager.refresh();
  assert.equal(manager.repairable.downloadId, saved.downloadId);

  const writer = new OfflineManager(options);
  await writer.init();
  const remove = caches.delete.bind(caches);
  const blocked = t.mock.method(caches, "delete", async (name) => {
    if (name === saved.cacheName) throw new Error("Previous cache cleanup failed");
    return remove(name);
  });
  const replacement = await writer.start({ ...selected, episodeId: "second", configBookId: "book" });
  await (await caches.open(replacement.cacheName)).delete(configUrl);
  await writer.refresh();
  assert.equal(writer.repairable.downloadId, replacement.downloadId);
  await assert.rejects(manager.removeActive(), { code: "conflict" });
  const chunk = offlineChunkUrl(options.baseUrl, replacement.downloadId, 0);
  assert.ok(await caches.match(chunk, { cacheName: replacement.cacheName }));
  blocked.mock.restore();
  await writer.removeActive();
  assert.ok(!(await caches.keys()).includes(replacement.cacheName));
  assert.ok((await caches.keys()).includes(saved.cacheName));
  await writer.refresh();
  assert.equal(writer.repairable, null);
  assert.ok(!(await caches.keys()).includes(saved.cacheName));
});

test("a controlling player worker keeps its saved book readable when registration fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { options, saved, configUrl } = await savedBookFixture();
  for (const script of ["other/sw.js", "sw.js"]) {
    const navigatorObject = { ...navigatorStub(), onLine: false, serviceWorker: {
      controller: { scriptURL: new URL(script, options.baseUrl).href },
      register: async () => { throw new TypeError("Registration unavailable"); },
    } };
    const manager = new OfflineManager({ ...options, navigatorObject });
    await manager.init();
    assert.equal(manager.active?.downloadId, script === "sw.js" ? saved.downloadId : undefined);
    if (script === "sw.js") assert.equal(manager.downloadedConfig.url, configUrl);
  }
});

test("an unreadable cache preserves the server response and the original network failure", async () => {
  let reads = 0;
  const forbidden = new Response("Forbidden", { status: 403 });
  const offline = new TypeError("Offline");
  const worker = await workerContext({
    fetch: async () => forbidden,
    caches: { open: async () => { reads++; throw new Error("Unreadable cache"); } },
  });
  const request = new Request("https://example.test/media/book/book.json");
  assert.equal(await worker.networkFirst(request), forbidden);
  assert.equal(reads, 1);
  worker.fetch = async () => { throw offline; };
  await assert.rejects(worker.networkFirst(request), (error) => error === offline);
  assert.equal(reads, 2);
});

test("an offline startup retains online alternative sources after reconnecting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { options, config, selected } = await savedBookFixture();
  const navigator = { ...options.navigatorObject, onLine: false };
  const page = await openPlayerPage(t, config, assert.fail, new Map(), { caches: options.cacheStorage, navigator });
  const tries = [];
  page.audio.play = async () => {
    tries.push(page.audio.src);
    if (page.audio.src === selected.sourceUrl) throw new DOMException("Unsupported codec", "NotSupportedError");
  };
  navigator.onLine = true;
  page.window.dispatchEvent(new Event("online"));
  assert.deepEqual(tries, []);
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(tries, [selected.sourceUrl, new URL("alternate.mp3", selected.sourceUrl).href]);
});

test("downloading a repairable selection only asks to replace a different selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options, saved, configUrl, config } = await savedBookFixture();
  await (await options.cacheStorage.open(saved.cacheName)).delete(configUrl);
  const prompts = [];
  const { elements } = await openPlayerPage(t, { ...config, debug: { showAllQualities: true } }, rangedFetch(10), new Map(), {
    navigator: options.navigatorObject, caches: options.cacheStorage,
    confirm(message) { prompts.push(message); return false; },
  });
  assert.equal(elements.get("offlineRepairBtn").hidden, false);
  const download = elements.get("offlineDownloadBtn");
  assert.equal(download.textContent, "Download for offline use");
  download.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^Download /);
  const quality = elements.get("qualitySelect");
  quality.value = "mp3-64";
  quality.dispatchEvent(new Event("change"));
  await settle();
  download.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /replace the downloaded copy/);
  const worker = await workerContext({ caches: options.cacheStorage });
  assert.equal(await worker.activeManifest(), null);
});

test("a missing required configuration can be restored without fetching or discarding saved audio", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options, saved, configUrl, config } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  const original = await (await cache.match(chunk)).arrayBuffer();
  await cache.delete(configUrl);
  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal(reloaded.active, null);
  assert.equal(await reloaded.readRecord("active"), null);
  assert.equal(reloaded.repairable?.downloadId, saved.downloadId);
  assert.ok(await cache.match(chunk));
  const requests = [];
  const page = await openPlayerPage(t, config, assert.fail, new Map(), {
    navigator: options.navigatorObject, caches: options.cacheStorage,
    fetch: async (url, init) => {
      if (url === configUrl) {
        if (init?.headers?.["x-compact-player-download"]) requests.push(url);
        return Response.json(config);
      }
      if (url.endsWith("/library.json")) return Response.json({ books: [{ id: config.id }], ui: { onboardingEnabled: false } });
      assert.fail(`Unexpected fetch of ${url}`);
    },
  });
  const restore = page.elements.get("offlineRepairBtn");
  assert.equal(restore.hidden, false);
  restore.dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(requests, [configUrl]);
  assert.equal((await reloaded.readRecord("active"))?.downloadId, saved.downloadId);
  assert.equal(restore.hidden, true);
  assert.deepEqual(await (await cache.match(chunk)).arrayBuffer(), original);
  assert.deepEqual(await (await cache.match(configUrl)).json(), config);
});

test("partial reset reports the failed store and retries only that store", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { options, saved, config } = await savedBookFixture();
  const { navigatorObject, cacheStorage } = options;
  const local = new Map();
  const location = Object.assign(new URL(options.baseUrl), { reload: t.mock.fn() });
  const { elements } = await openPlayerPage(t, config, assert.fail, local, { navigator: navigatorObject, caches: cacheStorage, location });
  const locks = navigatorObject.locks;
  navigatorObject.locks = { request: async () => { throw new DOMException("Write denied", "SecurityError"); } };
  elements.get("resetOk").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(location.reload.mock.callCount(), 0);
  assert.ok((await cacheStorage.keys()).includes(saved.cacheName));
  assert.match(elements.get("resetBody").children[0].textContent, /offline download/i);
  assert.equal(elements.get("resetOk").disabled, false);
  const key = [...local.keys()].find((key) => key.endsWith(":reset"));
  const resetId = local.get(key);
  assert.ok(resetId);
  navigatorObject.locks = locks;
  elements.get("resetOk").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(location.reload.mock.callCount(), 1);
  assert.equal(local.get(key), resetId);
  assert.ok(!(await cacheStorage.keys()).includes(saved.cacheName));
});

test("download preparation can be canceled or time out before any chunks are written", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { options, saved, config } = await savedBookFixture();
  const signals = [];
  const { elements } = await openPlayerPage(t, config, (_url, init) => {
    if (!init.headers?.["x-compact-player-download"]) return new Response(null);
    signals.push(init.signal);
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  }, new Map(), { navigator: options.navigatorObject, caches: options.cacheStorage });
  const quality = elements.get("qualitySelect");
  quality.value = "mp3-64";
  quality.dispatchEvent(new Event("change"));
  const download = elements.get("offlineDownloadBtn"), cancel = elements.get("offlineCancelBtn");
  download.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(cancel.hidden, false);
  cancel.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(signals[0].aborted, true);
  assert.equal(download.disabled, false);
  download.dispatchEvent(new Event("click"));
  await settle();
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(signals[1].aborted, true);
  assert.equal(cancel.hidden, true);
  assert.equal(download.disabled, false);
  assert.match(elements.get("statusAnnouncer").textContent, /timed out/i);
  const restarted = new OfflineManager(options);
  await restarted.init();
  assert.equal(restarted.active?.downloadId, saved.downloadId);
  assert.equal(restarted.staging, null);
});

test("a published replacement stays successful when housekeeping fails and cleanup retries", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const failAt of ["staging record", "previous cache"]) {
    const { manager, options, selected, saved } = await savedBookFixture();
    const replacement = { ...selected, sourceId: "mp3-64", mime: "audio/mpeg",
      sourceUrl: new URL("alternate.mp3", selected.sourceUrl).href };
    const storage = options.cacheStorage;
    const cache = failAt === "staging record" ? await manager.metaCache() : storage;
    const remove = cache.delete.bind(cache);
    const failure = t.mock.method(cache, "delete", async (key) => {
      if (key === saved.cacheName || key.endsWith("/staging.json")) throw new DOMException("Delete failed", "UnknownError");
      return remove(key);
    });
    const ready = await manager.start(replacement, await manager.inspectSource(replacement));
    assert.equal(manager.phase, "ready");
    assert.equal((await manager.readRecord("active")).downloadId, ready.downloadId);
    failure.mock.restore();
    const reopened = new OfflineManager(options);
    await reopened.init();
    assert.equal(reopened.active.downloadId, ready.downloadId);
    assert.equal(await reopened.readRecord("staging"), null);
    assert.ok(!(await storage.keys()).includes(saved.cacheName));
  }
});

test("retrying a local reset leaves the successfully cleared download store alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { options, config, saved } = await savedBookFixture();
  const local = new Map();
  const location = Object.assign(new URL(options.baseUrl), { reload: t.mock.fn() });
  const { elements } = await openPlayerPage(t, config, assert.fail, local,
    { navigator: options.navigatorObject, caches: options.cacheStorage, location });
  const blocked = t.mock.method(globalThis.localStorage, "removeItem", () => { throw new DOMException("Denied", "SecurityError"); });
  elements.get("resetOk").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(location.reload.mock.callCount(), 0);
  assert.ok(!(await options.cacheStorage.keys()).includes(saved.cacheName));
  assert.match(elements.get("resetBody").children[0].textContent, /settings or listening positions/i);
  blocked.mock.restore();
  const locks = t.mock.method(options.navigatorObject.locks, "request");
  elements.get("resetOk").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(locks.mock.callCount(), 0);
  assert.equal(location.reload.mock.callCount(), 1);
});

test("canceling a resume during the range check discards only the partial download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved, config } = await savedBookFixture();
  const total = 8 * 1024 * 1024 + 4;
  const next = { ...selection(total), episodeId: "replacement" };
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start(next, await manager.inspectSource(next)), /connection lost/);
  const partial = manager.staging.cacheName;
  let rangeSignal;
  const { elements } = await openPlayerPage(t, config, (_url, { signal }) => {
    rangeSignal = signal;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  }, new Map(), { navigator: options.navigatorObject, caches: options.cacheStorage });
  elements.get("offlineDownloadBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(elements.get("offlineCancelBtn").hidden, false);
  elements.get("offlineCancelBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(rangeSignal.aborted, true);
  assert.equal(await manager.readRecord("staging"), null);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.ok(!(await options.cacheStorage.keys()).includes(partial));
});

test("a non-audio chunk after a valid probe preserves the published book", async () => {
  const { manager, saved, options } = await savedBookFixture();
  const next = { ...selection(), episodeId: "next" };
  for (const mime of ["text/html", "audio/mpeg"]) {
    manager.fetchImpl = async (url, init) => {
      const response = await rangedFetch(10, { contentType: "audio/webm" })(url, init);
      if (init.headers.Range !== "bytes=0-0") response.headers.set("content-type", mime);
      return response;
    };
    await assert.rejects(manager.start(next), { code: "mime" });
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.ok((await options.cacheStorage.keys()).includes(saved.cacheName));
  }
});

test("an unversioned download stores all chunks from one audio response", async () => {
  const size = 8 * 1024 * 1024;
  const total = size + 4;
  const requests = [];
  const cacheStorage = new MemoryCacheStorage();
  const fetchImpl = async (_url, { headers }) => {
    const [start, end] = headers.Range.slice(6).split("-").map(Number);
    requests.push(headers.Range);
    const revision = requests.length;
    const bytes = new Uint8Array(end - start + 1).fill(revision);
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, 3));
      controller.enqueue(bytes.subarray(3));
      controller.close();
    } });
    return new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}`, "content-type": "audio/webm" } });
  };
  const manager = new OfflineManager({ baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl });
  await manager.init();
  const saved = await manager.start(selection(total));
  const cache = await cacheStorage.open(saved.cacheName);
  for (const [index, length] of [size, 4].entries()) {
    const chunk = await cache.match(offlineChunkUrl(manager.baseUrl, saved.downloadId, index));
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    assert.equal(bytes.length, length);
    assert.ok(bytes.every((byte) => byte === 2));
  }
  assert.deepEqual(requests, ["bytes=0-0", `bytes=0-${total - 1}`]);
});

test("reset offers an immediate retry while another tab holds the offline lock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { manager, options, saved, config } = await savedBookFixture();
  const location = Object.assign(new URL(options.baseUrl), { reload: t.mock.fn() });
  const local = new Map();
  const { elements } = await openPlayerPage(t, config, assert.fail, local,
    { navigator: options.navigatorObject, caches: options.cacheStorage, location });
  let release;
  const held = manager.withLock(() => new Promise((resolve) => { release = resolve; }));
  try {
    elements.get("resetOk").dispatchEvent(new Event("click"));
    await settle();
    assert.equal(elements.get("resetOk").disabled, false);
    assert.match(elements.get("resetBody").children[0].textContent, /another tab/i);
    assert.ok((await options.cacheStorage.keys()).includes(saved.cacheName));
  } finally { release(); await held; }
  const epoch = [...local.entries()].find(([key]) => key.endsWith(":reset"));
  elements.get("resetOk").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(location.reload.mock.callCount(), 1);
  assert.equal(local.get(epoch[0]), epoch[1]);
  assert.ok(!(await options.cacheStorage.keys()).includes(saved.cacheName));
});

test("the worker reads the player's shared storage addresses in a nested installation", async (t) => {
  const scope = "https://example.test/books/listen/";
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) });
  const saved = await manager.start(selection());
  const contract = globalThis.CompactPlayerOfflineManifest;
  assert.equal(offlineChunkUrl, contract.offlineChunkUrl);
  assert.equal(offlineManifestUrl, contract.offlineManifestUrl);
  assert.equal(contract.offlineMetaUrl(scope, "active"), scope + "__compact_player_offline__/active.json");
  assert.equal(contract.offlineChunkUrl(scope, "a/b", 1), scope + "__compact_player_offline__/chunks/a%2Fb/1");
  const metaUrl = t.mock.fn(contract.offlineMetaUrl);
  const chunkUrl = t.mock.fn(contract.offlineChunkUrl);
  const worker = await workerContext({ caches: cacheStorage, self: { registration: { scope }, addEventListener() {} } },
    (format) => ({ ...format, offlineMetaUrl: metaUrl, offlineChunkUrl: chunkUrl }));
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);
  const response = await worker.cachedBookResponse(new Request(saved.sourceUrl, { headers: { range: "bytes=2-4" } }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 3);
  assert.deepEqual([...metaUrl.mock.calls[0].arguments], [scope, "active"]);
  assert.deepEqual([...chunkUrl.mock.calls[0].arguments], [scope, saved.downloadId, 0]);
});

test("an IndexedDB lock request queued behind an upgrade cannot reset the book later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const request = { transaction: { abort: t.mock.fn() }, result: { close: t.mock.fn() } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => request } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  });
  manager.navigator.locks = undefined;
  const expected = assert.rejects(manager.reset(), { code: "conflict" });
  await settle();
  t.mock.timers.tick(1000);
  await expected;
  request.onupgradeneeded();
  assert.equal(request.transaction.abort.mock.callCount(), 1);
  assert.ok((await options.cacheStorage.keys()).includes(saved.cacheName));
});

test("a truncated or oversized unversioned response cannot replace a playable download", async () => {
  const { manager, saved } = await savedBookFixture();
  for (const actualSize of [9, 11]) {
    manager.fetchImpl = async (_url, { headers }) => {
      const probe = headers.Range === "bytes=0-0";
      return new Response(new Uint8Array(probe ? 1 : actualSize), {
        status: 206, headers: { "content-type": "audio/webm", "content-range": probe ? "bytes 0-0/10" : "bytes 0-9/10" },
      });
    };
    await assert.rejects(manager.start(selection()), { code: "incomplete" });
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  }
});
