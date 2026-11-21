import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BookConfigStore } from "../js/book-config.js";
import { normalizeLibrary } from "../js/config.js";
import { buildSources, chooseDefaultSource } from "../js/source-selection.js";
import { deferred, openPlayerPage } from "./player-page.mjs";
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
  const page = await openPlayerPage(config, assert.fail, new Map([["compactAudioPlayer.onboardingShown.v1", "1"]]), {
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
  const page = await openPlayerPage(config, assert.fail, new Map(), {
    navigator, fetch, caches: cacheStorage, location: new URL("?book=other", baseUrl),
  });
  assert.equal(page.elements.get("bookTitle").textContent, config.title.en);
  assert.equal(page.elements.get("offlineRow").hidden, true);
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(page.audio.src, selected.sourceUrl);
  const audio = await page.window.fetch(page.audio.src, { headers: { Range: "bytes=1-3" } });
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
    assert.equal(writer.snapshot().canCancel, false);
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

test("a confirmed restart credits only the partial audio it can actually free under the write lock", async () => {
  const mib = 1024 ** 2;
  const total = 9 * mib;
  for (const scenario of ["enough after restart", "less space after confirmation", "evicted chunk"]) {
    const { manager, saved, options } = await savedBookFixture();
    const selected = { ...selection(total), episodeId: "next" };
    manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
    await assert.rejects(manager.start(selected), /connection lost/);
    const staged = manager.staging;
    const chunk = offlineChunkUrl(options.baseUrl, staged.downloadId, 0);
    const cache = await options.cacheStorage.open(staged.cacheName);
    const range = rangedFetch(total);
    manager.fetchImpl = async (url, request) => {
      const response = await range(url, request);
      response.headers.set("etag", '"second"');
      return response;
    };
    let free = scenario === "enough after restart" ? 20 : 30;
    const estimates = [];
    options.navigatorObject.storage.estimate = async () => {
      estimates.push(heldLocks.size > 0);
      return { quota: 100 * mib, usage: (100 - free) * mib };
    };
    const check = await manager.inspectSource(selected);
    assert.equal(check.canResume, false);
    assert.equal(await manager.start(selected, check, { confirmDownload: () => false }), null);
    assert.ok(await cache.match(chunk));
    if (scenario === "evicted chunk") await cache.delete(chunk);
    const restart = manager.start(selected, check, { confirmDownload: () => {
      free = scenario === "less space after confirmation" ? 16 : 20;
      return true;
    } });
    if (scenario === "enough after restart") {
      assert.equal((await restart).episodeId, selected.episodeId);
      assert.ok(!(await options.cacheStorage.keys()).includes(staged.cacheName));
    } else {
      await assert.rejects(restart, { code: "quota" });
      assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
      assert.equal((await manager.readRecord("staging")).downloadId, staged.downloadId);
    }
    assert.deepEqual(estimates, [false, true]);
  }
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
  const page = await openPlayerPage(raw, assert.fail, new Map(), { fetch: fetchImpl, caches: cacheStorage, navigator, confirm: () => true });
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
  const { versionHeader, versionHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  assert.equal(response.headers.get(versionHeader), versionHeaderValue(manifest.cacheVersion));
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

test("a downloaded catalog remains usable and retries on reconnection or when Options opens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, selected, config, configUrl, options } = await savedBookFixture();
  const url = new URL("media/library.json", options.baseUrl).href;
  const old = { books: [{ id: "book" }], ui: { onboardingEnabled: false } };
  manager.fetchImpl = (path, request) => path === url ? Response.json(old) : options.fetchImpl(path, request);
  await manager.start({ ...selected, assets: [...selected.assets, { url, required: false }] });
  for (const trigger of ["online", "options"]) {
    let live = false;
    let catalogs = 0;
    const worker = await workerContext({ caches: options.cacheStorage, fetch: (request) => {
      if (request.url === url) {
        catalogs++;
        return live ? Response.json({ ...old, books: [...old.books, { id: "new" }] }) : new Response(null, { status: 503 });
      }
      return request.url === configUrl ? Response.json(config) : Response.json({ ...config, id: "new" });
    } });
    const page = await openPlayerPage(config, assert.fail, new Map(), {
      fetch: (path, init) => worker.networkFirst(new Request(path, init)),
    });
    await page.ready;
    const ids = () => page.elements.get("bookSelect").children.map((option) => option.value);
    assert.deepEqual(ids(), ["book"]);
    page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    const pauses = t.mock.method(page.audio, "pause");
    page.window.dispatchEvent(new Event("online"));
    await settle();
    assert.deepEqual(ids(), ["book"]);
    assert.equal(catalogs, 2);
    live = true;
    if (trigger === "online") page.window.dispatchEvent(new Event("online"));
    else page.elements.get("optionsBtn").dispatchEvent(new Event("click"));
    await settle();
    assert.deepEqual(ids(), ["book", "new"]);
    page.window.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(catalogs, 3);
    assert.equal(pauses.mock.callCount(), 0);
    assert.equal(page.audio.src, selected.sourceUrl);
  }
});

test("offline WebVTT is accepted only for the downloaded edition and retries when connectivity returns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const chapter = (label) => `WEBVTT\n\n00:00.000 --> 00:15.000\n${label}`;
  const { manager, selected, config, configUrl, options } = await savedBookFixture();
  const url = new URL("chapter-list", configUrl).href;
  config.languages.en.chapters = "chapter-list";
  manager.fetchImpl = (path, request) => path === url ? new Response(chapter("First edition")) : options.fetchImpl(path, request);
  await manager.start({ ...selected, assets: [...selected.assets, { url, required: false }] });
  let healthy = false;
  const worker = await workerContext({ caches: options.cacheStorage, fetch: () =>
    healthy ? new Response(chapter("Second edition")) : new Response(null, { status: 503 }) });
  const saved = new Map();
  const visit = (cacheVersion) => openPlayerPage({ ...config, cacheVersion },
    (path, init) => worker.networkFirst(new Request(path, init)), saved);
  const original = await visit(1);
  assert.equal(original.storage.readChapters("book", "en", 1, url), chapter("First edition"));
  const next = await visit(2);
  assert.equal(next.storage.readChapters("book", "en", 2, url), "");
  assert.match(next.elements.get("chaptersList").children[0].className, /chapter-load-error/);
  healthy = true;
  next.window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(next.elements.get("chaptersList").children[0].children[0].textContent, "Second edition");
  assert.equal(next.storage.readChapters("book", "en", 2, url), chapter("Second edition"));
  healthy = false;
  const reopened = await visit(2);
  assert.equal(reopened.elements.get("chaptersList").children[0].children[0].textContent, "Second edition");
});

test("an idle audio range pauses the download and another tab resumes the missing bytes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const total = 8 * 1024 ** 2 + 4;
  const lastRange = `bytes=${total - 4}-${total - 1}`;
  const range = rangedFetch(total);
  const selected = { ...selection(total), episodeId: "next" };
  for (const stall of ["headers", "body"]) {
    const { manager, options, saved } = await savedBookFixture();
    const waiting = deferred();
    const requests = [];
    let stream;
    manager.fetchImpl = async (url, request) => {
      if (request.headers.Range !== lastRange) return range(url, request);
      if (stall === "headers") {
        waiting.resolve();
        return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
      }
      const body = new ReadableStream({
        start(controller) { stream = controller; },
        pull() { waiting.resolve(); },
      });
      return new Response(body, { status: 206, headers: { "content-range": `bytes ${total - 4}-${total - 1}/${total}` } });
    };
    const result = manager.start(selected).catch((error) => error);
    await waiting.promise;
    await settle();
    if (stall === "body") {
      for (const byte of [1, 2]) {
        t.mock.timers.tick(15_000);
        stream.enqueue(Uint8Array.of(byte));
        await settle();
        assert.equal(manager.phase, "downloading");
      }
    }
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(manager.phase, "paused");
    assert.equal((await result).code, "timeout");
    assert.deepEqual(manager.staging.completed, [0]);
    assert.equal(manager.active.downloadId, saved.downloadId);
    const next = new OfflineManager({ ...options, fetchImpl: (url, request) => {
      requests.push(request.headers.Range);
      return range(url, request);
    } });
    await next.init();
    assert.equal((await next.resume()).episodeId, selected.episodeId);
    assert.deepEqual(requests, ["bytes=0-0", lastRange]);
  }
});

test("resume reuses a validated configuration and validates any repair before overwriting cached text", async () => {
  for (const cached of ["valid", "damaged"]) {
    const { manager, options, selected, config, configUrl } = await savedBookFixture();
    const total = 8 * 1024 ** 2 + 4;
    const interrupted = rangedFetch(total, { failSecondChunk: true });
    manager.fetchImpl = (url, request) => url === configUrl ? Response.json(config) : interrupted(url, request);
    await assert.rejects(manager.start(selected), /connection lost/);
    const staged = manager.staging;
    const cache = await options.cacheStorage.open(staged.cacheName);
    if (cached === "damaged") await cache.put(configUrl, new Response("damaged copy"));
    const audio = rangedFetch(total);
    const ranges = [];
    let configReads = 0;
    let maintenance = true;
    manager.fetchImpl = (url, request) => {
      if (url === configUrl) {
        configReads++;
        return maintenance ? new Response("<html>Maintenance</html>") : Response.json(config);
      }
      ranges.push(request.headers.Range);
      return audio(url, request);
    };
    if (cached === "damaged") {
      await assert.rejects(manager.resume(), { code: "config" });
      assert.equal(await (await cache.match(configUrl)).text(), "damaged copy");
      assert.deepEqual(manager.staging.completed, [0]);
      maintenance = false;
      ranges.length = 0;
    }
    assert.equal((await manager.resume()).downloadId, staged.downloadId);
    assert.equal(configReads, cached === "valid" ? 0 : 2);
    assert.deepEqual(ranges, ["bytes=0-0", "bytes=8388608-8388611"]);
    assert.deepEqual(await (await cache.match(configUrl)).json(), config);
  }
});

test("a published book with a missing chunk keeps its intact audio for a version-checked repair", async () => {
  const chunkSize = 8 * 1024 ** 2;
  for (const scenario of ["missing chunk", "missing manifest", "short survivor", "changed revision", "separate download"]) {
    const total = (scenario === "short survivor" ? 2 : 1) * chunkSize + 4;
    const { manager, options, selected, config, configUrl } = await savedBookFixture();
    const audio = rangedFetch(total);
    manager.fetchImpl = (url, request) => url === configUrl ? Response.json(config) : audio(url, request);
    const saved = await manager.start(selected);
    if (scenario === "separate download") {
      manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
      await assert.rejects(manager.start({ ...selection(), episodeId: "replacement" }), /connection lost/);
    }
    const cache = await options.cacheStorage.open(saved.cacheName);
    await cache.delete(offlineChunkUrl(options.baseUrl, saved.downloadId, saved.totalChunks - 1));
    if (scenario === "short survivor") {
      await cache.put(offlineChunkUrl(options.baseUrl, saved.downloadId, 1),
        new Response(Uint8Array.of(1), { headers: { "content-length": String(chunkSize) } }));
    }
    if (scenario === "missing manifest") await cache.delete(offlineManifestUrl(options.baseUrl));
    const ranges = [];
    const reopened = new OfflineManager({ ...options, fetchImpl: async (url, request) => {
      if (url === configUrl) return Response.json(config);
      ranges.push(request.headers.Range);
      const response = await audio(url, request);
      if (scenario === "changed revision") response.headers.set("etag", '"new"');
      return response;
    } });
    await reopened.init();
    assert.equal(reopened.active, null);
    assert.equal(await (await workerContext({ caches: options.cacheStorage })).activeManifest(), null);
    assert.ok((await options.cacheStorage.keys()).includes(saved.cacheName));
    if (scenario === "separate download") {
      assert.equal(reopened.staging.downloadId, manager.staging.downloadId);
      assert.deepEqual(reopened.staging.completed, [0]);
      assert.equal(reopened.repairable.status, "needs-audio");
      await reopened.cancel();
    }
    assert.equal(reopened.staging.downloadId, saved.downloadId);
    await reopened.refresh();
    assert.equal(reopened.staging.downloadId, saved.downloadId);
    assert.deepEqual(reopened.staging.completed, [0]);
    assert.deepEqual(ranges, []);
    const repaired = await reopened.resume();
    assert.equal(repaired.sourceUrl, saved.sourceUrl);
    const expectedRanges = ["bytes=0-0"];
    if (scenario === "changed revision") expectedRanges.push("bytes=0-8388607");
    if (scenario === "short survivor") expectedRanges.push("bytes=8388608-16777215", "bytes=16777216-16777219");
    else expectedRanges.push("bytes=8388608-8388611");
    assert.deepEqual(ranges, expectedRanges);
    assert.equal((await reopened.readRecord("active")).downloadId, repaired.downloadId);
  }
});

test("startup rebuilds a missing local manifest from the published book and verified chunks", async () => {
  for (const damage of ["manifest", "legacy manifest", "invalid manifest", "config", "short chunk", "removed"]) {
    const { manager, options, saved, configUrl } = await savedBookFixture();
    const manifest = damage === "legacy manifest"
      ? { ...saved, cacheName: "compact-player-offline-book-v1-" + saved.downloadId } : saved;
    const cache = await options.cacheStorage.open(manifest.cacheName);
    const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
    const local = offlineManifestUrl(options.baseUrl);
    if (manifest !== saved) {
      const original = await options.cacheStorage.open(saved.cacheName);
      for (const key of [chunk, configUrl]) await cache.put(key, await original.match(key));
      await manager.writeRecord("active", manifest);
      await options.cacheStorage.delete(saved.cacheName);
    }
    await cache.delete(local);
    if (damage === "invalid manifest") await cache.put(local, Response.json({}));
    if (damage === "config") await cache.delete(configUrl);
    if (damage === "short chunk") await cache.put(chunk, new Response(new Uint8Array(2)));
    if (damage === "removed") await cache.put(local, Response.json({ status: "removed", downloadId: saved.downloadId }));
    const reopened = new OfflineManager({ ...options, fetchImpl: assert.fail });
    const state = await reopened.init();
    if (damage === "short chunk" || damage === "removed") {
      assert.equal(state.active, null, damage);
      assert.equal(await reopened.readRecord("active"), null, damage);
    } else {
      assert.equal((state.active || state.repairable)?.downloadId, saved.downloadId, damage);
      assert.equal(Boolean(state.repairable), damage === "config");
      assert.deepEqual(await (await cache.match(local)).json(), manifest);
      assert.ok((await options.cacheStorage.keys()).includes(manifest.cacheName));
    }
  }
});

test("startup reads an unchanged download without writing and a quota error keeps controls available", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved, configUrl } = await savedBookFixture();
  const meta = await manager.metaCache();
  const put = t.mock.method(meta, "put", () => { throw new DOMException("Full", "QuotaExceededError"); });
  const remove = t.mock.method(meta, "delete");
  const reopened = new OfflineManager(options);
  const state = await reopened.init();
  assert.equal(state.supported, true);
  assert.equal(state.active.downloadId, saved.downloadId);
  assert.equal(put.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);

  const cache = await options.cacheStorage.open(saved.cacheName);
  await cache.delete(configUrl);
  const damaged = await reopened.refresh();
  assert.equal(put.mock.callCount(), 1);
  assert.equal(damaged.supported, true);
  assert.equal(damaged.active, null);
  assert.equal(damaged.repairable?.downloadId, saved.downloadId);
  await reopened.removeActive();
  assert.ok(!(await options.cacheStorage.keys()).includes(saved.cacheName));
  assert.equal((await new OfflineManager(options).init()).active, null);
});

test("a partial download resumes from verified chunks after its local manifest disappears", async () => {
  const chunkSize = 8 * 1024 ** 2;
  const total = chunkSize + 4;
  for (const damage of ["missing manifest", "legacy cache", "short chunk"]) {
    const { manager, options, saved } = await savedBookFixture();
    manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(total), episodeId: "other" }), /connection lost/);
    let staging = manager.staging;
    const chunk = offlineChunkUrl(options.baseUrl, staging.downloadId, 0);
    let cache = await options.cacheStorage.open(staging.cacheName);
    if (damage === "legacy cache") {
      const original = cache;
      const name = "compact-player-offline-book-v1-" + staging.downloadId;
      cache = await options.cacheStorage.open(name);
      await cache.put(chunk, await original.match(chunk));
      await options.cacheStorage.delete(staging.cacheName);
      staging = { ...staging, cacheName: name };
      await manager.writeRecord("staging", staging);
    }
    await cache.delete(offlineManifestUrl(options.baseUrl));
    if (damage === "short chunk") await cache.put(chunk, new Response(new Uint8Array(2)));

    const ranges = [];
    const fetchRange = rangedFetch(total);
    const reopened = new OfflineManager({ ...options, fetchImpl: (url, request) => {
      ranges.push(request.headers.Range);
      return fetchRange(url, request);
    } });
    const state = await reopened.init();
    assert.equal(state.active?.downloadId, saved.downloadId);
    assert.equal(state.staging?.downloadId, staging.downloadId, damage);
    assert.deepEqual(state.staging.completed, damage === "short chunk" ? [] : [0]);
    assert.deepEqual(await (await cache.match(offlineManifestUrl(options.baseUrl))).json(), state.staging);
    assert.deepEqual(ranges, []);
    assert.equal((await reopened.resume()).downloadId, staging.downloadId);
    assert.deepEqual(ranges, ["bytes=0-0", ...(damage === "short chunk" ? ["bytes=0-8388607"] : []), "bytes=8388608-8388611"]);
  }
});

test("reopening after interrupted cancellation discards the partial book and keeps the ready one", async (t) => {
  for (const failure of ["staging record", "book cache"]) {
    const { manager, options, saved } = await savedBookFixture();
    manager.fetchImpl = rangedFetch(9 * 1024 ** 2, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(), episodeId: "other" }), /connection lost/);
    const { cacheName } = manager.staging;
    const target = failure === "staging record" ? await manager.metaCache() : options.cacheStorage;
    const remove = t.mock.method(target, "delete", () => { throw new Error("Deletion interrupted"); });
    await assert.rejects(manager.cancel(), /Deletion interrupted/);
    remove.mock.restore();
    const reopened = new OfflineManager(options);
    assert.equal(await reopened.readRecord("staging"), null);
    await reopened.init();
    assert.equal(reopened.snapshot().staging, null);
    assert.equal(reopened.snapshot().active.downloadId, saved.downloadId);
    assert.ok(!(await options.cacheStorage.keys()).includes(cacheName));
  }
});

test("cancel at full quota frees partial audio and survives an interrupted staging-record deletion", async (t) => {
  for (const interrupt of [false, true]) {
    const { manager, options, saved } = await savedBookFixture();
    manager.fetchImpl = rangedFetch(9 * 1024 ** 2, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(), episodeId: "other" }), /connection lost/);
    const { cacheName, downloadId } = manager.staging;
    const chunk = await options.cacheStorage.match(offlineChunkUrl(options.baseUrl, downloadId, 0), { cacheName });
    assert.equal((await chunk.arrayBuffer()).byteLength, 8 * 1024 ** 2);
    const put = t.mock.method(MemoryCache.prototype, "put", () => { throw new DOMException("Full", "QuotaExceededError"); });
    if (interrupt) {
      const meta = await manager.metaCache();
      const remove = t.mock.method(meta, "delete", () => { throw new Error("Cleanup interrupted"); });
      await assert.rejects(manager.cancel(), /Cleanup interrupted/);
      remove.mock.restore();
    } else await manager.cancel();

    assert.equal(manager.snapshot().staging, null);
    assert.ok(!(await options.cacheStorage.keys()).includes(cacheName));
    const reopened = new OfflineManager(options);
    const state = await reopened.init();
    assert.equal(state.active.downloadId, saved.downloadId);
    assert.equal(state.staging, null);
    assert.equal(await reopened.readRecord("staging", true), null);
    assert.ok((await options.cacheStorage.keys()).includes(saved.cacheName));
    put.mock.restore();
  }
});

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
  const page = await openPlayerPage(config, assert.fail, new Map(), { caches: options.cacheStorage, navigator });
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
  const { elements } = await openPlayerPage({ ...config, debug: { showAllQualities: true } }, rangedFetch(10), new Map(), {
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
  const page = await openPlayerPage(config, assert.fail, new Map(), {
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

test("repairing the saved book preserves the other download's paused percentage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved, configUrl, config } = await savedBookFixture();
  manager.fetchImpl = rangedFetch(16 * 1024 ** 2, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(), episodeId: "other", episodeTitle: "Other book" }), /connection lost/);
  await (await options.cacheStorage.open(saved.cacheName)).delete(configUrl);
  const { elements } = await openPlayerPage(config, assert.fail, new Map(), {
    navigator: options.navigatorObject, caches: options.cacheStorage,
  });
  const progress = elements.get("offlineProgress");
  assert.equal(progress.value, 50);
  elements.get("offlineRepairBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(progress.value, 50);
  assert.match(elements.get("offlineStatus").textContent, /Downloaded: Book.*Other book.*paused at 50%/);
  assert.equal(elements.get("offlineDownloadBtn").textContent, "Resume download");
});

test("partial reset reports the failed store and retries only that store", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const { options, saved, config } = await savedBookFixture();
  const { navigatorObject, cacheStorage } = options;
  const local = new Map();
  const location = Object.assign(new URL(options.baseUrl), { reload: t.mock.fn() });
  const { elements } = await openPlayerPage(config, assert.fail, local, { navigator: navigatorObject, caches: cacheStorage, location });
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
  const { elements } = await openPlayerPage(config, (_url, init) => {
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

async function interruptedReplacement(t) {
  const fixture = await savedBookFixture();
  const { manager, options, selected } = fixture;
  const replacement = { ...selected, sourceId: "mp3-64", mime: "audio/mpeg",
    sourceUrl: new URL("alternate.mp3", selected.sourceUrl).href };
  manager.fetchImpl = async (url, request) => {
    const response = await options.fetchImpl(url, request);
    response.headers.delete("etag");
    return response;
  };
  const put = MemoryCache.prototype.put;
  const interrupted = t.mock.method(MemoryCache.prototype, "put", async function (key, value) {
    if (key === offlineManifestUrl(options.baseUrl) && (await value.clone().json()).status === "ready") {
      throw new Error("Ready manifest write interrupted");
    }
    return put.call(this, key, value);
  });
  await assert.rejects(manager.start(replacement), /Ready manifest write interrupted/);
  interrupted.mock.restore();
  return fixture;
}

test("a damaged replacement keeps the published audiobook playable until its audio is repaired", async (t) => {
  for (const marker of ["downloading", "ready"]) {
    for (const action of ["reload", "resume"]) {
      const { manager, options, saved } = await interruptedReplacement(t);
      const replacement = manager.staging;
      const cache = await options.cacheStorage.open(replacement.cacheName);
      if (marker === "ready") {
        await cache.put(offlineManifestUrl(options.baseUrl), Response.json({ ...replacement, status: marker }));
      }
      const chunkUrl = (manifest) => offlineChunkUrl(options.baseUrl, manifest.downloadId, 0);
      const length = marker === "ready" ? 11 : 2;
      await cache.put(chunkUrl(replacement), new Response(new Uint8Array(length), { headers: { "content-length": "10" } }));
      options.navigatorObject.onLine = false;
      const player = action === "reload" ? new OfflineManager(options) : manager;
      if (action === "reload") await player.init();
      else await assert.rejects(player.resume(), { code: "offline" });
      assert.equal((await player.readRecord("active")).downloadId, saved.downloadId);
      assert.deepEqual((await player.readRecord("staging")).completed, []);
      const old = await options.cacheStorage.match(chunkUrl(saved), { cacheName: saved.cacheName });
      assert.equal((await old.arrayBuffer()).byteLength, 10);

      options.navigatorObject.onLine = true;
      player.fetchImpl = options.fetchImpl;
      const repaired = await player.resume();
      assert.equal(repaired.sourceUrl, replacement.sourceUrl);
      assert.equal((await player.readRecord("active")).downloadId, repaired.downloadId);
      const audio = await options.cacheStorage.match(chunkUrl(repaired), { cacheName: repaired.cacheName });
      assert.equal((await audio.arrayBuffer()).byteLength, 10);
    }
  }
});

test("a replacement with a damaged asset list must reopen from its recorded configuration before publication", async (t) => {
  for (const action of ["reload", "resume"]) {
    const { manager, options, saved, configUrl, config } = await interruptedReplacement(t);
    const staged = manager.staging;
    const cache = await options.cacheStorage.open(staged.cacheName);
    const otherUrl = new URL("episode.json", configUrl).href;
    const assets = action === "reload" ? [] : [{ url: otherUrl, required: true }];
    await cache.put(offlineManifestUrl(options.baseUrl), Response.json({ ...staged, status: "ready", assets }));
    await cache.put(otherUrl, Response.json(config));
    await cache.delete(configUrl);
    options.navigatorObject.onLine = false;
    const player = action === "reload" ? new OfflineManager(options) : manager;
    if (action === "reload") await player.init();
    assert.equal((await player.readRecord("active")).downloadId, saved.downloadId);
    await assert.rejects(player.resume(), { code: "offline" });
    assert.ok(await options.cacheStorage.match(offlineChunkUrl(options.baseUrl, saved.downloadId, 0), { cacheName: saved.cacheName }));
    options.navigatorObject.onLine = true;
    const requests = [];
    player.fetchImpl = (url) => { requests.push(url); return Response.json(config); };
    assert.equal((await player.resume()).downloadId, staged.downloadId);
    assert.deepEqual(requests, [configUrl]);
    assert.equal(player.downloadedConfig.url, configUrl);
  }
});

test("a staged book with complete audio needs only its missing configuration", async (t) => {
  const { manager, options, saved, configUrl, config } = await interruptedReplacement(t);
  const staged = manager.staging;
  const cache = await options.cacheStorage.open(staged.cacheName);
  await cache.delete(configUrl);
  const requests = [];
  options.navigatorObject.onLine = false;
  let replacementConfig = { ...config, cacheVersion: 9 };
  const reopened = new OfflineManager({ ...options, fetchImpl: async (url) => {
    requests.push(url);
    return Response.json(replacementConfig);
  } });
  await reopened.init();
  assert.equal(reopened.snapshot().canFinishOffline, false);
  await assert.rejects(reopened.resume(), { code: "offline" });
  assert.deepEqual(requests, []);
  options.navigatorObject.onLine = true;
  await assert.rejects(reopened.resume(), /configuration/);
  assert.equal((await reopened.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(reopened.staging.downloadId, staged.downloadId);
  replacementConfig = config;
  assert.equal((await reopened.resume()).downloadId, staged.downloadId);
  assert.deepEqual(requests, [configUrl, configUrl]);
  assert.ok(await cache.match(offlineChunkUrl(options.baseUrl, staged.downloadId, 0)));
});

test("all cached chunks can be activated offline after interruption before the ready manifest", async (t) => {
  for (const recovery of ["resume", "reload", "missing chunk", "missing config"]) {
    const { manager, options, saved, configUrl } = await interruptedReplacement(t);
    const staged = manager.staging;
    const cache = await options.cacheStorage.open(staged.cacheName);
    const chunk = offlineChunkUrl(options.baseUrl, staged.downloadId, 0);
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.equal((await (await cache.match(offlineManifestUrl(options.baseUrl))).json()).status, "downloading");
    const offlineFetch = t.mock.fn(() => { throw new Error("Offline"); });
    options.navigatorObject.onLine = false;
    if (recovery === "resume") {
      manager.fetchImpl = offlineFetch;
      assert.equal((await manager.resume()).downloadId, staged.downloadId);
    } else {
      if (recovery === "missing chunk") await cache.delete(chunk);
      if (recovery === "missing config") await cache.delete(configUrl);
      const state = await new OfflineManager({ ...options, fetchImpl: offlineFetch }).init();
      assert.equal(state.active.downloadId, recovery === "reload" ? staged.downloadId : saved.downloadId);
    }
    assert.equal(offlineFetch.mock.callCount(), 0);
    if (recovery === "resume" || recovery === "reload") {
      assert.equal((await manager.readRecord("active")).downloadId, staged.downloadId);
      assert.equal(await manager.readRecord("staging"), null);
      assert.equal((await (await cache.match(chunk)).arrayBuffer()).byteLength, 10);
    }
  }
});

test("a completed replacement survives a failed active record write on resume and reload", async (t) => {
  for (const recovery of ["resume", "reload"]) {
    const { manager, options, selected, saved } = await savedBookFixture();
    const replacement = { ...selected, sourceId: "mp3-64", mime: "audio/mpeg",
      sourceUrl: new URL("alternate.mp3", selected.sourceUrl).href };
    const meta = await manager.metaCache();
    const put = meta.put.bind(meta);
    const failure = t.mock.method(meta, "put", (key, value) => {
      if (key.endsWith("/active.json")) throw new Error("Active record write failed");
      return put(key, value);
    });
    await assert.rejects(manager.start(replacement), /Active record write failed/);
    failure.mock.restore();
    const staged = manager.staging;
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.ok(await options.cacheStorage.match(offlineChunkUrl(options.baseUrl, saved.downloadId, 0), { cacheName: saved.cacheName }));
    const fetch = t.mock.fn(() => { throw new Error("Unexpected network request during publication"); });
    manager.fetchImpl = fetch;
    if (recovery === "resume") {
      assert.equal(await manager.resume({ confirmDownload: () => false }), null);
      assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    }
    const ready = recovery === "resume" ? await manager.resume()
      : (await new OfflineManager({ ...options, fetchImpl: fetch }).init()).active;
    assert.equal(ready.downloadId, staged.downloadId);
    assert.equal((await manager.readRecord("active")).downloadId, staged.downloadId);
    assert.equal(await manager.readRecord("staging"), null);
    assert.ok(await options.cacheStorage.match(offlineChunkUrl(options.baseUrl, staged.downloadId, 0), { cacheName: staged.cacheName }));
    assert.equal(fetch.mock.callCount(), 0);
  }
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

test("startup keeps the published replacement usable when clearing staging fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await interruptedReplacement(t);
  const replacement = manager.staging;
  const meta = await manager.metaCache();
  const remove = meta.delete.bind(meta);
  const failure = t.mock.method(meta, "delete", (key) => {
    if (key.endsWith("/staging.json")) throw new Error("Cleanup interrupted");
    return remove(key);
  });
  const reopened = new OfflineManager(options);
  const state = await reopened.init();
  assert.equal((await reopened.readRecord("active")).downloadId, replacement.downloadId);
  assert.equal(state.supported, true);
  assert.equal(state.active.downloadId, replacement.downloadId);
  assert.equal(state.staging, null);
  failure.mock.restore();
  await reopened.refresh();
  assert.equal(await reopened.readRecord("staging"), null);
  assert.ok(!(await options.cacheStorage.keys()).includes(saved.cacheName));
});

test("retrying a local reset leaves the successfully cleared download store alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { options, config, saved } = await savedBookFixture();
  const local = new Map();
  const location = Object.assign(new URL(options.baseUrl), { reload: t.mock.fn() });
  const { elements, window } = await openPlayerPage(config, assert.fail, local,
    { navigator: options.navigatorObject, caches: options.cacheStorage, location });
  const blocked = t.mock.method(window.localStorage, "removeItem", () => { throw new DOMException("Denied", "SecurityError"); });
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
  const { elements } = await openPlayerPage(config, (_url, { signal }) => {
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

test("an unversioned download stores all chunks from one audio response while yielding to playback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
  const saved = await manager.start(selection(total), undefined, { waitForPriority: () => t.mock.timers.tick(60_000) });
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
  const { elements } = await openPlayerPage(config, assert.fail, local,
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
