import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BookConfigStore } from "../js/book-config.js?v=25";
import { inspectAudioRange, downloadChunks } from "../js/offline-transfer.js?v=25";
import { normalizeLibrary } from "../js/config.js?v=25";
import { buildSources, chooseDefaultSource } from "../js/source-selection.js?v=25";
import { deferred, Element, openPlayerPage } from "./player-page.mjs";
import { createCoverView } from "../js/cover.js?v=25";
import { createOfflinePanel } from "../js/offline-panel.js?v=25";
import { loadChapterFile } from "../js/chapters.js?v=25";
import {
  OFFLINE_META_CACHE,
  OfflineManager,
  chunkBounds,
  completedBytes,
  manifestMatchesSelection,
  offlineChunkUrl,
  offlineManifestUrl,
  offlineMetaUrl,
  parseContentRange,
  validManifest,
} from "../js/offline.js?v=25";

const { offlineConfigCacheUrl } = globalThis.CompactPlayerOfflineManifest;

class MemoryCache {
  map = new Map();
  key(input) { return typeof input === "string" ? new URL(input).href : input.url; }
  async match(input) { return this.map.get(this.key(input))?.clone(); }
  async put(input, response) { this.map.set(this.key(input), response.clone()); }
  async delete(input) { return this.map.delete(this.key(input)); }
}

class MemoryCacheStorage {
  map = new Map();
  controlRecords = new Map();
  offlineControl(baseUrl) {
    const prefix = new URL(baseUrl).pathname + "\0";
    return {
      read: async (key, signal) => {
        if (signal?.aborted) throw signal.reason;
        return structuredClone(this.controlRecords.get(prefix + key));
      },
      readMany: async (keys, signal) => {
        if (signal?.aborted) throw signal.reason;
        return keys.map((key) => structuredClone(this.controlRecords.get(prefix + key)));
      },
      write: async (entries, signal) => {
        if (signal?.aborted) throw signal.reason;
        for (const [key, value] of Object.entries(entries)) this.controlRecords.set(prefix + key, structuredClone(value));
      },
    };
  }
  async has(name) { return this.map.has(name); }
  async open(name) {
    if (!this.map.has(name)) this.map.set(name, new MemoryCache());
    return this.map.get(name);
  }
  async keys() { return [...this.map.keys()]; }
  async match(request, { cacheName }) { return this.map.get(cacheName)?.match(request); }
  async delete(name) { return this.map.delete(name); }
}

async function waitForBookCacheRemoval(storage, name) {
  for (let attempt = 0; attempt < 40 && await storage.has(name); attempt++) await settle();
  assert.equal(await storage.has(name), false);
}

async function waitForRecord(read, matches) {
  const deadline = performance.now() + 3000;
  let record;
  do {
    record = await read();
    if (matches(record)) return record;
    await settle();
  } while (performance.now() < deadline);
  return record;
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

function workerController(baseUrl, script = "sw.js", capabilities = { offlineJournal: 2 }) {
  return {
    scriptURL: new URL(script, baseUrl).href,
    postMessage({ type }, [reply]) {
      reply.postMessage({ type, scope: baseUrl, audio: true, ...capabilities });
      reply.close();
    },
  };
}

function nextActiveCache(manager) {
  const { activeCandidatePrefix } = globalThis.CompactPlayerOfflineManifest;
  const storage = manager.cacheStorage;
  const open = storage.open;
  const next = new MemoryCache();
  storage.open = async (name) => {
    if (name.startsWith(activeCandidatePrefix(manager.baseUrl))) {
      storage.map.set(name, next);
      storage.open = open;
    }
    return open.call(storage, name);
  };
  return next;
}

async function useCachedActiveRecord(manager) {
  const control = manager.store.control;
  const pointer = await control.read("active");
  delete pointer.committedRecord;
  await control.write({ active: pointer });
  return pointer.cacheName;
}

async function workerContext(globals = {}, decorateContract) {
  const context = vm.createContext({
    self: { registration: { scope: "https://example.test/" }, addEventListener() {} },
    URL, Request, Response, Headers, ReadableStream, TransformStream, TextDecoder, DOMException,
    setTimeout, clearTimeout, AbortSignal, AbortController, crypto: globalThis.crypto, ...globals,
  });
  const workerUrl = new URL("../sw.js", import.meta.url);
  context.importScripts = (...paths) => {
    for (const path of paths) {
      vm.runInContext(readFileSync(new URL(path, workerUrl), "utf8"), context);
      if (decorateContract && new URL(path, workerUrl).pathname === new URL("./js/offline-manifest.js", workerUrl).pathname) {
        context.CompactPlayerOfflineManifest = decorateContract(context.CompactPlayerOfflineManifest);
      }
    }
  };
  vm.runInContext(await readFile(workerUrl, "utf8"), context);
  return context;
}

test("downloaded metadata carries its book identity through the worker", async () => {
  const scope = "https://example.test/";
  const caches = new MemoryCacheStorage();
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  const worker = await workerContext({ caches, fetch: async () => { throw new TypeError("Offline"); } });
  const manifest = { ...selection(), episodeId: "catalog-a", configBookId: "book-a", schemaVersion: 1,
    status: "ready", downloadId: "one", cacheName: "saved-book", totalSize: 3,
    chunkSize: 3, totalChunks: 1, completed: [0] };
  const url = scope + "shared/chapters.vtt";
  await manager.writeRecord("active", manifest);
  const book = await caches.open(manifest.cacheName);
  await book.put(url, new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nA"));
  await book.put(offlineChunkUrl(scope, manifest.downloadId, 0), new Response(Uint8Array.of(3, 4, 5)));
  const workerFetch = (target, options) => worker.networkFirst(new Request(target, options));
  await assert.rejects(loadChapterFile(url, { cacheVersion: 1, fetchImpl: workerFetch,
    bookIdentity: { episodeId: "catalog-b", configBookId: "book-b" } }), /different book/i);
  assert.equal((await loadChapterFile(url, { cacheVersion: 1, fetchImpl: workerFetch,
    bookIdentity: { episodeId: "catalog-a", configBookId: "book-a" } })).cues[0].title, "A");
  const response = await worker.cachedBookResponse(new Request(manifest.sourceUrl, { headers: { Range: "bytes=0-1" } }));
  assert.equal(response.headers.get("x-compact-player-offline-book"), encodeURIComponent(JSON.stringify(["catalog-a", "book-a"])));
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [3, 4]);

  await manager.writeRecord("active", { ...manifest, configBookId: undefined });
  assert.equal((await loadChapterFile(url, { cacheVersion: 1, fetchImpl: workerFetch,
    bookIdentity: { episodeId: "catalog-a", configBookId: "legacy-book" } })).cues[0].title, "A");
});

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

  const navigator = navigatorStub();
  navigator.onLine = false;
  navigator.serviceWorker.controller = { scriptURL: baseUrl + "sw.js" };
  const legacyWorker = await workerContext({ caches: cacheStorage });
  const controlled = await openPlayerPage(config, assert.fail, new Map([[ "compactAudioPlayer.onboardingShown.v1", "1" ]]), {
    caches: cacheStorage, navigator,
    fetch: async (url, options) => {
      if (options?.method === "HEAD") return legacyWorker.cachedMediaResponse(new Request(url, options), saved, cache);
      return await cache.match(url) || new Response(null, { status: 404 });
    },
  });
  await controlled.ready;
  assert.ok(!controlled.audio.src);
  controlled.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(controlled.audio.src, baseUrl + "__compact_player_offline__/audio.json?download=" + encodeURIComponent(saved.downloadId));
  controlled.audio.dispatchEvent(new Event("loadedmetadata"));
  controlled.document.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { code: "ArrowRight" }));
  assert.equal(controlled.audio.currentTime, 5);
});

test("stalled navigation uses the installed shell or waits for the network until its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = "https://example.test/listen/";
  const worker = await workerContext({ caches: new MemoryCacheStorage(),
    self: { registration: { scope }, addEventListener() {} } });
  const shell = await worker.caches.open(vm.runInContext("SHELL_CACHE", worker));
  const page = new Request(scope + "?book=north");
  Object.defineProperty(page, "mode", { value: "navigate" });
  const module = new Request(scope + "js/config.js");
  for (const [request, key, content] of [[page, scope + "index.html?v=25", "saved page"], [module, module.url, "saved module"]]) {
    const server = deferred();
    let signal;
    worker.fetch = (_request, options) => { signal = options?.signal; return server.promise; };
    await shell.put(key, new Response(content));
    let delivered;
    const result = worker.networkFirst(request).then((response) => { delivered = response; });
    t.mock.timers.tick(2999);
    await settle();
    assert.equal(delivered, undefined);
    t.mock.timers.tick(1);
    await settle();
    assert.ok(delivered, "the cached response should arrive while the server is still silent");
    assert.equal(await delivered.text(), content);
    assert.equal(signal.aborted, true);
    server.resolve(new Response("late response"));
    await result;
    assert.equal(await (await shell.match(key)).text(), content);
    await shell.delete(key);
  }
  const server = deferred();
  worker.fetch = () => server.promise;
  const uncached = worker.networkFirst(page);
  t.mock.timers.tick(6000);
  await settle();
  const html = '<link rel="stylesheet" href="./player.css?v=25"><script type="module" src="./player.js?v=25"></script>';
  server.resolve(new Response(html));
  assert.equal(await (await uncached).text(), html);

  worker.fetch = () => new Promise(() => {});
  const timedOut = assert.rejects(worker.networkFirst(page), { name: "TimeoutError" });
  t.mock.timers.tick(15000);
  await timedOut;

  const disk = deferred();
  const origin = deferred();
  worker.caches.open = () => disk.promise;
  worker.fetch = () => origin.promise;
  const pending = worker.networkFirst(page);
  t.mock.timers.tick(3000);
  await settle();
  origin.resolve(new Response(html));
  assert.equal(await (await pending).text(), html);
  disk.resolve(shell);
});

test("navigation preserves missing-page responses and returns cached content only for its own routes", async () => {
  const scope = "https://example.test/listen/";
  const caches = new MemoryCacheStorage();
  const worker = await workerContext({ caches, self: { registration: { scope }, addEventListener() {} } });
  const shell = await caches.open(vm.runInContext("SHELL_CACHE", worker));
  await shell.put(scope + "index.html?v=25", new Response("player page"));
  await shell.put(scope + "js/config.js", new Response("player module"));
  const manifest = { ...selection(), schemaVersion: 1, status: "ready", downloadId: "one", cacheName: "saved-book",
    totalSize: 10, chunkSize: 10, totalChunks: 1, completed: [0] };
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  await manager.writeRecord("active", manifest);
  const saved = await caches.open(manifest.cacheName);
  await saved.put(scope + "media/book/cover.jpg", new Response("saved cover"));
  const navigate = (path) => {
    const request = new Request(scope + path);
    Object.defineProperties(request, { mode: { value: "navigate" }, destination: { value: "document" } });
    return worker.networkFirst(request);
  };
  const missing = new Response("Page not found", { status: 404 });
  worker.fetch = async () => missing;
  const response = await navigate("missing-document.html");
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Page not found");
  assert.equal(await (await navigate("?book=north")).text(), "player page");
  assert.equal(await (await navigate("index.html?book=south")).text(), "player page");
  assert.equal(await (await navigate("js/config.js")).text(), "player module");
  assert.equal(await (await navigate("media/book/cover.jpg")).text(), "saved cover");
  worker.fetch = async () => { throw new TypeError("Offline"); };
  await assert.rejects(navigate("missing-document.html"), /Offline/);
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
    [{ chunkSize: 8 * 1024 * 1024 }, true],
    [{ chunkSize: Number.MAX_SAFE_INTEGER, totalSize: Number.MAX_SAFE_INTEGER }, false],
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

test("canceling a stalled chunk write keeps the old book and isolates the late write", async (t) => {
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl: rangedFetch(10) };
  const manager = new OfflineManager(options);
  await manager.init();
  const first = selection();
  const previous = await manager.start(first, await manager.inspectSource(first));
  const next = { ...first, episodeId: "next", sourceUrl: "https://example.test/next.webm" };
  const writing = deferred();
  const released = deferred();
  const lateWrite = deferred();
  t.after(released.resolve);
  let blocked = false;
  const put = MemoryCache.prototype.put;
  t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
    if (key.includes("/chunks/") && !blocked) {
      blocked = true;
      writing.resolve();
      await released.promise;
      await put.call(this, key, response);
      lateWrite.resolve();
      return;
    }
    return put.call(this, key, response);
  });

  const download = manager.start(next, await manager.inspectSource(next));
  const aborted = assert.rejects(download, { name: "AbortError" });
  await writing.promise;
  const partialName = manager.staging.cacheName;
  let canceledWhileWriting = false;
  const canceled = manager.cancel().then(() => { canceledWhileWriting = true; });
  await settle();
  assert.equal(canceledWhileWriting, true);
  await canceled;
  await aborted;
  assert.equal(await manager.readRecord("staging"), null);
  const reloaded = new OfflineManager(options);
  await reloaded.init();
  assert.equal(reloaded.active?.downloadId, previous.downloadId);
  assert.equal(reloaded.staging, null);
  assert.ok(!(await cacheStorage.keys()).includes(partialName));
  const chunk = offlineChunkUrl(manager.baseUrl, previous.downloadId, 0);
  const savedChunk = await cacheStorage.match(chunk, { cacheName: previous.cacheName });
  assert.ok(savedChunk);
  assert.equal((await savedChunk.arrayBuffer()).byteLength, 10);
  const replacement = await reloaded.start(next);
  assert.notEqual(replacement.cacheName, partialName);
  released.resolve();
  await lateWrite.promise;
  assert.ok(!(await cacheStorage.keys()).includes(partialName));
  assert.equal((await reloaded.readRecord("active")).downloadId, replacement.downloadId);
});

test("a timed-out chunk write discards only the partial copy and releases the write lock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const writing = deferred();
  const pendingWrite = deferred();
  t.after(pendingWrite.resolve);
  const put = MemoryCache.prototype.put;
  t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
    if (key.includes("/chunks/")) {
      writing.resolve();
      await pendingWrite.promise;
    }
    return put.call(this, key, response);
  });
  const download = manager.start({ ...selection(), episodeId: "replacement" });
  const timedOut = assert.rejects(download, { code: "storage-timeout" });
  await writing.promise;
  const partialName = manager.staging.cacheName;
  t.mock.timers.tick(20_000);
  await timedOut;
  await manager.withLock(() => assert.equal(manager.active.downloadId, saved.downloadId), assert.fail);
  assert.equal(await manager.readRecord("staging"), null);
  assert.ok(!(await options.cacheStorage.keys()).includes(partialName));
});

test("cancel and reset detach stalled manifest and progress writes before the next download", async (t) => {
  for (const action of ["cancel", "reset"]) {
    const { manager, options, saved } = await savedBookFixture();
    const writing = deferred();
    const release = deferred();
    const lateWrite = deferred();
    t.after(release.resolve);
    let interrupted;
    const put = MemoryCache.prototype.put;
    const stall = t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
      if (!interrupted && key === offlineManifestUrl(options.baseUrl)) {
        const manifest = await response.clone().json();
        if (manifest.status === "downloading" && (action === "cancel" || manifest.completed.length)) {
          interrupted = manifest;
          writing.resolve();
          await release.promise;
          await put.call(this, key, response);
          lateWrite.resolve();
          return;
        }
      }
      return put.call(this, key, response);
    });
    const aborted = assert.rejects(manager.start({ ...selection(), episodeId: "interrupted" }), { name: "AbortError" });
    await writing.promise;
    let stopped = false;
    const stopping = manager[action]().then(() => { stopped = true; });
    await settle();
    assert.equal(stopped, true, action);
    await stopping;
    await aborted;
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal((await manager.readRecord("active"))?.downloadId ?? null, action === "cancel" ? saved.downloadId : null);

    const size = 8 * 1024 * 1024 + 4;
    manager.fetchImpl = rangedFetch(size, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(size), episodeId: "next" }), /connection lost/);
    const next = await manager.readRecord("staging");
    assert.deepEqual(next.completed, [0]);
    assert.notEqual(next.downloadId, interrupted.downloadId);
    release.resolve();
    await lateWrite.promise;
    stall.mock.restore();
    await waitForBookCacheRemoval(options.cacheStorage, interrupted.cacheName);
    assert.equal((await manager.readRecord("staging")).downloadId, next.downloadId);
    const reopened = new OfflineManager(options);
    await reopened.init();
    assert.equal(reopened.staging?.downloadId, next.downloadId);
  }
});

test("reset clears the active record even when the Cache Storage lookup misses it", async (t) => {
  const { manager, options, saved } = await savedBookFixture();
  const key = offlineMetaUrl(options.baseUrl, "active");
  const meta = await manager.metaCache();
  await meta.put(key, Response.json({ cacheName: saved.cacheName, manifest: saved }));
  assert.equal((await (await meta.match(key)).json()).manifest.downloadId, saved.downloadId);
  const match = options.cacheStorage.match.bind(options.cacheStorage);
  const stale = t.mock.method(options.cacheStorage, "match", (url, query) => url === key ? undefined : match(url, query));
  await manager.reset();
  stale.mock.restore();
  assert.equal(await meta.match(key), undefined);

  const replacement = await manager.start({ ...selection(), episodeId: "next" });
  assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
});

test("a stalled publication cannot replace the active book after a timeout or reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["deadline", "reset"]) {
    const { manager, options, saved } = await savedBookFixture();
    const writing = deferred();
    const release = deferred();
    const lateWrite = deferred();
    t.after(release.resolve);
    const put = MemoryCache.prototype.put;
    let held;
    const stall = t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
      const file = action === "deadline" ? "active.json" : "manifest.json";
      if (!held && key.endsWith("/" + file)) {
        const value = await response.clone().json();
        const manifest = value.manifest ?? value;
        if (manifest.status === "ready" && manifest.episodeId === "interrupted") {
          held = manifest;
          writing.resolve();
          await release.promise;
          await put.call(this, key, response);
          lateWrite.resolve();
          return;
        }
      }
      return put.call(this, key, response);
    });
    const transfer = manager.start({ ...selection(), episodeId: "interrupted" });
    const interrupted = assert.rejects(transfer, action === "deadline" ? { code: "storage-timeout" } : { name: "AbortError" });
    await writing.promise;
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    if (action === "deadline") t.mock.timers.tick(20_000);
    else await manager.reset();
    await interrupted;
    assert.equal((await manager.readRecord("active"))?.downloadId ?? null, action === "deadline" ? saved.downloadId : null);

    const newer = await manager.start({ ...selection(), episodeId: "newer" });
    release.resolve();
    await lateWrite.promise;
    stall.mock.restore();
    await manager.refresh();
    const worker = await workerContext({ caches: options.cacheStorage });
    assert.equal((await worker.activeManifest()).downloadId, newer.downloadId);
    assert.equal(manager.active.downloadId, newer.downloadId);
    assert.ok(!(await options.cacheStorage.keys()).includes(held.cacheName));
  }
});

test("active publication rollback leaves a pending Cache deletion outside the writer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage, baseUrl } = options;
  const prefix = globalThis.CompactPlayerOfflineManifest.activeCandidatePrefix(baseUrl);
  const entered = deferred(), releasePut = deferred(), latePut = deferred();
  const deleting = deferred(), releaseDelete = deferred(), lateDelete = deferred();
  let candidateName;
  const open = cacheStorage.open.bind(cacheStorage);
  const remove = cacheStorage.delete.bind(cacheStorage);
  t.mock.method(cacheStorage, "open", async (name) => {
    const cache = await open(name);
    if (!candidateName && name.startsWith(prefix)) {
      candidateName = name;
      const put = cache.put.bind(cache);
      cache.put = async (url, response) => {
        entered.resolve();
        await releasePut.promise;
        await put(url, response);
        latePut.resolve();
      };
    }
    return cache;
  });
  t.mock.method(cacheStorage, "delete", async (name) => {
    if (name === candidateName) {
      deleting.resolve();
      await releaseDelete.promise;
      const result = await remove(name);
      lateDelete.resolve();
      return result;
    }
    return remove(name);
  });
  t.after(releasePut.resolve);
  t.after(releaseDelete.resolve);

  let expired = false;
  const pending = assert.rejects(manager.start({ ...selection(), episodeId: "interrupted" }),
    { code: "storage-timeout" }).then(() => { expired = true; });
  await entered.promise;
  t.mock.timers.tick(20_000);
  await deleting.promise;
  await settle();
  assert.equal(expired, true);
  assert.equal(heldLocks.size, 0);
  const worker = await workerContext({ caches: cacheStorage });
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);

  const other = new OfflineManager(options);
  await other.init();
  await other.reset();
  assert.equal(await worker.activeManifest(), null);
  const next = await other.start({ ...selection(), episodeId: "new" });
  const published = await other.store.readActiveState();
  assert.notEqual(published.journalCacheName, candidateName);
  releasePut.resolve();
  await latePut.promise;
  assert.equal((await worker.activeManifest()).downloadId, next.downloadId);

  releaseDelete.resolve();
  await lateDelete.promise;
  await pending;
  assert.equal(await cacheStorage.has(candidateName), false);
  assert.equal(await cacheStorage.has(published.journalCacheName), true);
  assert.equal((await new OfflineManager(options).init()).active.downloadId, next.downloadId);
});

test("the offline control transaction distinguishes an abort from an already committed publication", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { offlineControl } = globalThis.CompactPlayerOfflineManifest;
  const published = new Map();
  let transaction;
  const began = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
    else delete globalThis.indexedDB;
  });
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
    open() {
      const request = {};
      request.result = { close() {}, transaction() {
        const writes = new Map();
        let committed = false;
        transaction = {
          objectStore: () => ({ put(value, key) { writes.set(key.join("/"), value); } }),
          abort() {
            if (committed) throw new DOMException("Already committed", "InvalidStateError");
            queueMicrotask(() => this.onabort());
          },
          commitBeforeNotification() {
            committed = true;
            for (const [key, value] of writes) published.set(key, value);
          },
        };
        began.shift()?.();
        return transaction;
      } };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  } });
  const control = offlineControl("https://example.test/books/");
  const initial = deferred();
  began.push(initial.resolve);
  const aborted = assert.rejects(control.write({ active: { revision: 1 }, staging: null }), { name: "TimeoutError" });
  await initial.promise;
  await settle();
  t.mock.timers.tick(3000);
  await aborted;
  assert.equal(published.size, 0);

  const writing = deferred();
  began.push(writing.resolve);
  const next = control.write({ active: { revision: 2 }, staging: null });
  await writing.promise;
  await settle();
  transaction.commitBeforeNotification();
  t.mock.timers.tick(3000);
  transaction.oncomplete();
  await next;
  assert.deepEqual([...published.values()], [{ revision: 2 }, null]);
});

test("inventory removes abandoned publication caches outside the lock and preserves referenced caches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options } = await savedBookFixture();
  const { baseUrl, cacheStorage: caches } = options;
  const current = await manager.start({ ...selection(), episodeId: "current" });
  const state = await manager.store.readActiveState();
  assert.ok(state.journalCacheName && state.previousJournalCacheName);
  const { activeCandidatePrefix } = globalThis.CompactPlayerOfflineManifest;
  const [abandoned, nextAbandoned] = ["abandoned", "next-abandoned"].map((name) => activeCandidatePrefix(baseUrl) + name);
  const foreign = activeCandidatePrefix(new URL("other/", baseUrl)) + "abandoned";
  for (const name of [abandoned, nextAbandoned, foreign]) await caches.open(name);

  const release = deferred();
  const deleted = deferred();
  const remove = caches.delete.bind(caches);
  let deleting = false;
  const deletion = t.mock.method(caches, "delete", async (name) => {
    if (name !== abandoned) return remove(name);
    deleting = true;
    await release.promise;
    const result = await remove(name);
    deleted.resolve();
    return result;
  });
  try {
    await manager.refresh();
    assert.equal(deleting, true);
    assert.equal(heldLocks.size, 0);
    assert.equal(manager.active.downloadId, current.downloadId);
    for (const name of [state.journalCacheName, state.previousJournalCacheName, foreign]) assert.ok(await caches.has(name));
    const second = new OfflineManager(options);
    await second.syncPublishedDownload();
    const replacement = await second.start({ ...selection(), episodeId: "next-tab" });
    const replacementState = await second.store.readActiveState();
    t.mock.timers.tick(3000);
    release.resolve();
    await deleted.promise;
    await settle();
    assert.ok(await caches.has(nextAbandoned));
    await second.refresh();
    await waitForBookCacheRemoval(caches, nextAbandoned);
    assert.ok(await caches.has(replacementState.journalCacheName));
    assert.ok(await caches.has(foreign));
    assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
  } finally {
    release.resolve();
    deletion.mock.restore();
  }
});

test("losing a published journal cache preserves the selected book and its saved audio", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage, baseUrl } = options;
  const { journalCacheName } = await manager.store.readActiveState();
  await cacheStorage.delete(journalCacheName);

  const worker = await workerContext({ caches: cacheStorage });
  assert.equal((await worker.activeManifest())?.downloadId, saved.downloadId);
  const reopened = new OfflineManager(options);
  assert.equal((await reopened.init()).active?.downloadId, saved.downloadId);
  assert.ok(await cacheStorage.match(offlineChunkUrl(baseUrl, saved.downloadId, 0), { cacheName: saved.cacheName }));
  await reopened.removeActive();
  assert.equal(await worker.activeManifest(), null);
});

test("saved audio uses the committed record before consulting the metadata cache", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  const { baseUrl, cacheStorage } = options;
  const { journalCacheName } = await manager.store.readActiveState();
  const stalled = deferred();
  const match = cacheStorage.match.bind(cacheStorage);
  let metadataReads = 0;
  t.mock.method(cacheStorage, "match", (url, args) => {
    if (args.cacheName === journalCacheName) {
      metadataReads++;
      return stalled.promise;
    }
    return match(url, args);
  });
  const worker = await workerContext({ caches: cacheStorage, console });
  const url = new URL(offlineMetaUrl(baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  const request = new Request(url, { headers: { Range: "bytes=0-2" } });
  const response = worker.savedAudioResponse(request, url, () => {});
  try {
    await settle();
    t.mock.timers.tick(1500);
    const media = await response;
    assert.equal(media.status, 206);
    assert.equal((await media.arrayBuffer()).byteLength, 3);
    assert.equal(metadataReads, 0);
  } finally { stalled.resolve(); }
});

test("active metadata uses the legacy slots only before a new journal publication", async () => {
  const { options, saved } = await savedBookFixture();
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({ ...options, cacheStorage });
  const { activeCacheName } = globalThis.CompactPlayerOfflineManifest;
  const legacy = await cacheStorage.open(activeCacheName(options.baseUrl, 0));
  const url = offlineMetaUrl(options.baseUrl, "active");
  await legacy.put(url, Response.json({ revision: 1, resetId: "", cacheName: saved.cacheName, manifest: saved }));
  const worker = await workerContext({ caches: cacheStorage });
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);

  const control = cacheStorage.offlineControl;
  cacheStorage.offlineControl = () => ({
    read: async () => { throw new DOMException("Control storage denied", "SecurityError"); },
    write: assert.fail,
  });
  await assert.rejects(manager.writeRecord("active", null), { name: "SecurityError" });
  assert.deepEqual(await cacheStorage.keys(), [activeCacheName(options.baseUrl, 0)]);
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);
  cacheStorage.offlineControl = control;

  await manager.writeRecord("active", null);
  const { journalCacheName } = await manager.store.readActiveState();
  await cacheStorage.delete(journalCacheName);
  assert.ok(await legacy.match(url));
  assert.equal(await manager.readRecord("active"), null);
  assert.equal(await worker.activeManifest(), null);
});

test("an oversized optional asset is discarded without blocking the audio download", async () => {
  const { manager, selected, options } = await savedBookFixture();
  const coverUrl = new URL("cover.jpg", options.baseUrl).href;
  const chunks = [new Uint8Array(16 * 1024 ** 2), Uint8Array.of(1)];
  let canceled = false;
  manager.fetchImpl = (url, request) => {
    if (url !== coverUrl) return options.fetchImpl(url, request);
    return new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift());
      },
      cancel() { canceled = true; },
    }));
  };

  const saved = await manager.start({ ...selected, assets: [...selected.assets, { url: coverUrl }] });
  assert.equal(manager.snapshot().active.downloadId, saved.downloadId);
  const cache = await options.cacheStorage.open(saved.cacheName);
  assert.equal(await cache.match(coverUrl), undefined);
  assert.equal(canceled, true);
});

test("optional assets leave room for the audio and its storage reserve", async () => {
  const { manager, selected, options } = await savedBookFixture();
  const coverUrl = new URL("cover.jpg", options.baseUrl).href;
  const chaptersUrl = new URL("chapters.vtt", options.baseUrl).href;
  options.navigatorObject.storage.estimate = async () => ({ quota: 16 * 1024 ** 2 + 10 + 4, usage: 0 });
  const responses = new Map([[coverUrl, new Response("cover")], [chaptersUrl, new Response("cue")]]);
  manager.fetchImpl = (url, request) => responses.get(url) || options.fetchImpl(url, request);

  const saved = await manager.start({ ...selected, assets: [...selected.assets, { url: coverUrl }, { url: chaptersUrl }] });
  const cache = await options.cacheStorage.open(saved.cacheName);
  assert.equal(await cache.match(coverUrl), undefined);
  assert.equal(await (await cache.match(chaptersUrl)).text(), "cue");
  assert.equal(manager.snapshot().active.downloadId, saved.downloadId);
});

test("an HTML success page cannot overwrite an optional cover when resuming a download", async () => {
  const total = 8 * 1024 ** 2 + 4;
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub() };
  const coverUrl = new URL("cover.jpg", options.baseUrl).href;
  const initial = rangedFetch(total, { failSecondChunk: true });
  const manager = new OfflineManager({ ...options, fetchImpl: (url, request) => url === coverUrl
    ? new Response("existing cover", { headers: { "content-type": "image/jpeg" } }) : initial(url, request) });
  await manager.init();
  await assert.rejects(manager.start({ ...selection(total), assets: [{ url: coverUrl }] }), /connection lost/);
  const draft = manager.staging;

  const resumed = rangedFetch(total);
  manager.fetchImpl = (url, request) => url === coverUrl
    ? new Response("<html>Unavailable</html>", { headers: { "content-type": "text/html; charset=utf-8" } }) : resumed(url, request);
  const saved = await manager.resume();
  assert.equal(saved.downloadId, draft.downloadId);
  const cover = await cacheStorage.match(coverUrl, { cacheName: saved.cacheName });
  assert.equal(await cover.text(), "existing cover");
});

test("optional files cannot overwrite offline download records in Cache Storage", async () => {
  const baseUrl = "https://example.test/";
  const storage = new MemoryCacheStorage();
  const manifestUrl = offlineManifestUrl(baseUrl);
  const range = rangedFetch(10);
  const manager = new OfflineManager({ baseUrl, cacheStorage: storage, navigatorObject: navigatorStub(),
    fetchImpl(url, request) {
      if (url === manifestUrl) return new Response("optional asset", { headers: { "content-type": "image/jpeg" } });
      if (request.headers.Range !== "bytes=0-0") throw new TypeError("Audio interrupted");
      return range(url, request);
    },
  });
  await manager.init();
  await assert.rejects(manager.start({ ...selection(), assets: [{ url: manifestUrl }] }), /Audio interrupted/);
  const staging = await manager.readRecord("staging");
  assert.equal(staging?.downloadId, manager.staging.downloadId);
  assert.deepEqual(staging.completed, []);
  const local = await storage.match(manifestUrl, { cacheName: staging.cacheName });
  assert.equal((await local.json()).status, "downloading");
});

test("an offline playback stall pauses a download without discarding its completed chunk", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const baseUrl = "https://example.test/";
  const caches = new MemoryCacheStorage();
  const navigator = navigatorStub();
  const config = { id: "book", defaultLanguage: "en", languages: { en: { sources: { opus: { 64: "audio.webm" } } } } };
  const download = rangedFetch(8 * 1024 ** 2 + 4);
  const ranges = [];
  let page;
  page = await openPlayerPage(config, (url, request) => {
    if (request.headers?.["x-compact-player-download"] !== "1") return new Response(null, { status: 200 });
    ranges.push(request.headers.Range);
    if (request.headers.Range === "bytes=0-8388607") {
      page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
      navigator.onLine = false;
      page.window.dispatchEvent(new Event("offline"));
    }
    return download(url, request);
  }, new Map(), { navigator, caches, confirm: () => true });
  await page.ready;
  page.elements.get("optionsBtn").dispatchEvent(new Event("click"));
  page.elements.get("offlineDownloadBtn").dispatchEvent(new Event("click"));
  const control = caches.offlineControl(baseUrl);
  const staging = await waitForRecord(async () => (await control.read("staging"))?.manifest, (record) => record?.completed.length);
  assert.deepEqual(staging?.completed, [0]);
  t.mock.timers.tick(500);
  await settle();
  assert.match(page.elements.get("offlineStatus").textContent, /Download paused/);
  assert.deepEqual(ranges, ["bytes=0-0", "bytes=0-8388607"]);

  navigator.onLine = true;
  page.window.dispatchEvent(new Event("online"));
  page.audio.dispatchEvent(new Event("playing"));
  await settle();
  page.elements.get("offlineDownloadBtn").dispatchEvent(new Event("click"));
  const active = await waitForRecord(async () => (await control.read("active"))?.committedRecord?.manifest,
    (record) => record?.status === "ready");
  assert.equal(active?.downloadId, staging.downloadId);
  assert.deepEqual(ranges, ["bytes=0-0", "bytes=0-8388607", "bytes=0-0", "bytes=8388608-8388611"]);
});

test("a malformed optional asset in a paused record does not prevent resuming the audio", async () => {
  const total = 8 * 1024 ** 2 + 4;
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub() };
  const writer = new OfflineManager({ ...options, fetchImpl: rangedFetch(total, { failSecondChunk: true }) });
  await writer.init();
  await assert.rejects(writer.start(selection(total)), /connection lost/);
  const staged = { ...writer.staging, assets: [{ url: "not a URL", required: false }] };
  await (await cacheStorage.open(staged.cacheName)).put(offlineManifestUrl(options.baseUrl), Response.json(staged));
  await writer.writeRecord("staging", staged);

  const requested = [];
  const fetch = rangedFetch(total);
  const reader = new OfflineManager({ ...options, fetchImpl: (url, request) => {
    assert.equal(url, staged.sourceUrl);
    requested.push(request.headers.Range);
    return fetch(url, request);
  } });
  await reader.init();
  assert.equal((await reader.resume()).downloadId, staged.downloadId);
  assert.deepEqual(requested, ["bytes=0-0", "bytes=8388608-8388611"]);
});

test("a stalled optional asset can time out or be abandoned without holding the audio download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["deadline", "cancel", "reset"]) {
    const { manager, options, saved } = await savedBookFixture();
    const coverUrl = new URL("cover.jpg", options.baseUrl).href;
    const reachedWrite = deferred();
    const releaseWrite = deferred();
    const lateWrite = deferred();
    t.after(releaseWrite.resolve);
    let audioRequests = 0;
    let held = false;
    const put = MemoryCache.prototype.put;
    const stub = t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
      if (!held && key === coverUrl) {
        held = true;
        reachedWrite.resolve();
        await releaseWrite.promise;
        await put.call(this, key, response);
        lateWrite.resolve();
        return;
      }
      return put.call(this, key, response);
    });
    manager.fetchImpl = (url, request) => {
      if (url === coverUrl) return new Response("cover");
      if (request.headers?.Range !== "bytes=0-0") audioRequests += 1;
      return options.fetchImpl(url, request);
    };
    const transfer = manager.start({ ...selection(), episodeId: "offline", assets: [{ url: coverUrl }] });
    await reachedWrite.promise;
    const oldStage = manager.staging;
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.equal(audioRequests, 0);
    let complete;
    if (action === "deadline") {
      t.mock.timers.tick(3000);
      await settle();
      assert.equal(audioRequests, 1, "audio starts while the cover write is still pending");
      complete = await transfer;
      assert.equal(complete.downloadId, oldStage.downloadId);
    } else {
      const aborted = assert.rejects(transfer, { name: "AbortError" });
      let stopped = false;
      const stop = manager[action]().then(() => { stopped = true; });
      await settle();
      assert.equal(stopped, true, action);
      await stop;
      await aborted;
      assert.equal((await manager.readRecord("active"))?.downloadId ?? null, action === "cancel" ? saved.downloadId : null);
      complete = await manager.start({ ...selection(), episodeId: "replacement" });
      assert.notEqual(complete.downloadId, oldStage.downloadId);
    }
    assert.equal(await options.cacheStorage.match(coverUrl, { cacheName: complete.cacheName }), undefined);
    releaseWrite.resolve();
    await lateWrite.promise;
    assert.equal((await manager.readRecord("active")).downloadId, complete.downloadId);
    if (action === "deadline") {
      assert.equal(await (await options.cacheStorage.match(coverUrl, { cacheName: complete.cacheName })).text(), "cover");
    } else {
      assert.equal(await options.cacheStorage.match(coverUrl, { cacheName: complete.cacheName }), undefined);
      assert.equal(await options.cacheStorage.has(oldStage.cacheName), false);
    }
    stub.mock.restore();
  }
});

test("a required book configuration arriving after Cancel is discarded before being read or cached", async () => {
  const { manager, options, saved, selected, config, configUrl } = await savedBookFixture();
  const requested = deferred();
  const pending = deferred();
  manager.fetchImpl = (url, request) => {
    if (url !== configUrl) return options.fetchImpl(url, request);
    requested.resolve(request.signal);
    return pending.promise;
  };
  const canceled = assert.rejects(manager.start(selected), { name: "AbortError" });
  const signal = await requested.promise;
  const draft = manager.staging;
  await manager.cancel();
  await canceled;
  assert.equal(signal.aborted, true);
  let reads = 0;
  let closed = false;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(config)));
      controller.close();
    },
    cancel() { closed = true; },
  }, { highWaterMark: 0 });
  try {
    pending.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
    await settle();
    assert.equal(closed, true);
    assert.equal(reads, 0);
    assert.equal(await options.cacheStorage.has(draft.cacheName), false);
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal(manager.active.downloadId, saved.downloadId);
  } finally {
    if (!closed) await body.cancel();
  }
});

test("a cached book configuration arriving after Cancel is closed before its body is read", async (t) => {
  const { manager, options, saved, selected, config, configUrl } = await savedBookFixture();
  const cacheStorage = options.cacheStorage;
  const requested = deferred();
  const pending = deferred();
  const match = cacheStorage.match.bind(cacheStorage);
  t.mock.method(cacheStorage, "match", (url, opts) => {
    if (url === configUrl && opts.cacheName === manager.staging?.cacheName) {
      requested.resolve(opts.cacheName);
      return pending.promise;
    }
    return match(url, opts);
  });

  const canceled = assert.rejects(manager.start(selected), { name: "AbortError" });
  const draftCache = await requested.promise;
  await manager.cancel();
  await canceled;
  let reads = 0;
  let closed = false;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(config)));
      controller.close();
    },
    cancel() { closed = true; },
  }, { highWaterMark: 0 });
  try {
    pending.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
    await settle();
    assert.equal(closed, true);
    assert.equal(reads, 0);
    assert.equal(await cacheStorage.has(draftCache), false);
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal(manager.active.downloadId, saved.downloadId);
  } finally {
    if (!closed) await body.cancel();
  }
});

test("a download manifest arriving after Cancel is closed before inspection reads it", async (t) => {
  const { manager, options, saved, selected } = await savedBookFixture();
  const { baseUrl, cacheStorage } = options;
  const requested = deferred();
  const pending = deferred();
  const match = cacheStorage.match.bind(cacheStorage);
  let draft;
  t.mock.method(cacheStorage, "match", (url, query) => {
    const staging = manager.staging;
    if (!draft && staging?.completed.length && url === offlineManifestUrl(baseUrl) && query.cacheName === staging.cacheName) {
      draft = staging;
      requested.resolve();
      return pending.promise;
    }
    return match(url, query);
  });

  const canceled = assert.rejects(manager.start(selected), { name: "AbortError" });
  await requested.promise;
  await manager.cancel();
  await canceled;
  let reads = 0;
  let closed = false;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(draft)));
      controller.close();
    },
    cancel() { closed = true; },
  }, { highWaterMark: 0 });
  try {
    pending.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
    await settle();
    assert.equal(closed, true);
    assert.equal(reads, 0);
    assert.equal(await cacheStorage.has(draft.cacheName), false);
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal(manager.active.downloadId, saved.downloadId);
  } finally {
    if (!closed) await body.cancel();
  }
});

test("a stalled required configuration write releases the download without changing its replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["cancel", "reset", "deadline"]) {
    const { manager, options, saved } = await savedBookFixture();
    const configUrl = new URL("media/next/book.json", options.baseUrl).href;
    const selected = { ...selection(), episodeId: "next", configBookId: "next",
      sourceUrl: new URL("audio.webm", configUrl).href, assets: [{ url: configUrl, required: true }] };
    const writing = deferred();
    const releaseWrite = deferred();
    const lateWrite = deferred();
    t.after(releaseWrite.resolve);
    let title = "Interrupted copy";
    let held = false;
    const put = MemoryCache.prototype.put;
    const stub = t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
      if (!held && key === configUrl) {
        held = true;
        writing.resolve();
        await releaseWrite.promise;
        await put.call(this, key, response);
        lateWrite.resolve();
        return;
      }
      return put.call(this, key, response);
    });
    manager.fetchImpl = (url, request) => url === configUrl
      ? Response.json({ id: "next", title, defaultLanguage: "en",
        languages: { en: { sources: { opus: { 64: "audio.webm" } } } } })
      : options.fetchImpl(url, request);

    const transfer = manager.start(selected);
    const failed = assert.rejects(transfer, action === "deadline" ? { code: "storage-timeout" } : { name: "AbortError" });
    await writing.promise;
    const interrupted = manager.staging;
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    let released = false;
    const stopped = (action === "deadline" ? failed : manager[action]()).then(() => { released = true; });
    if (action === "deadline") t.mock.timers.tick(20_000);
    await settle();
    assert.equal(released, true, action);
    await stopped;
    await failed;
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal((await manager.readRecord("active"))?.downloadId ?? null, action === "reset" ? null : saved.downloadId);

    title = "Replacement";
    const replacement = await manager.start(selected);
    releaseWrite.resolve();
    await lateWrite.promise;
    stub.mock.restore();
    assert.equal(await options.cacheStorage.has(interrupted.cacheName), false);
    const config = await options.cacheStorage.match(configUrl, { cacheName: replacement.cacheName });
    assert.equal((await config.json()).title, "Replacement");
    assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
  }
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
  const meta = await nextActiveCache(writer);
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
  delete legacy.checksummedChunks;
  const partial = await cacheStorage.open(legacy.cacheName);
  await partial.put(offlineManifestUrl(first.baseUrl), Response.json(legacy));
  const chunk = offlineChunkUrl(first.baseUrl, legacy.downloadId, 0);
  await partial.put(chunk, new Response(new Uint8Array(10)));
  cacheStorage.controlRecords.delete(new URL(first.baseUrl).pathname + "\0staging");
  await (await first.metaCache()).put(offlineMetaUrl(first.baseUrl, "staging"),
    Response.json({ schemaVersion: legacy.schemaVersion, cacheName: legacy.cacheName, manifest: legacy }));
  assert.equal((await first.readRecord("staging")).downloadId, legacy.downloadId);
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
  await waitForBookCacheRemoval(cacheStorage, manifest.cacheName);
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

test("a stalled cache open releases the download lock on timeout and Cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const total = 8 * 1024 ** 2 + 4;
  for (const mode of ["start", "resume"]) {
    for (const action of ["timeout", "cancel"]) {
      const { manager, options, saved } = await savedBookFixture();
      const selectionForDownload = { ...selection(total), episodeId: "other" };
      if (mode === "resume") {
        manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
        await assert.rejects(manager.start(selectionForDownload), /connection lost/);
        assert.deepEqual(manager.staging.completed, [0]);
      }
      const staged = manager.staging;
      manager.fetchImpl = rangedFetch(total);
      const caches = options.cacheStorage;
      const open = caches.open.bind(caches);
      const entered = deferred();
      const release = deferred();
      const opened = deferred();
      let cacheName;
      let lateWrites = 0;
      const mock = t.mock.method(caches, "open", async (name) => {
        if (cacheName || !name.startsWith(manager.store.bookCachePrefix)) return open(name);
        cacheName = name;
        entered.resolve();
        await release.promise;
        const cache = await open(name);
        opened.resolve();
        return { put(...args) { lateWrites++; return cache.put(...args); } };
      });
      let error;
      const run = (staged ? manager.resume() : manager.start(selectionForDownload)).catch((failure) => { error = failure; });
      let canceling;
      try {
        await entered.promise;
        if (action === "cancel") canceling = manager.cancel();
        else t.mock.timers.tick(3000);
        await settle();
        assert.equal(heldLocks.size, 0, `${mode} ${action}`);
        assert.equal(action === "cancel" ? error?.name : error?.code,
          action === "cancel" ? "AbortError" : "storage-read-timeout");
        assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
        const other = new OfflineManager({ ...options, fetchImpl: rangedFetch(total) });
        await other.init();
        if (staged && action === "timeout") {
          assert.equal(other.staging?.downloadId, staged.downloadId);
          assert.equal((await other.resume()).downloadId, staged.downloadId);
        } else {
          assert.equal(other.staging, null);
          await other.reset();
          assert.equal(await other.readRecord("active"), null);
        }
        release.resolve();
        await opened.promise;
        await settle();
        assert.equal(lateWrites, 0);
        if (!staged) assert.equal(await caches.has(cacheName), false);
      } finally {
        release.resolve();
        await run;
        await canceling;
        mock.mock.restore();
      }
    }
  }
});

test("an unprepared replacement preserves the previously paused download when there is room for both", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const total = 8 * 1024 ** 2 + 4;
  for (const failure of ["open timeout", "open cancel", "manifest quota", "record quota"]) {
    const { manager, options, saved } = await savedBookFixture();
    const { cacheStorage: caches, baseUrl } = options;
    manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(total), episodeId: "paused" }), /connection lost/);
    const previous = manager.staging;
    const entered = deferred();
    const release = deferred();
    const open = caches.open.bind(caches);
    let replacementCacheName;
    const cacheOpen = t.mock.method(caches, "open", async (name) => {
      if (name === previous.cacheName || !name.startsWith(manager.store.bookCachePrefix)) return open(name);
      replacementCacheName = name;
      if (failure.startsWith("open")) {
        entered.resolve();
        await release.promise;
      }
      const cache = await open(name);
      return failure === "manifest quota"
        ? { put() { throw new DOMException("Full", "QuotaExceededError"); } } : cache;
    });
    const control = caches.offlineControl.bind(caches);
    const journal = t.mock.method(caches, "offlineControl", (url) => {
      const store = control(url);
      return { ...store, async write(entries, signal) {
        if (failure === "record quota" && entries.staging?.manifest.episodeId === "replacement") {
          throw new DOMException("Full", "QuotaExceededError");
        }
        return store.write(entries, signal);
      } };
    });
    manager.fetchImpl = rangedFetch(total);
    const expected = failure === "open cancel" ? { name: "AbortError" }
      : { code: failure === "open timeout" ? "storage-read-timeout" : "quota" };
    const replaced = assert.rejects(manager.start({ ...selection(total), episodeId: "replacement" }), expected);
    let canceled;
    try {
      if (failure.startsWith("open")) {
        await entered.promise;
        if (failure === "open cancel") canceled = manager.cancel();
        else t.mock.timers.tick(3000);
      }
      await replaced;
      await canceled;
      assert.equal(manager.snapshot().phase, "paused", failure);
      assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
      assert.equal((await manager.readRecord("staging"))?.downloadId, previous.downloadId, failure);
      assert.ok(await caches.match(offlineChunkUrl(baseUrl, previous.downloadId, 0), { cacheName: previous.cacheName }));
      release.resolve();
      await settle();
      await waitForBookCacheRemoval(caches, replacementCacheName);
      cacheOpen.mock.restore();
      const other = new OfflineManager({ ...options, fetchImpl: rangedFetch(total) });
      await other.init();
      assert.equal((await other.resume()).downloadId, previous.downloadId);
    } finally {
      release.resolve();
      await replaced;
      await canceled;
      cacheOpen.mock.restore();
      journal.mock.restore();
    }
  }
});

test("a replacement validates its required configuration before switching away from the paused download", async () => {
  const total = 8 * 1024 ** 2 + 4;
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage: caches, baseUrl } = options;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "paused" }), /connection lost/);
  const previous = manager.staging;
  const configUrl = new URL("media/replacement/book.json", baseUrl).href;
  const selected = { ...selection(total), episodeId: "replacement", configBookId: "replacement",
    sourceUrl: new URL("audio.webm", configUrl).href, assets: [{ url: configUrl, required: true }] };
  const range = rangedFetch(total);
  let configId = "unrelated";
  let audioRequests = 0;
  const configChecks = [];
  manager.fetchImpl = async (url, request) => {
    if (url === configUrl) {
      configChecks.push((await manager.readRecord("staging"))?.downloadId);
      return Response.json({ id: configId, defaultLanguage: "en",
        languages: { en: { sources: { opus: { 64: "audio.webm" } } } } });
    }
    if (request.headers.Range !== "bytes=0-0") audioRequests++;
    return range(url, request);
  };

  await assert.rejects(manager.start(selected), { code: "config" });
  assert.equal(audioRequests, 0);
  assert.equal(manager.snapshot().phase, "paused");
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal((await manager.readRecord("staging")).downloadId, previous.downloadId);
  assert.ok(await caches.match(offlineChunkUrl(baseUrl, previous.downloadId, 0), { cacheName: previous.cacheName }));

  configId = "replacement";
  const replacement = await manager.start(selected);
  assert.deepEqual(configChecks, [previous.downloadId, previous.downloadId]);
  assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
  assert.equal((await (await caches.match(configUrl, { cacheName: replacement.cacheName })).json()).id, "replacement");
  await waitForBookCacheRemoval(caches, previous.cacheName);
});

test("a low-space replacement validates its configuration before reclaiming a paused download", async () => {
  const mib = 1024 ** 2;
  const total = 8 * mib + 4;
  const { manager, options, saved } = await savedBookFixture();
  const { baseUrl, cacheStorage: caches } = options;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "paused" }), /connection lost/);
  const previous = manager.staging;
  options.navigatorObject.storage.estimate = async () => ({ quota: 100 * mib, usage: 80 * mib });
  const configUrl = new URL("media/replacement/book.json", baseUrl).href;
  const selected = { ...selection(total), episodeId: "replacement", configBookId: "replacement",
    sourceUrl: new URL("audio.webm", configUrl).href, assets: [{ url: configUrl, required: true }] };
  let configId = "another-book";
  let configRequests = 0;
  let audioRequests = 0;
  const range = rangedFetch(total);
  manager.fetchImpl = async (url, request) => {
    if (url === configUrl) {
      configRequests++;
      return Response.json({ id: configId, defaultLanguage: "en",
        languages: { en: { sources: { opus: { 64: "audio.webm" } } } } });
    }
    if (request.headers.Range !== "bytes=0-0") {
      audioRequests++;
      assert.equal(await caches.has(previous.cacheName), false, "space was reclaimed before transferring audio");
    }
    return range(url, request);
  };

  await assert.rejects(manager.start(selected), { code: "config" });
  assert.equal(audioRequests, 0);
  assert.equal(manager.snapshot().staging.downloadId, previous.downloadId);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.ok(await caches.match(offlineChunkUrl(baseUrl, previous.downloadId, 0), { cacheName: previous.cacheName }));

  configId = "replacement";
  const newBook = await manager.start(selected);
  assert.equal(configRequests, 2, "the validated configuration was reused after reclaiming space");
  assert.equal(newBook.episodeId, "replacement");
  assert.equal(await caches.has(previous.cacheName), false);
  assert.equal((await (await caches.match(configUrl, { cacheName: newBook.cacheName })).json()).id, "replacement");
});

test("required configurations stop reading at the byte limit over the network and in the cache", async (t) => {
  const { manager, options, saved, configUrl, config, selected } = await savedBookFixture();
  const limit = 1024 ** 2;
  const text = JSON.stringify({ ...config, title: { en: "Blåbær" } });
  const bytes = new TextEncoder().encode(text);
  const boundary = new Uint8Array(limit).fill(32);
  boundary.set(bytes);
  const reads = [];
  const canceled = [];
  const oversized = (source) => new Response(new ReadableStream({
    pull(controller) {
      reads.push(source);
      const count = reads.filter((item) => item === source).length;
      if (count === 1) controller.enqueue(boundary);
      else if (count === 2) controller.enqueue(Uint8Array.of(32));
      else controller.close();
    },
    cancel() { canceled.push(source); },
  }, { highWaterMark: 0 }));

  manager.fetchImpl = (url, request) => url === configUrl ? oversized("network") : options.fetchImpl(url, request);
  await assert.rejects(manager.start({ ...selected, episodeId: "new", configBookId: config.id }), { code: "config" });
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  const match = options.cacheStorage.match.bind(options.cacheStorage);
  const lookup = t.mock.method(options.cacheStorage, "match", (url, args) => url === configUrl && args.cacheName === saved.cacheName
    ? oversized("cache") : match(url, args));
  assert.equal((await manager.store.checkReadyConfig(saved)).status, "needs-config");
  lookup.mock.restore();
  assert.deepEqual(reads, ["network", "network", "cache", "cache"]);
  assert.deepEqual(canceled, ["network", "cache"]);

  manager.fetchImpl = (url, request) => url === configUrl ? new Response(boundary) : options.fetchImpl(url, request);
  assert.equal((await manager.start({ ...selected, episodeId: "new", configBookId: config.id })).episodeId, "new");
});

test("low-space replacement keeps the paused download until the new cache and staging record are ready", async (t) => {
  const mib = 1024 ** 2;
  const total = 8 * mib + 4;
  for (const phase of ["open", "manifest", "staging record"]) {
    const { manager, options, saved } = await savedBookFixture();
    const { cacheStorage: caches, baseUrl } = options;
    manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
    await assert.rejects(manager.start({ ...selection(total), episodeId: "paused" }), /connection lost/);
    const previous = manager.staging;
    options.navigatorObject.storage.estimate = async () => ({ quota: 100 * mib, usage: 80 * mib });
    const url = new URL("media/next/book.json", baseUrl).href;
    const next = { ...selection(total), episodeId: "next", configBookId: "next",
      sourceUrl: new URL("audio.webm", url).href, assets: [{ url, required: true }] };
    const fetchAudio = rangedFetch(total);
    let audioRequests = 0;
    manager.fetchImpl = (key, request) => {
      if (key === url) return Response.json({ id: "next", defaultLanguage: "en",
        languages: { en: { sources: { opus: { 64: "audio.webm" } } } } });
      if (request.headers.Range !== "bytes=0-0") audioRequests++;
      return fetchAudio(key, request);
    };
    const open = caches.open.bind(caches);
    const quota = () => { throw new DOMException("Full", "QuotaExceededError"); };
    const opening = t.mock.method(caches, "open", async (name) => {
      if (!name.startsWith(manager.store.bookCachePrefix) || [saved.cacheName, previous.cacheName].includes(name)) return open(name);
      if (phase === "open") quota();
      const cache = await open(name);
      if (phase !== "manifest") return cache;
      return { put(key, value) {
        if (key === offlineManifestUrl(baseUrl)) quota();
        return cache.put(key, value);
      } };
    });
    const control = caches.offlineControl.bind(caches);
    const journal = t.mock.method(caches, "offlineControl", (url) => {
      const store = control(url);
      return { ...store, async write(entries, signal) {
        if (phase === "staging record" && entries.staging?.manifest.episodeId === "next") quota();
        return store.write(entries, signal);
      } };
    });

    await assert.rejects(manager.start(next), { code: "quota" });
    assert.equal(audioRequests, 0);
    assert.equal((await manager.readRecord("staging"))?.downloadId, previous.downloadId, phase);
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.ok(await caches.match(offlineChunkUrl(baseUrl, previous.downloadId, 0), { cacheName: previous.cacheName }));

    opening.mock.restore();
    journal.mock.restore();
    const replacement = await manager.start(next);
    assert.equal(replacement.episodeId, "next");
    assert.equal(await caches.has(previous.cacheName), false);
  }
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

test("replacement quota only credits complete chunks read within the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, saved, options } = await savedBookFixture();
  const { baseUrl, cacheStorage, navigatorObject } = options;
  navigatorObject.storage.estimate = async () => ({ quota: 16 * 1024 * 1024 + 6, usage: 0 });
  const staging = { ...saved, ...selection(8), status: "downloading", episodeId: "draft", downloadId: "partial",
    cacheName: manager.store.bookCachePrefix + "partial", totalSize: 8, chunkSize: 4, totalChunks: 2, completed: [0] };
  const book = await cacheStorage.open(staging.cacheName);
  await book.put(offlineManifestUrl(baseUrl), Response.json(staging));
  await manager.writeRecord("staging", staging);
  manager.staging = staging;
  const chunkUrl = offlineChunkUrl(baseUrl, staging.downloadId, 0);
  const match = book.match.bind(book);
  const selected = { ...selection(), episodeId: "replacement" };
  const fetchRange = rangedFetch(10);
  const audioRequests = [];
  manager.fetchImpl = (url, request) => {
    if (request.headers.Range !== "bytes=0-0") audioRequests.push(request.headers.Range);
    return fetchRange(url, request);
  };

  let cancellations = 0;
  let pulls = 0;
  const chunk = (oversized) => {
    const sizes = oversized ? [4, 1, 1] : [4];
    return new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(sizes.shift()));
        if (!oversized) return new Promise(() => {});
        if (!sizes.length) controller.close();
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 }));
  };

  book.match = (url) => url === chunkUrl ? chunk(true) : match(url);
  await assert.rejects(manager.start(selected), { code: "quota" });
  assert.equal(pulls, 2);

  book.match = (url) => url === chunkUrl ? chunk(false) : match(url);
  const bodyTimeout = assert.rejects(manager.start(selected), { code: "quota" });
  await settle();
  t.mock.timers.tick(3000);
  await bodyTimeout;
  assert.equal(cancellations, 2);

  const lookup = deferred();
  book.match = (url) => url === chunkUrl ? lookup.promise : match(url);
  const lookupTimeout = assert.rejects(manager.start(selected), { code: "quota" });
  await settle();
  t.mock.timers.tick(3000);
  await lookupTimeout;
  lookup.resolve(chunk(false));
  await settle();
  assert.equal(cancellations, 3);

  const canceled = new AbortController();
  const pendingLookup = deferred();
  book.match = (url) => url === chunkUrl ? pendingLookup.promise : match(url);
  const aborted = assert.rejects(manager.store.canReclaimBytes(staging, 4, canceled.signal), { name: "AbortError" });
  await settle();
  canceled.abort();
  await aborted;
  pendingLookup.resolve(chunk(false));
  await settle();
  assert.equal(cancellations, 4);
  assert.deepEqual(audioRequests, []);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal((await manager.readRecord("staging")).downloadId, staging.downloadId);

  book.match = match;
  await book.put(chunkUrl, new Response(new Uint8Array(4)));
  assert.equal((await manager.start(selected)).episodeId, selected.episodeId);
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

test("a changed audio MIME type starts a fresh download instead of failing every Resume", async () => {
  const total = 8 * 1024 ** 2 + 4;
  const manager = new OfflineManager({ baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigatorStub(), fetchImpl: rangedFetch(total, { failSecondChunk: true, contentType: "audio/webm" }) });
  await manager.init();
  const selected = selection(total);
  await assert.rejects(manager.start(selected), /connection lost/);
  const previous = manager.staging;
  assert.deepEqual(previous.completed, [0]);

  const requests = [];
  const fetch = rangedFetch(total);
  manager.fetchImpl = async (url, request) => {
    requests.push(request.headers.Range);
    const response = await fetch(url, request);
    response.headers.set("content-type", "audio/ogg");
    return response;
  };
  const preflight = await manager.inspectSource(selected);
  assert.equal(preflight.canResume, false);
  const saved = await manager.start(selected, preflight);
  assert.notEqual(saved.downloadId, previous.downloadId);
  assert.equal(saved.mime, "audio/ogg");
  assert.deepEqual(requests, ["bytes=0-0", "bytes=0-8388607", "bytes=8388608-8388611"]);
});

test("offline audio requests reject redirects to another origin before storing chunks", async () => {
  const audioUrl = "https://example.test/audio.webm";
  const redirect = (url = "https://other.test/audio.webm") => {
    const response = new Response(Uint8Array.of(1), { status: 206, headers: {
      "content-range": "bytes 0-0/1", "content-type": "audio/webm", etag: '"one"',
    } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  await assert.rejects(inspectAudioRange(() => redirect(), audioUrl, "audio/webm"), { code: "cross-origin" });
  const sameOrigin = redirect("https://example.test/media/audio.webm");
  assert.equal((await inspectAudioRange(() => sameOrigin, audioUrl, "audio/webm")).totalSize, 1);
  const manifest = { sourceUrl: audioUrl, mime: "audio/webm", totalSize: 1, chunkSize: 1,
    totalChunks: 1, completed: [], etag: '"one"' };
  await assert.rejects(async () => {
    for await (const chunk of downloadChunks(() => redirect(), manifest, undefined, async () => {})) {
      assert.fail("Unexpected chunk from a redirected audio request");
    }
  }, { code: "cross-origin" });
});

test("rejected audio ranges report their error and release the lock while body cancellation is pending", async () => {
  for (const phase of ["probe", "download"]) {
    const { manager, saved, selected, config, configUrl } = await savedBookFixture();
    const canceling = deferred();
    const cleanup = deferred();
    const releaseBody = new ReadableStream({
      cancel() { canceling.resolve(heldLocks.has(manager.coordinationName)); return cleanup.promise; },
    });
    const audio = rangedFetch(10);
    manager.fetchImpl = (url, request) => {
      if (url === configUrl) return Response.json(config);
      const isProbe = request.headers.Range === "bytes=0-0";
      if (isProbe !== (phase === "probe")) return audio(url, request);
      return new Response(releaseBody, { status: 200 });
    };
    let failure;
    const attempt = manager.start(selected).catch((error) => { failure = error; });
    try {
      assert.equal(await canceling.promise, phase === "download");
      await settle();
      assert.equal(failure?.code, phase === "probe" ? "range" : "changed");
      assert.equal(heldLocks.has(manager.coordinationName), false);
      assert.equal(manager.active.downloadId, saved.downloadId);
    } finally {
      cleanup.reject(new Error("Cancellation failed"));
      await attempt;
    }
  }
});

test("a valid audio range arriving after Cancel is canceled without reading or storing its bytes", async () => {
  const { manager, saved, selected, config, configUrl } = await savedBookFixture();
  const requested = deferred();
  const pending = deferred();
  const audio = rangedFetch(10);
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    if (request.headers.Range === "bytes=0-0") return audio(url, request);
    requested.resolve(request.signal);
    return pending.promise;
  };

  const canceled = assert.rejects(manager.start(selected), { name: "AbortError" });
  const signal = await requested.promise;
  await manager.cancel();
  await canceled;
  assert.equal(signal.aborted, true);
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(10)); controller.close(); },
    cancel() { cancellations++; },
  }, { highWaterMark: 0 });
  try {
    pending.resolve(new Response(body, { status: 206, headers: {
      "content-range": "bytes 0-9/10", "content-type": "audio/webm", etag: '"one"',
    } }));
    await settle();
    assert.equal(cancellations, 1);
    assert.equal(pulls, 0);
    assert.equal(await manager.readRecord("staging"), null);
    assert.equal(manager.active.downloadId, saved.downloadId);
  } finally {
    if (!cancellations) await body.cancel();
  }
});

test("a changed same-origin redirect stops the download and resume restarts from byte zero", async () => {
  const chunkSize = 8 * 1024 * 1024;
  const total = chunkSize + 4;
  const selected = selection(total);
  const destinations = ["https://example.test/edition-one.webm", "https://example.test/edition-two.webm"];
  const ranges = [];
  let revision = 0;
  const fetchImpl = async (url, { headers }) => {
    assert.equal(url, selected.sourceUrl);
    const [start, end] = headers.Range.slice("bytes=".length).split("-").map(Number);
    if (start === chunkSize) revision = 1;
    if (end > 0) ranges.push(start);
    const response = new Response(new Uint8Array(end - start + 1).fill(revision + 1), { status: 206, headers: {
      "content-range": `bytes ${start}-${end}/${total}`, "content-type": "audio/webm", etag: '"same-tag"',
    } });
    Object.defineProperty(response, "url", { value: destinations[revision] });
    return response;
  };
  const cacheStorage = new MemoryCacheStorage();
  const options = { baseUrl: "https://example.test/", cacheStorage, navigatorObject: navigatorStub(), fetchImpl };
  const first = new OfflineManager(options);
  await first.init();
  await assert.rejects(first.start(selected), { code: "changed" });
  assert.equal(first.active, null);
  assert.deepEqual(first.staging.completed, [0]);
  const originalId = first.staging.downloadId;

  const reopened = new OfflineManager(options);
  await reopened.init();
  ranges.length = 0;
  const ready = await reopened.resume({
    confirmDownload(check) {
      assert.equal(check.canResume, false);
      assert.equal(check.remainingBytes, total);
      return true;
    },
  });
  assert.notEqual(ready.downloadId, originalId);
  assert.equal(ready.status, "ready");
  assert.deepEqual(ranges, [0, chunkSize]);
  for (const index of [0, 1]) {
    const chunk = await cacheStorage.match(offlineChunkUrl(options.baseUrl, ready.downloadId, index), { cacheName: ready.cacheName });
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    assert.equal(bytes[0], 2);
    assert.equal(bytes.at(-1), 2);
  }
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
  const published = await workerContext({ caches: cacheStorage });
  const manifest = await waitForRecord(() => published.activeManifest(), Boolean);
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

test("offline If-Range serves partial audio only when the saved edition matches", async () => {
  const worker = await workerContext();
  const url = "https://example.test/book.m4b";
  const modified = "Wed, 04 Mar 2026 11:00:00 GMT";
  const manifest = { downloadId: "one", totalSize: 6, chunkSize: 3, mime: "audio/mp4",
    etag: '"edition-one"', lastModified: modified, responseDate: "Wed, 04 Mar 2026 12:00:00 GMT" };
  const cache = { match: async (url) => new Response(url.endsWith("/0") ? Uint8Array.of(0, 1, 2) : Uint8Array.of(3, 4, 5)) };
  for (const [condition, saved, expected] of [
    ['"edition-two"', manifest, 200], ['"edition-one"', manifest, 206],
    ['W/"edition-one"', manifest, 200], ['W/"edition-one"', { ...manifest, etag: 'W/"edition-one"' }, 200],
    [modified, manifest, 206], [modified, { ...manifest, etag: "" }, 206],
    [manifest.responseDate, manifest, 200], [modified, { ...manifest, responseDate: modified }, 200],
    ['"edition-one"', { ...manifest, etag: undefined, responseDate: undefined }, 200],
    ["", manifest, 200], [null, manifest, 206],
  ]) {
    const headers = { Range: "bytes=2-3" };
    if (condition !== null) headers["If-Range"] = condition;
    const response = await worker.cachedMediaResponse(new Request(url, { headers }), saved, cache);
    assert.equal(response.status, expected, String(condition));
    assert.equal(response.headers.get("content-range"), expected === 206 ? "bytes 2-3/6" : null);
    assert.equal(response.headers.get("content-length"), expected === 206 ? "2" : "6");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected === 206 ? [2, 3] : [0, 1, 2, 3, 4, 5]);
  }
  const head = await worker.cachedMediaResponse(new Request(url, { method: "HEAD" }), manifest, cache);
  assert.equal(head.headers.get("etag"), manifest.etag);
  assert.equal(head.headers.get("last-modified"), modified);
  const unsatisfied = (version) => worker.cachedMediaResponse(new Request(url, {
    headers: { Range: "bytes=20-", "If-Range": version },
  }), manifest, cache);
  assert.equal((await unsatisfied('"edition-two"')).status, 200);
  assert.equal((await unsatisfied('"edition-one"')).status, 416);
});

test("the saved audio route does not confirm a download whose first chunk is missing", async () => {
  const { options, saved } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const worker = await workerContext({ caches: options.cacheStorage });
  const url = new URL(offlineMetaUrl(options.baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  const request = new Request(url, { method: "HEAD" });
  const valid = await worker.savedAudioResponse(request, url, assert.fail);
  assert.equal(valid.status, 200);
  assert.equal(valid.body, null);
  await cache.delete(offlineChunkUrl(options.baseUrl, saved.downloadId, 0));
  const reported = deferred();
  const missing = await worker.savedAudioResponse(request, url, reported.resolve);
  assert.equal(missing.status, 404);
  await reported.promise;
  const { damagedChunkUrl } = globalThis.CompactPlayerOfflineManifest;
  assert.ok(await cache.match(damagedChunkUrl(options.baseUrl, saved.downloadId, 0)));
});

test("the original audio URL never falls back to supporting files when its chunks are missing", async () => {
  const { options, saved } = await savedBookFixture();
  const worker = await workerContext({ caches: options.cacheStorage });
  const cache = await options.cacheStorage.open(saved.cacheName);
  const audio = new Request(saved.sourceUrl, { headers: { Range: "bytes=0-2" } });
  const head = new Request(saved.sourceUrl, { method: "HEAD" });
  assert.equal((await worker.cachedBookResponse(head)).status, 200);
  const valid = await worker.cachedBookResponse(audio);
  assert.equal(valid.status, 206);
  assert.equal((await valid.arrayBuffer()).byteLength, 3);

  await cache.delete(offlineChunkUrl(options.baseUrl, saved.downloadId, 0));
  await cache.put(saved.sourceUrl, new Response("unrelated supporting file"));
  assert.equal(await worker.cachedBookResponse(head), null);
  assert.equal(await worker.cachedBookResponse(audio), null);
});

test("the saved audio route rejects a cached HTTP error even when its body length matches", async () => {
  const { options, saved } = await savedBookFixture();
  const worker = await workerContext({ caches: options.cacheStorage });
  const url = new URL(offlineMetaUrl(options.baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  const cache = await options.cacheStorage.open(saved.cacheName);
  const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  await cache.put(chunk, new Response(new Uint8Array(saved.totalSize), { status: 503 }));
  for (const method of ["HEAD", "GET"]) {
    const damage = deferred();
    const request = new Request(url, { method });
    const response = await worker.savedAudioResponse(request, url, damage.resolve);
    assert.equal(response.status, 404, method);
    await damage.promise;
  }
});

test("saved playback and the inventory reject a chunk copied from a different offset", async () => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const audio = rangedFetch(2 * 8 * 1024 ** 2 + 4);
  const requests = [];
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    requests.push(request.headers.Range);
    return audio(url, request);
  };
  const saved = await manager.start(selected);
  requests.length = 0;
  const cache = await options.cacheStorage.open(saved.cacheName);
  const chunk = (index) => offlineChunkUrl(options.baseUrl, saved.downloadId, index);
  await cache.put(chunk(0), await cache.match(chunk(1)));

  const worker = await workerContext({ caches: options.cacheStorage });
  const url = new URL(offlineMetaUrl(options.baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  for (const method of ["HEAD", "GET"]) {
    const reported = deferred();
    const response = await worker.savedAudioResponse(new Request(url, { method }), url, reported.resolve);
    assert.equal(response.status, 404, method);
    await reported.promise;
  }

  await manager.refresh();
  assert.equal(manager.active, null);
  assert.equal(manager.staging.downloadId, saved.downloadId);
  assert.deepEqual(manager.staging.completed, [1, 2]);
  assert.equal((await manager.resume()).downloadId, saved.downloadId);
  assert.deepEqual(requests, ["bytes=0-0", "bytes=0-8388607"]);
});

test("the worker reports same-length corruption and Resume replaces only the damaged chunk", async () => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const total = 8 * 1024 ** 2 + 4;
  const fetch = rangedFetch(total);
  const ranges = [];
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    ranges.push(request.headers.Range);
    return fetch(url, request);
  };
  const saved = await manager.start(selected);
  const cache = await options.cacheStorage.open(saved.cacheName);
  const key = offlineChunkUrl(options.baseUrl, saved.downloadId, 1);
  const original = await cache.match(key);
  const bytes = new Uint8Array(await original.arrayBuffer());
  bytes[0] ^= 0xff;
  await cache.put(key, new Response(bytes, { headers: original.headers }));

  const worker = await workerContext({ caches: options.cacheStorage });
  const url = new URL(offlineMetaUrl(options.baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  const request = new Request(url, { headers: { Range: `bytes=${total - 4}-` } });
  const reported = deferred();
  const corrupt = await worker.savedAudioResponse(request, url, (work) => { if (work) reported.resolve(work); });
  await assert.rejects(corrupt.arrayBuffer(), /chunk/);
  await reported.promise;
  await manager.refresh();
  assert.equal(manager.active, null);
  assert.deepEqual(manager.staging.completed, [0]);

  ranges.length = 0;
  assert.equal((await manager.resume()).downloadId, saved.downloadId);
  assert.deepEqual(ranges, ["bytes=0-0", `bytes=${total - 4}-${total - 1}`]);
  const repaired = await worker.savedAudioResponse(request, url, () => {});
  bytes[0] ^= 0xff;
  assert.deepEqual(new Uint8Array(await repaired.arrayBuffer()), bytes);
});

test("resuming a legacy draft requires checksums only on the chunks written by the new downloader", async () => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const chunkSize = 8 * 1024 ** 2;
  const total = chunkSize + 4;
  const interrupted = rangedFetch(total, { failSecondChunk: true });
  manager.fetchImpl = (url, request) => url === configUrl ? Response.json(config) : interrupted(url, request);
  await assert.rejects(manager.start(selected), /connection lost/);

  const draft = { ...manager.staging };
  delete draft.checksummedChunks;
  const cache = await options.cacheStorage.open(draft.cacheName);
  const chunkKey = (index) => offlineChunkUrl(options.baseUrl, draft.downloadId, index);
  const { chunkDigestHeader } = globalThis.CompactPlayerOfflineManifest;
  const removeChecksum = async (index) => {
    const original = await cache.match(chunkKey(index));
    const headers = new Headers(original.headers);
    headers.delete(chunkDigestHeader);
    await cache.put(chunkKey(index), new Response(original.body, { headers }));
  };
  await removeChecksum(0);
  await cache.put(offlineManifestUrl(options.baseUrl), Response.json(draft));
  await manager.writeRecord("staging", draft);

  const audio = rangedFetch(total);
  const requests = [];
  const reopened = new OfflineManager({ ...options, fetchImpl: (url, request) => {
    if (url === configUrl) return Response.json(config);
    requests.push(request.headers.Range);
    return audio(url, request);
  } });
  await reopened.init();
  const saved = await reopened.resume();
  assert.equal(saved.downloadId, draft.downloadId);
  assert.deepEqual(requests, ["bytes=0-0", `bytes=${chunkSize}-${total - 1}`]);

  const worker = await workerContext({ caches: options.cacheStorage });
  const url = new URL(offlineMetaUrl(options.baseUrl, "audio"));
  url.searchParams.set("download", saved.downloadId);
  const request = (range) => new Request(url, { headers: { Range: range } });
  const legacy = await worker.savedAudioResponse(request("bytes=0-1"), url, assert.fail);
  assert.equal((await legacy.arrayBuffer()).byteLength, 2);

  const olderManifestCopy = { ...saved };
  delete olderManifestCopy.checksummedChunks;
  await cache.put(offlineManifestUrl(options.baseUrl), Response.json(olderManifestCopy));
  await removeChecksum(1);
  const damage = deferred();
  const failed = await worker.savedAudioResponse(request(`bytes=${chunkSize}-`), url, damage.resolve);
  assert.equal(failed.status, 404);
  await damage.promise;
  await reopened.refresh();
  assert.deepEqual(reopened.staging.completed, [0]);
  assert.deepEqual(reopened.staging.checksummedChunks, [1]);
  requests.length = 0;
  const repaired = await reopened.resume();
  assert.equal(repaired.downloadId, saved.downloadId);
  assert.deepEqual(repaired.checksummedChunks, [1]);
  assert.deepEqual(requests, ["bytes=0-0", `bytes=${chunkSize}-${total - 1}`]);
});

test("Resume checks stored audio before estimating space and fetches both damaged and missing ranges", async (t) => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const chunkSize = 8 * 1024 ** 2;
  const total = 2 * chunkSize + 4;
  const tail = `bytes=${2 * chunkSize}-${total - 1}`;
  const audio = rangedFetch(total);
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    if (request.headers.Range === tail) throw new TypeError("connection lost");
    return audio(url, request);
  };
  await assert.rejects(manager.start(selected), /connection lost/);
  const draft = manager.staging;
  assert.deepEqual(draft.completed, [0, 1]);
  const cache = await options.cacheStorage.open(draft.cacheName);
  const key = offlineChunkUrl(options.baseUrl, draft.downloadId, 0);
  const original = await cache.match(key);
  const bytes = new Uint8Array(await original.arrayBuffer());
  bytes[0] ^= 0xff;
  await cache.put(key, new Response(bytes, { headers: original.headers }));

  const ranges = [];
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    ranges.push(request.headers.Range);
    return audio(url, request);
  };
  const reservations = [];
  const checkSpace = manager.storageSpace.checkBeforeWrite.bind(manager.storageSpace);
  t.mock.method(manager.storageSpace, "checkBeforeWrite", async (...args) => {
    const result = await checkSpace(...args);
    reservations.push(result.remainingBytes);
    return result;
  });
  const ready = await manager.resume({ confirmDownload(check) {
    assert.equal(check.canResume, true);
    assert.deepEqual(ranges, ["bytes=0-0"]);
    reservations.push(check.remainingBytes);
    return true;
  } });
  assert.equal(ready.downloadId, draft.downloadId);
  assert.deepEqual(ready.completed, [0, 1, 2]);
  assert.deepEqual(reservations, [chunkSize + 4, chunkSize + 4]);
  assert.deepEqual(ranges, ["bytes=0-0", `bytes=0-${chunkSize - 1}`, tail]);
});

test("Resume includes a chunk evicted after the first inspection in the final reservation and transfer", async (t) => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const chunkSize = 8 * 1024 ** 2;
  const total = 2 * chunkSize + 4;
  const tail = `bytes=${2 * chunkSize}-${total - 1}`;
  const audio = rangedFetch(total);
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    if (request.headers.Range === tail) throw new TypeError("connection lost");
    return audio(url, request);
  };
  await assert.rejects(manager.start(selected), /connection lost/);
  const draft = manager.staging;
  assert.deepEqual(draft.completed, [0, 1]);
  const cache = await options.cacheStorage.open(draft.cacheName);
  const chunk = offlineChunkUrl(options.baseUrl, draft.downloadId, 0);
  let estimates = 0;
  options.navigatorObject.storage.estimate = async () => {
    if (++estimates === 1) await cache.delete(chunk);
    return { quota: 100 * 1024 ** 2, usage: 0 };
  };
  const reservations = [];
  const checkSpace = manager.storageSpace.checkBeforeWrite.bind(manager.storageSpace);
  t.mock.method(manager.storageSpace, "checkBeforeWrite", async (...args) => {
    const result = await checkSpace(...args);
    reservations.push(result.remainingBytes);
    assert.deepEqual(ranges, ["bytes=0-0"]);
    return result;
  });
  const ranges = [];
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    ranges.push(request.headers.Range);
    return audio(url, request);
  };

  const ready = await manager.resume({ confirmDownload(check) {
    reservations.push(check.remainingBytes);
    return true;
  } });
  assert.equal(ready.downloadId, draft.downloadId);
  assert.deepEqual(ready.completed, [0, 1, 2]);
  assert.deepEqual(reservations, [4, chunkSize + 4]);
  assert.deepEqual(ranges, ["bytes=0-0", `bytes=0-${chunkSize - 1}`, tail]);
});

test("Resume recalculates space and makes at most one repair pass for chunks evicted during transfer", async (t) => {
  for (const scenario of ["recovered", "evicted again", "quota"]) {
    const { manager, options, saved, selected, config, configUrl } = await savedBookFixture();
    const chunkSize = 8 * 1024 ** 2;
    const total = chunkSize + 4;
    const first = `bytes=0-${chunkSize - 1}`;
    const tail = `bytes=${chunkSize}-${total - 1}`;
    const interrupted = rangedFetch(total, { failSecondChunk: true });
    manager.fetchImpl = (url, request) => url === configUrl ? Response.json(config) : interrupted(url, request);
    await assert.rejects(manager.start(selected), /connection lost/);
    const draft = manager.staging;
    const cache = await options.cacheStorage.open(draft.cacheName);
    const chunkKey = (index) => offlineChunkUrl(options.baseUrl, draft.downloadId, index);
    const ranges = [];
    const audio = rangedFetch(total);
    const reservations = [];
    const inspect = manager.storageSpace.inspect.bind(manager.storageSpace);
    t.mock.method(manager.storageSpace, "inspect", async (...args) => {
      const result = await inspect(...args);
      reservations.push(result.remainingBytes);
      return result;
    });
    manager.fetchImpl = async (url, request) => {
      if (url === configUrl) return Response.json(config);
      const range = request.headers.Range;
      ranges.push(range);
      if (range === tail) {
        assert.ok(await cache.delete(chunkKey(0)));
        if (scenario === "quota") options.navigatorObject.storage.estimate = async () => ({ quota: 16 * 1024 ** 2 + 4, usage: 0 });
      }
      if (range === first && scenario === "evicted again") assert.ok(await cache.delete(chunkKey(1)));
      return audio(url, request);
    };

    const resumed = manager.resume();
    if (scenario === "recovered") {
      const ready = await resumed;
      assert.equal(ready.downloadId, draft.downloadId);
      assert.deepEqual(ready.completed, [0, 1]);
    } else {
      await assert.rejects(resumed, { code: scenario === "quota" ? "quota" : "incomplete" });
      assert.equal(manager.active.downloadId, saved.downloadId);
      assert.equal(manager.staging.downloadId, draft.downloadId);
      assert.deepEqual(manager.staging.completed, scenario === "quota" ? [1] : [0]);
    }
    assert.deepEqual(reservations, [4, 4, chunkSize]);
    assert.deepEqual(ranges, scenario === "quota" ? ["bytes=0-0", tail] : ["bytes=0-0", tail, first]);
  }
});

test("a first download repairs one lost chunk only while the server confirms the original audio version", async () => {
  for (const scenario of ["same version", "changed version", "unversioned"]) {
    const { manager, options, saved, selected, config, configUrl } = await savedBookFixture();
    const chunkSize = 8 * 1024 ** 2;
    const total = chunkSize + 4;
    const first = `bytes=0-${chunkSize - 1}`;
    const tail = `bytes=${chunkSize}-${total - 1}`;
    const requests = [];
    let draftId;
    const evictFirstChunk = async () => {
      const draft = manager.staging;
      assert.deepEqual(draft.completed, [0]);
      draftId = draft.downloadId;
      const cache = await options.cacheStorage.open(draft.cacheName);
      assert.equal(await cache.delete(offlineChunkUrl(options.baseUrl, draftId, 0)), true);
    };
    const audio = rangedFetch(total);
    manager.fetchImpl = async (url, request) => {
      if (url === configUrl) return Response.json(config);
      const { Range, "If-Range": validator } = request.headers;
      requests.push([Range, validator]);
      if (Range === tail) await evictFirstChunk();
      if (scenario === "changed version" && Range === first && draftId) return new Response(null, { status: 200, headers: { etag: '"two"' } });
      const response = await audio(url, request);
      if (scenario === "unversioned") response.headers.delete("etag");
      return response;
    };

    const download = manager.start(selected, undefined, { async waitForPriority() {
      if (scenario === "unversioned" && manager.staging?.completed.length === 1) await evictFirstChunk();
    } });
    if (scenario === "same version") {
      const ready = await download;
      assert.equal(ready.downloadId, draftId);
      assert.deepEqual(ready.completed, [0, 1]);
    } else {
      await assert.rejects(download, { code: scenario === "changed version" ? "changed" : "incomplete" });
      assert.equal(manager.active.downloadId, saved.downloadId);
      assert.equal(manager.staging.downloadId, draftId);
      assert.deepEqual(manager.staging.completed, [1]);
    }
    assert.deepEqual(requests, scenario === "unversioned"
      ? [["bytes=0-0", undefined], [`bytes=0-${total - 1}`, undefined]]
      : [["bytes=0-0", undefined], [first, '"one"'], [tail, '"one"'], [first, '"one"']]);
  }
});

test("an old draft repair cannot hide a chunk replaced after its required checksum was lost", async (t) => {
  const { manager, options, selected, config, configUrl } = await savedBookFixture();
  const chunkSize = 8 * 1024 ** 2;
  const total = chunkSize + 4;
  const audio = rangedFetch(total);
  const publish = t.mock.method(manager.store, "publish", async () => { throw new Error("Publication failed"); });
  manager.fetchImpl = (url, request) => url === configUrl ? Response.json(config) : audio(url, request);
  await assert.rejects(manager.start(selected), /Publication failed/);
  publish.mock.restore();
  const draft = manager.staging;
  const cache = await options.cacheStorage.open(draft.cacheName);
  const key = offlineChunkUrl(options.baseUrl, draft.downloadId, 0);
  const original = await cache.match(key);
  const headers = new Headers(original.headers);
  headers.delete(globalThis.CompactPlayerOfflineManifest.chunkDigestHeader);
  await cache.put(key, new Response(original.body, { headers }));

  const ranges = [];
  manager.fetchImpl = (url, request) => {
    if (url === configUrl) return Response.json(config);
    ranges.push(request.headers.Range);
    return audio(url, request);
  };
  await manager.refresh();
  assert.deepEqual(manager.staging.completed, [1]);
  const repaired = await manager.resume();
  assert.equal(repaired.downloadId, draft.downloadId);
  assert.deepEqual(repaired.completed, [0, 1]);
  assert.deepEqual(ranges, ["bytes=0-0", `bytes=0-${chunkSize - 1}`]);
});

test("an unreadable cached audio body reports its chunk for rechecking", async () => {
  const worker = await workerContext();
  const manifest = { downloadId: "one", totalSize: 4, chunkSize: 4, mime: "audio/mp4", cacheVersion: "1" };
  const request = new Request("https://example.test/audio.m4b", { headers: { Range: "bytes=1-2" } });
  const reads = [];
  const reported = [];
  const failure = new DOMException("Disk read failed", "UnknownError");
  const response = await worker.downloadedMediaResponse(request, manifest, async (index) => {
    reads.push(index);
    return new Response(new ReadableStream({ start: (controller) => controller.error(failure) }));
  }, { reportInvalidChunk: (index) => reported.push(index) });
  assert.equal(response.status, 206);
  await assert.rejects(response.arrayBuffer(), { name: "UnknownError", message: "Disk read failed" });
  assert.deepEqual(reads, [0]);
  assert.deepEqual(reported, [0]);

  const second = await worker.downloadedMediaResponse(request, manifest,
    async () => new Response(Uint8Array.of(0, 1, 2, 3)), { reportInvalidChunk: (index) => reported.push(index) });
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [1, 2]);
  assert.deepEqual(reported, [0]);
});

test("saved playback and download inventory cancel a chunk at the first excess byte", async () => {
  const scope = "https://example.test/";
  const caches = new MemoryCacheStorage();
  const worker = await workerContext();
  const manifest = { ...selection(), schemaVersion: 1, status: "downloading", downloadId: "overrun",
    cacheName: "saved-book", totalSize: 4, chunkSize: 4, totalChunks: 1, completed: [0] };
  const chunkUrl = offlineChunkUrl(scope, manifest.downloadId, 0);
  const { damagedChunkUrl } = globalThis.CompactPlayerOfflineManifest;
  const damageUrl = damagedChunkUrl(scope, manifest.downloadId, 0);
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  const book = await caches.open(manifest.cacheName);
  const match = book.match.bind(book);
  await book.put(offlineManifestUrl(scope), Response.json(manifest));

  let pulls = 0;
  let cancellations = 0;
  book.match = async (url) => {
    if (url !== chunkUrl) return match(url);
    const buffers = [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(4), new Uint8Array(256 * 1024)];
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (buffers.length) controller.enqueue(buffers.shift());
        else controller.close();
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: { "content-length": "4" } });
  };

  const checked = await manager.store.inspectBookManifest(manifest.cacheName, manifest);
  assert.deepEqual(checked.manifest.completed, []);
  assert.equal(pulls, 2);
  assert.equal(cancellations, 1);

  const request = new Request(manifest.sourceUrl, { headers: { Range: "bytes=1-2" } });
  let finish;
  const recorded = new Promise((resolve) => { finish = resolve; });
  const response = await worker.cachedMediaResponse(request, manifest, book, finish);
  assert.equal(response.status, 206);
  await assert.rejects(response.arrayBuffer(), /chunk is incomplete/);
  await recorded;
  assert.ok(await match(damageUrl));
  assert.equal(pulls, 4);
  assert.equal(cancellations, 2);
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
      return new Response(new ReadableStream({
        pull(controller) {
          bodies.push(index);
          controller.enqueue(Uint8Array.of(index * 2, index * 2 + 1));
          controller.close();
        },
      }, { highWaterMark: 0 }));
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

test("aborting a saved-media request cancels a stalled body read after headers", async (t) => {
  const scope = "https://example.test/";
  const worker = await workerContext();
  const manifest = { downloadId: "one", totalSize: 6, chunkSize: 2, mime: "audio/webm" };
  const control = new AbortController();
  const request = new Request(scope + "audio.webm", { signal: control.signal });
  const entered = deferred();
  const completed = deferred();
  const reads = [];
  const damage = [];
  let canceled = false;
  const response = await worker.downloadedMediaResponse(request, manifest, async (index) => {
    reads.push(index);
    if (index === 0) return new Response(Uint8Array.of(0, 1));
    return new Response(new ReadableStream({
      pull() { entered.resolve(); return new Promise(() => {}); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 }));
  }, { reportInvalidChunk: (index) => damage.push(index), finish: completed.resolve });
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  assert.deepEqual([...(await reader.read()).value], [0, 1]);
  const pending = reader.read();
  const result = pending.then(() => null, (error) => error);
  await entered.promise;
  control.abort();
  await settle();
  assert.equal(canceled, true);
  assert.equal((await result).name, "AbortError");
  await completed.promise;
  assert.deepEqual(reads, [0, 1]);
  assert.deepEqual(damage, []);
});

test("a successful network response wins and explicit download requests bypass the worker", async () => {
  const events = {};
  const origin = "https://example.test";
  const live = new Response("live catalog");
  const worker = await workerContext({
    self: { location: { origin }, registration: { scope: origin + "/" },
      addEventListener(name, handler) { events[name] = handler; } },
    fetch: async () => live,
    caches: { open: assert.fail },
  });
  const url = origin + "/media/library.json";
  const response = await worker.networkFirst(new Request(url));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "live catalog");
  events.fetch({ request: new Request(url, { headers: { "x-compact-player-download": "1" } }), respondWith: assert.fail });
});

test("a canceled worker fetch does not read the saved book as a fallback", async () => {
  const controller = new AbortController();
  const started = deferred();
  const worker = await workerContext({
    fetch: (_request, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.resolve();
    }),
  });
  let reads = 0;
  worker.cachedFallback = () => { reads++; return new Response("old configuration"); };
  const request = new Request("https://example.test/media/book/book.json", { signal: controller.signal });
  const canceled = assert.rejects(worker.networkFirst(request), { name: "AbortError" });
  await started.promise;
  controller.abort();
  await canceled;
  assert.equal(reads, 0);
});

test("an expired worker fallback discards a cached book body that arrives late", async () => {
  const { options, saved, configUrl } = await savedBookFixture();
  const worker = await workerContext({ caches: options.cacheStorage });
  const cache = await options.cacheStorage.open(saved.cacheName);
  const started = deferred();
  const released = deferred();
  const control = new AbortController();
  let canceled = false;
  cache.match = async () => {
    started.resolve();
    await released.promise;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }));
  };

  const fallback = worker.cachedBookResponse(new Request(configUrl), "network-error", control.signal);
  await started.promise;
  control.abort();
  released.resolve();
  assert.equal(await fallback, null);
  assert.equal(canceled, true);
});

test("a live book response cancels a losing cached book lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options, saved, configUrl } = await savedBookFixture();
  const network = deferred();
  const reading = deferred();
  const release = deferred();
  const worker = await workerContext({ caches: options.cacheStorage, fetch: () => network.promise });
  const cache = await options.cacheStorage.open(saved.cacheName);
  let canceled = false;
  cache.match = async () => {
    reading.resolve();
    await release.promise;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }));
  };

  const result = worker.networkFirst(new Request(configUrl));
  t.mock.timers.tick(3000);
  await reading.promise;
  network.resolve(Response.json({ title: "Live response" }));
  assert.deepEqual(await (await result).json(), { title: "Live response" });
  release.resolve();
  await settle();
  assert.equal(canceled, true);
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

test("the saved audio route serves only the active download even while online", async () => {
  const events = {};
  const scope = "https://example.test/listen/";
  const caches = new MemoryCacheStorage();
  const worker = await workerContext({ caches, self: { registration: { scope }, location: { origin: "https://example.test" },
    navigator: { onLine: true }, addEventListener: (name, handler) => { events[name] = handler; } } });
  const manifest = { ...selection(), schemaVersion: 1, status: "ready", downloadId: "one", cacheName: "saved-book",
    totalSize: 3, chunkSize: 3, totalChunks: 1, completed: [0] };
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  await manager.writeRecord("active", manifest);
  const book = await caches.open(manifest.cacheName);
  await book.put(offlineChunkUrl(scope, "one", 0), new Response(Uint8Array.of(3, 4, 5)));
  const request = async (download) => {
    const url = new URL("__compact_player_offline__/audio.json", scope);
    url.searchParams.set("download", download);
    const input = new Request(url, { headers: { Range: "bytes=1-2" } });
    Object.defineProperty(input, "destination", { value: "audio" });
    let result;
    events.fetch({ request: input, respondWith: (response) => { result = response; }, waitUntil() {} });
    return result;
  };
  const response = await request("one");
  assert.equal(response.status, 206);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5]);
  assert.equal((await request("old")).status, 404);
});

test("saved audio bounds cache reads and reports confirmed damage outside playback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = {};
  const scope = "https://example.test/listen/";
  const caches = new MemoryCacheStorage();
  const notifications = [];
  const worker = await workerContext({ caches, self: { registration: { scope }, location: { origin: new URL(scope).origin },
    addEventListener: (name, handler) => { events[name] = handler; },
    clients: { matchAll: async () => [{ postMessage: (message) => notifications.push(message.index) }] } } });
  const manifest = { ...selection(), schemaVersion: 1, status: "ready", downloadId: "one", cacheName: "saved-book",
    totalSize: 6, chunkSize: 3, totalChunks: 2, completed: [0, 1] };
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  await manager.writeRecord("active", manifest);
  const book = await caches.open(manifest.cacheName);
  const meta = await caches.open(await useCachedActiveRecord(manager));
  const first = offlineChunkUrl(scope, manifest.downloadId, 0);
  const next = offlineChunkUrl(scope, manifest.downloadId, 1);
  const bookMatch = book.match.bind(book);
  const timeout = vm.runInContext("SAVED_AUDIO_CACHE_WAIT_MS", worker);
  await book.put(first, new Response(Uint8Array.of(0, 1, 2)));
  await book.put(next, new Response(Uint8Array.of(3, 4, 5)));

  const fetchAudio = (range = "bytes=0-") => {
    const request = new Request(scope + "__compact_player_offline__/audio.json?download=one", { headers: { Range: range } });
    Object.defineProperty(request, "destination", { value: "audio" });
    const operation = {};
    events.fetch({ request,
      respondWith: (response) => { operation.response = response; },
      waitUntil: (completion) => { operation.completion = completion; },
    });
    return operation;
  };

  for (const [object, method] of [[caches, "open"], [meta, "match"], [book, "match"]]) {
    const match = object[method];
    const blocked = deferred();
    object[method] = () => blocked.promise;
    let response;
    const operation = fetchAudio();
    operation.response.then((value) => { response = value; });
    await settle();
    assert.equal(response, undefined);
    t.mock.timers.tick(timeout);
    await settle();
    assert.equal(response?.status, 503);
    assert.ok(operation.completion);
    await operation.completion;
    object[method] = match;
    blocked.resolve(undefined);
    await settle();
    assert.deepEqual(notifications, []);
  }

  const later = deferred();
  book.match = (url) => url === next ? later.promise : bookMatch(url);
  const reading = fetchAudio();
  const response = await reading.response;
  const reader = response.body.getReader();
  assert.equal(response.status, 206);
  assert.deepEqual([...(await reader.read()).value], [0, 1, 2]);
  const read = assert.rejects(reader.read(), { name: "TimeoutError" });
  await settle();
  t.mock.timers.tick(timeout);
  await read;
  await reading.completion;
  later.resolve(undefined);
  await settle();
  assert.deepEqual(notifications, []);

  let cancelledBodies = 0;
  book.match = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.of(0, 1, 2)); },
    cancel() { cancelledBodies += 1; },
  }));
  const stalled = fetchAudio();
  const stalledReader = (await stalled.response).body.getReader();
  const stalledRead = assert.rejects(stalledReader.read(), { name: "TimeoutError" });
  await settle();
  t.mock.timers.tick(vm.runInContext("SAVED_AUDIO_BODY_WAIT_MS", worker));
  await stalledRead;
  await stalled.completion;
  assert.equal(cancelledBodies, 1);

  const seeking = fetchAudio();
  const seekReader = (await seeking.response).body.getReader();
  const cancelled = seekReader.read();
  await settle();
  await seekReader.cancel();
  assert.equal((await cancelled).done, true);
  await seeking.completion;
  assert.equal(cancelledBodies, 2);
  assert.deepEqual(notifications, []);

  book.match = (url) => url === next ? undefined : bookMatch(url);
  const saveDamage = deferred();
  const put = book.put.bind(book);
  const writes = [];
  book.put = (url, value) => { writes.push(url); return saveDamage.promise.then(() => put(url, value)); };
  const damaged = fetchAudio();
  const broken = await damaged.response;
  const brokenReader = broken.body.getReader();
  assert.deepEqual([...(await brokenReader.read()).value], [0, 1, 2]);
  await assert.rejects(brokenReader.read(), /chunk is missing/);
  const { damagedChunkUrl } = globalThis.CompactPlayerOfflineManifest;
  const marker = damagedChunkUrl(scope, manifest.downloadId, 1);
  assert.deepEqual(writes, [marker]);
  let completed = false;
  damaged.completion.then(() => { completed = true; });
  await settle();
  assert.equal(completed, false);
  saveDamage.resolve();
  await damaged.completion;
  assert.ok(await bookMatch(marker));
  assert.deepEqual(notifications, [1]);
  const missing = fetchAudio("bytes=3-");
  assert.equal((await missing.response).status, 404);
  await missing.completion;
});

test("file cover fallback during a worker upgrade checks the saved version", async (t) => {
  const image = new Element();
  const button = new Element();
  image.ownerDocument = { defaultView: { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: { scriptURL: "https://example.test/listen/sw.js" } } } } };
  let failed = 0;
  let savedVersion = "1";
  let sameBook = false;
  const requestOptions = [];
  const { versionHeader, versionHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const fetchImpl = async (_url, options) => {
    requestOptions.push(options);
    return new Response("cover", { headers: { [versionHeader]: versionHeaderValue(savedVersion) } });
  };
  const view = createCoverView(image, button, { fetchImpl, getBookId: () => "book",
    getFileCoverUrl: () => "https://example.test/listen/__compact_player_offline__/cover.json?book=book",
    canUseCachedCover: () => sameBook, onShown() {}, onFailure() { failed++; } });
  const book = { id: "book", coverSource: "file", cover: "cover.jpg", cacheVersion: "2",
    bookBaseUrl: "https://example.test/listen/media/book/" };
  view.applyCover(book, "en", null);
  assert.match(image.src, /__compact_player_offline__\/cover\.json\?/);
  image.onerror();
  await settle();
  assert.equal(failed, 1);
  assert.equal(image.src, undefined);
  savedVersion = "2";
  view.applyCover({ ...book }, "en", null);
  image.onerror();
  await settle();
  assert.equal(failed, 2);
  assert.equal(image.src, undefined);
  sameBook = true;
  view.applyCover({ ...book }, "en", null);
  image.onerror();
  await settle();
  assert.match(image.src, /^blob:/);
  image.onload();
  assert.equal(button.hidden, false);
  assert.ok(requestOptions.every((options) => options.cache === "no-cache"));
  view.clearCover();
});

test("worker upgrade permits an opaque redirected cover only with a compatible saved book", async () => {
  const image = new Element();
  const button = new Element();
  image.ownerDocument = { defaultView: { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: { scriptURL: "https://example.test/listen/sw.js" } } } } };
  let allowed = false;
  let failed = 0;
  const view = createCoverView(image, button, {
    fetchImpl: async () => ({ type: "opaque", ok: false }),
    getFileCoverUrl: () => "https://example.test/listen/__compact_player_offline__/cover.json?book=book",
    getBookId: () => "book", canUseNativeCover: async () => allowed,
    onShown() {}, onFailure() { failed++; },
  });
  const book = { id: "book", coverSource: "file", cover: "cover.jpg", cacheVersion: "2",
    bookBaseUrl: "https://example.test/listen/media/book/" };
  view.applyCover(book, "en", null);
  image.onerror();
  await settle();
  assert.equal(failed, 1);
  assert.equal(image.src, undefined);
  allowed = true;
  view.applyCover({ ...book }, "en", null);
  image.onerror();
  await settle();
  assert.equal(image.src, "https://example.test/listen/media/book/cover.jpg");
  image.onload();
  assert.equal(button.hidden, false);
  view.clearCover();
});

test("same-origin file cover without a worker revalidates the original URL", async () => {
  const image = new Element();
  const button = new Element();
  image.ownerDocument = { defaultView: { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: null } } } };
  const requests = [];
  const view = createCoverView(image, button, {
    fetchImpl: async (url, options) => { requests.push({ url, cache: options.cache }); return new Response("cover"); },
    onShown() {}, onFailure: assert.fail,
  });
  const book = { id: "book", coverSource: "file", cacheVersion: "2", cover: "cover.jpg",
    bookBaseUrl: "https://example.test/listen/media/book/" };
  view.applyCover(book, "en", null);
  await settle();
  assert.deepEqual(requests, [{ url: "https://example.test/listen/media/book/cover.jpg", cache: "no-cache" }]);
  assert.match(image.src, /^blob:/);
  view.clearCover();
});

test("same-origin cover failure without a worker does not reuse an unchecked image", async () => {
  const image = new Element();
  const button = new Element();
  image.ownerDocument = { defaultView: { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: null } } } };
  let failures = 0;
  const view = createCoverView(image, button, {
    fetchImpl: async () => { throw new TypeError("Network unavailable"); },
    onShown: assert.fail, onFailure() { failures++; },
  });
  view.applyCover({ id: "book", coverSource: "file", cacheVersion: "2", cover: "cover.jpg",
    bookBaseUrl: "https://example.test/listen/media/book/" }, "en", null);
  await settle();
  assert.equal(failures, 1);
  assert.equal(image.src, undefined);
  assert.equal(button.hidden, true);
});

test("uncontrolled same-origin redirects retain native no-CORS image loading", async () => {
  const image = new Element();
  const button = new Element();
  image.ownerDocument = { defaultView: { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: null } } } };
  const view = createCoverView(image, button, {
    fetchImpl: async () => ({ type: "opaque", ok: false }),
    canUseNativeCover: async () => true, onShown() {}, onFailure: assert.fail,
  });
  view.applyCover({ id: "book", coverSource: "file", cacheVersion: "2", cover: "redirect.jpg?signature=original",
    bookBaseUrl: "https://example.test/listen/media/book/" }, "en", null);
  await settle();
  assert.equal(image.src, "https://example.test/listen/media/book/redirect.jpg?signature=original");
  image.onload();
  assert.equal(button.hidden, false);
  view.clearCover();
});

test("external and data file covers keep their native URLs", () => {
  const image = new Element();
  const button = new Element();
  const browser = { location: new URL("https://example.test/listen/"),
    navigator: { serviceWorker: { controller: { scriptURL: "https://example.test/listen/sw.js" } } } };
  image.ownerDocument = { defaultView: browser };
  const view = createCoverView(image, button, { onShown() {}, onFailure() {} });
  const base = { id: "book", coverSource: "file", cacheVersion: "1", bookBaseUrl: "https://example.test/listen/media/book/" };
  for (const cover of ["https://external.test/cover.jpg", "data:image/png;base64,AA=="]) {
    view.applyCover({ ...base, cover }, "en", null);
    assert.equal(image.src, cover);
  }
  view.clearCover();
});

test("file covers only use a saved image from the requested book version", async () => {
  const events = {};
  const scope = "https://example.test/listen/";
  const caches = new MemoryCacheStorage();
  const cover = scope + "media/book/cover.jpg?signature=original";
  let serverStatus = 503;
  const requests = [];
  const optionsSeen = [];
  const worker = await workerContext({ caches, self: { registration: { scope }, location: { origin: "https://example.test" },
    navigator: { onLine: true }, addEventListener: (name, handler) => { events[name] = handler; } },
    fetch: async (url, options) => {
      requests.push(String(url));
      optionsSeen.push(options);
      return new Response(serverStatus === 200 ? "new cover" : "unavailable", { status: serverStatus });
    },
  });
  const manifest = { ...selection(), schemaVersion: 1, status: "ready", downloadId: "one", cacheName: "saved-book",
    totalSize: 3, chunkSize: 3, totalChunks: 1, completed: [0], cacheVersion: "1" };
  const manager = new OfflineManager({ baseUrl: scope, cacheStorage: caches, navigatorObject: navigatorStub() });
  await manager.writeRecord("active", manifest);
  await (await caches.open(manifest.cacheName)).put(cover, new Response("old cover"));
  const requestCover = async (version, book = "book", config = "book") => {
    const url = new URL("__compact_player_offline__/cover.json", scope);
    url.searchParams.set("url", cover);
    url.searchParams.set("version", version);
    url.searchParams.set("book", book);
    url.searchParams.set("config", config);
    const request = new Request(url, { mode: "no-cors" });
    Object.defineProperty(request, "destination", { value: "image" });
    let result;
    events.fetch({ request, respondWith: (response) => { result = response; } });
    return result;
  };
  const mismatch = await requestCover("2");
  assert.equal(mismatch.status, 503);
  assert.equal((await requestCover("1", "another")).status, 503);
  assert.equal(await (await requestCover("1")).text(), "old cover");
  await manager.writeRecord("active", { ...manifest, configBookId: "edition" });
  assert.equal((await requestCover("1", "book", "different-edition")).status, 503);
  assert.equal(await (await requestCover("1", "book", "edition")).text(), "old cover");
  serverStatus = 200;
  assert.equal(await (await requestCover("2")).text(), "new cover");
  assert.deepEqual(requests, [cover, cover, cover, cover, cover, cover]);
  assert.ok(optionsSeen.every((options) => options.cache === "no-cache"));
});

test("offline native audio cannot use a saved edition based only on the source URL", async () => {
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
  context.cachedFallback = assert.fail;
  const request = new Request("https://example.test/book.m4b", { headers: { Range: "bytes=7-8" } });
  Object.defineProperty(request, "destination", { value: "audio" });
  events.fetch({ request, respondWith: assert.fail });
});

async function savedBookFixture(filename = "book.json") {
  const baseUrl = "https://example.test/";
  const config = { id: "book", defaultLanguage: "en", title: { en: "Saved book" },
    languages: { en: { sources: { opus: { 64: "audio.webm" }, mp3: { 64: "alternate.mp3" } } } } };
  const configUrl = new URL("media/book/" + filename, baseUrl).href;
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

test("an unanswered persistence request cannot delay publishing a download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorObject = navigatorStub();
  const requested = deferred();
  const permission = deferred();
  navigatorObject.storage.persist = () => { requested.resolve(); return permission.promise; };
  const manager = new OfflineManager({ navigatorObject, cacheStorage: new MemoryCacheStorage(),
    baseUrl: "https://example.test/", fetchImpl: rangedFetch(10) });
  await manager.init();

  const notices = [];
  const download = manager.start(selection(), undefined, { onPersistence: (granted) => notices.push(granted) });
  await requested.promise;
  await settle();
  t.mock.timers.tick(20_000);
  const saved = await download;
  assert.equal(saved.status, "ready");
  assert.equal(manager.snapshot().active.downloadId, saved.downloadId);
  assert.deepEqual(notices, []);

  permission.resolve(false);
  await settle();
  assert.deepEqual(notices, [false]);
  assert.equal(manager.snapshot().active.downloadId, saved.downloadId);
});

test("a stalled quota estimate leaves the download usable before and under the write lock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorObject = navigatorStub();
  const estimateStarted = deferred();
  const estimates = [];
  navigatorObject.storage.estimate = () => {
    estimates.push(heldLocks.size > 0);
    estimateStarted.resolve();
    return new Promise(() => {});
  };
  const manager = new OfflineManager({ navigatorObject, cacheStorage: new MemoryCacheStorage(),
    baseUrl: "https://example.test/", fetchImpl: rangedFetch(10) });
  await manager.init();
  t.after(() => manager.cancel());
  const checks = [];
  const download = manager.start(selection(), undefined, { confirmDownload(check) {
    checks.push(check.availableBytes);
    return true;
  } });
  void download.catch(() => {});

  await estimateStarted.promise;
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(checks, [null]);
  assert.deepEqual(estimates, [false, true]);

  t.mock.timers.tick(1000);
  const saved = await download;
  assert.equal(saved.status, "ready");
  assert.equal(manager.snapshot().active.downloadId, saved.downloadId);
  assert.equal(heldLocks.size, 0);
});

test("an open tab updates its published download after another tab replaces or removes it", async () => {
  const { manager, saved, options, selected } = await savedBookFixture();
  const channels = [];
  class TestChannel extends EventTarget {
    constructor(name) { super(); this.name = name; channels.push(this); }
    postMessage(data) {
      for (const peer of channels) {
        if (peer !== this && peer.name === this.name) peer.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
  }

  const other = new OfflineManager(options);
  await other.init();
  manager.listenForPublishedChanges(TestChannel);
  other.listenForPublishedChanges(TestChannel);
  assert.equal(other.snapshot().active.downloadId, saved.downloadId);
  const replacement = await manager.start(selected);
  assert.notEqual(replacement.downloadId, saved.downloadId);
  await settle();
  assert.equal(other.snapshot().active?.downloadId, replacement.downloadId);

  const inspecting = deferred();
  const stopped = deferred();
  other.fetchImpl = () => { inspecting.resolve(); return stopped.promise; };
  const localOperation = other.start(selected).catch((error) => error);
  await inspecting.promise;
  await manager.removeActive();
  stopped.reject(new TypeError("Network unavailable"));
  assert.equal((await localOperation).message, "Network unavailable");
  await settle();
  assert.equal(other.snapshot().active, null);
});

test("an online episode.json takes precedence over the cached book.json after a 404", async () => {
  const { options, config, configUrl } = await savedBookFixture();
  const legacyUrl = new URL("episode.json", configUrl).href;
  const requests = [];
  let legacyAvailable = true;
  const worker = await workerContext({ caches: options.cacheStorage, fetch: async (request) => {
    requests.push(request.url);
    return request.url === legacyUrl && legacyAvailable
      ? Response.json({ ...config, title: { en: "Online legacy book" } })
      : new Response(null, { status: 404 });
  } });
  const createStore = () => new BookConfigStore({
    library: normalizeLibrary({ books: [{ id: "book" }] }),
    documentBaseUrl: options.baseUrl,
    fetchImpl: (url, request) => worker.networkFirst(new Request(url, request)),
  });

  const online = await createStore().load("book");
  assert.equal(online.configUrl, legacyUrl);
  assert.equal(online.book.title.en, "Online legacy book");
  assert.equal(online.fromDownload, false);
  assert.deepEqual(requests, [configUrl, legacyUrl]);

  legacyAvailable = false;
  const downloaded = await createStore().load("book");
  assert.equal(downloaded.configUrl, configUrl);
  assert.equal(downloaded.fromDownload, true);
  assert.equal(downloaded.book.title.en, "Saved book");
});

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

test("a downloaded book configuration is revalidated on reconnect or reselection without interrupting playback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  for (const [filename, trigger] of [["book.json", "online"], ["episode.json", "selection"]]) {
    const { config, configUrl, options, selected } = await savedBookFixture(filename);
    const navigator = { ...navigatorStub(), language: "en", onLine: filename === "book.json" };
    const revised = { ...config, title: { en: "Revised book" }, cacheVersion: 2,
      languages: { en: { sources: { opus: { 64: "new.webm" } } } } };
    const reads = [];
    let state = "unavailable";
    const worker = await workerContext({ caches: options.cacheStorage, fetch(request) {
      if (request.url.endsWith("/library.json")) {
        if (!navigator.onLine) return new Response(null, { status: 404 });
        return Response.json({ books: [{ id: "book" }, { id: "other" }], ui: { onboardingEnabled: false } });
      }
      if (request.url.endsWith("/other/book.json")) return Response.json({ ...config, id: "other", title: { en: "Other" } });
      if (request.url !== configUrl) return new Response(null, { status: 404 });
      reads.push(request.cache);
      if (state === "unavailable") return new Response(null, { status: 503 });
      if (state === "maintenance") return new Response("Maintenance");
      return Response.json(revised);
    } });
    const page = await openPlayerPage(config, assert.fail, new Map(), {
      navigator, caches: options.cacheStorage,
      fetch: (path, init) => worker.networkFirst(new Request(path, init)),
    });
    await page.ready;
    const title = () => page.elements.get("bookTitle").textContent;
    const select = page.elements.get("bookSelect");
    const choose = async (id) => { select.value = id; select.dispatchEvent(new Event("change")); await settle(); };
    assert.equal(title(), "Saved book");
    page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    const pauses = t.mock.method(page.audio, "pause");
    state = "maintenance";
    navigator.onLine = true;
    page.window.dispatchEvent(new Event("online"));
    await settle();
    assert.deepEqual(reads, ["default", "no-cache"]);
    assert.equal(title(), "Saved book");
    state = "revised";
    if (trigger === "online") {
      page.window.dispatchEvent(new Event("online"));
      await settle();
      assert.equal(select.children.find((option) => option.value === "book").textContent, "Revised book");
    }
    assert.equal(pauses.mock.callCount(), 0);
    assert.equal(page.audio.src, selected.sourceUrl);
    assert.equal(title(), "Saved book");
    await choose("other");
    assert.equal(title(), "Other");
    await choose("book");
    assert.equal(title(), "Revised book");
    page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    assert.equal(page.audio.src, new URL("new.webm", configUrl).href);
    page.window.dispatchEvent(new Event("online"));
    await settle();
    assert.deepEqual(reads, ["default", "no-cache", "no-cache"]);
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
    const ready = await manager.resume();
    assert.equal(ready.downloadId, staged.downloadId);
    assert.equal(configReads, cached === "valid" ? 0 : 2);
    assert.deepEqual(ranges, ["bytes=0-0", "bytes=8388608-8388611"]);
    assert.deepEqual(await (await cache.match(offlineConfigCacheUrl(options.baseUrl, ready))).json(), config);
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

test("a corrupt streamed chunk is reported and the published download can be repaired", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const workerMessages = new EventTarget();
  options.navigatorObject.serviceWorker.addEventListener = workerMessages.addEventListener.bind(workerMessages);
  const controller = workerController(options.baseUrl);
  options.navigatorObject.serviceWorker.controller = controller;
  const reopened = new OfflineManager(options);
  await reopened.init();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const url = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  const intact = await cache.match(url);
  await cache.put(url, new Response(Uint8Array.of(1), { headers: intact.headers }));
  const worker = await workerContext({
    caches: options.cacheStorage,
    self: { registration: { scope: options.baseUrl }, addEventListener() {}, clients: {
      async matchAll() { return [{ postMessage(data) {
        workerMessages.dispatchEvent(Object.assign(new Event("message"), { data, source: controller }));
      } }]; },
    } },
  });
  const initial = await worker.activeManifest();
  assert.ok(initial);
  const gate = deferred();
  const operation = reopened.runOperation(() => gate.promise);
  const response = await worker.cachedMediaResponse(new Request(saved.sourceUrl, { headers: { Range: "bytes=0-1" } }), initial, cache);
  await assert.rejects(response.arrayBuffer(), /incomplete/);
  assert.equal(reopened.active.downloadId, saved.downloadId);
  gate.resolve();
  await operation;
  for (let tries = 0; tries < 30 && reopened.active; tries++) await settle();
  assert.equal(reopened.active, null);
  assert.equal(reopened.staging?.downloadId, saved.downloadId);
  assert.deepEqual(reopened.staging.completed, []);
  assert.equal((await reopened.resume()).status, "ready");
  assert.equal(new Uint8Array(await (await cache.match(url)).arrayBuffer()).length, 10);
  assert.equal((await reopened.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(manager.active.downloadId, saved.downloadId);

  // An old response can fail after the chunk has already been repaired.
  await cache.put(url, new Response(Uint8Array.of(1), { headers: intact.headers }));
  const stale = await worker.cachedMediaResponse(new Request(saved.sourceUrl), initial, cache);
  await cache.put(url, intact);
  await assert.rejects(stale.arrayBuffer(), /incomplete/);
  await reopened.refresh();
  assert.equal(reopened.active?.downloadId, saved.downloadId);
  assert.equal(reopened.staging, null);

  // A transient body read error is rechecked against the intact saved chunk.
  const transientCache = {
    match: async () => new Response(new ReadableStream({
      start: (controller) => controller.error(new DOMException("Disk read failed", "UnknownError")),
    }), { headers: intact.headers }),
    put: cache.put.bind(cache),
  };
  const transient = await worker.cachedMediaResponse(new Request(saved.sourceUrl), initial, transientCache);
  await assert.rejects(transient.arrayBuffer(), { name: "UnknownError" });
  if (reopened.damage.check) await reopened.damage.check;
  await reopened.refresh();
  assert.equal(reopened.active?.downloadId, saved.downloadId);
  assert.equal(reopened.staging, null);

  const other = await savedBookFixture();
  const otherCache = await other.options.cacheStorage.open(other.saved.cacheName);
  const otherUrl = offlineChunkUrl(other.options.baseUrl, other.saved.downloadId, 0);
  const otherChunk = await otherCache.match(otherUrl);
  await otherCache.put(otherUrl, new Response(Uint8Array.of(1), { headers: otherChunk.headers }));
  const unattended = await workerContext({ caches: other.options.cacheStorage });
  const otherResponse = await unattended.cachedMediaResponse(new Request(other.saved.sourceUrl), other.saved, otherCache);
  await assert.rejects(otherResponse.arrayBuffer(), /incomplete/);
  const afterReload = new OfflineManager(other.options);
  await afterReload.init();
  assert.equal(afterReload.staging?.downloadId, other.saved.downloadId);
  assert.deepEqual(afterReload.staging.completed, []);
});

test("damage reports survive concurrent refresh, denied locks, and a full marker cache", async (t) => {
  t.mock.method(console, "warn", () => {});
  for (const scenario of ["refreshing", "lock denied", "marker quota"]) {
    const { options, saved } = await savedBookFixture();
    const messages = new EventTarget();
    const controller = workerController(options.baseUrl);
    Object.assign(options.navigatorObject.serviceWorker, { controller, addEventListener: messages.addEventListener.bind(messages) });
    let denied = false;
    options.navigatorObject.locks = { async request(name, request, action) {
      if (denied && !request.ifAvailable) { denied = false; throw new Error("Lock denied"); }
      return locks.request(name, request, action);
    } };
    const manager = new OfflineManager(options);
    await manager.init();
    const cache = await options.cacheStorage.open(saved.cacheName);
    const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
    const marker = globalThis.CompactPlayerOfflineManifest.damagedChunkUrl(options.baseUrl, saved.downloadId, 0);
    if (scenario === "marker quota") {
      const originalPut = cache.put.bind(cache);
      cache.put = async (input, response) => {
        if (cache.key(input) === marker) throw new DOMException("Storage is full", "QuotaExceededError");
        return originalPut(input, response);
      };
    }
    const arrived = deferred();
    const release = deferred();
    const originalMatch = cache.match.bind(cache);
    let wait = scenario === "refreshing";
    cache.match = async (input) => {
      const value = await originalMatch(input);
      if (wait && cache.key(input) === marker) {
        wait = false;
        arrived.resolve();
        await release.promise;
      }
      return value;
    };
    let refresh;
    if (wait) {
      refresh = manager.refresh();
      await arrived.promise;
    } else if (scenario === "lock denied") {
      denied = true;
    }
    const intact = await cache.match(chunk);
    await cache.put(chunk, new Response(Uint8Array.of(1), { headers: intact.headers }));
    const worker = await workerContext({ caches: options.cacheStorage,
      self: { registration: { scope: options.baseUrl }, addEventListener() {}, clients: {
        async matchAll() { return [{ postMessage(data) {
          messages.dispatchEvent(Object.assign(new Event("message"), { data, source: controller }));
        } }]; },
      } },
    });
    const response = await worker.cachedMediaResponse(new Request(saved.sourceUrl), saved, cache);
    await assert.rejects(response.arrayBuffer(), /incomplete/);
    await settle();
    if (refresh) {
      release.resolve();
      await refresh;
    } else {
      await manager.refresh();
    }
    for (let tries = 0; tries < 40 && manager.active; tries++) await settle();
    if (manager.damage.check) await manager.damage.check;
    assert.equal(manager.active, null, scenario);
    assert.equal(manager.staging?.downloadId, saved.downloadId, scenario);
    assert.deepEqual(manager.staging.completed, [], scenario);
    if (scenario === "marker quota") assert.equal(await cache.match(marker), undefined);
  }
});

test("a damage scan retries from fresh records when its lock wait expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage: caches, baseUrl } = options;
  const files = await caches.open(saved.cacheName);
  await files.put(offlineChunkUrl(baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  const entered = deferred();
  const late = deferred();
  let waitCount = 0;
  let firstSignal;
  options.navigatorObject.locks = { request(name, settings, action) {
    if (settings.ifAvailable || ++waitCount > 1) return locks.request(name, settings, action);
    firstSignal = settings.signal;
    const result = late.promise.then(() => locks.request(name, settings, action));
    entered.resolve();
    return result;
  } };
  const rebuild = t.mock.method(manager.inventory, "inspect");
  const apply = t.mock.method(manager.inventory, "apply");
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.damage.report();
  const firstCheck = manager.damage.check;
  try {
    await entered.promise;
    t.mock.timers.tick(3000);
    await settle();
    assert.equal(firstSignal?.aborted, true);
    assert.notEqual(manager.damage.check, firstCheck);
    await firstCheck;
    await manager.damage.check;
    assert.equal(rebuild.mock.callCount(), 2);
    assert.equal(apply.mock.callCount(), 1);
    assert.equal(manager.active, null);
    assert.equal(manager.staging.downloadId, saved.downloadId);
    assert.equal(manager.damage.pending, false);
    late.resolve();
    await settle();
    assert.equal(apply.mock.callCount(), 1, "a late lock grant cannot apply its earlier scan");
  } finally {
    late.resolve();
    await firstCheck;
    await manager.damage.check;
  }
});

test("damage processing skips cache scans while another tab holds the lock", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const files = await options.cacheStorage.open(saved.cacheName);
  await files.put(offlineChunkUrl(options.baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  const peer = new OfflineManager(options);
  const acquired = deferred();
  const release = deferred();
  const holding = peer.withLock(async () => { acquired.resolve(); await release.promise; });
  const listing = t.mock.method(options.cacheStorage, "keys");
  try {
    await acquired.promise;
    manager.store.reportDamagedChunk(saved.downloadId, 0);
    manager.damage.report();
    await manager.damage.check;
    await settle();
    if (manager.damage.check) await manager.damage.check;
    assert.equal(listing.mock.callCount(), 0);
    assert.equal(manager.damage.pending, true);
    release.resolve();
    await holding;
    t.mock.timers.tick(3000);
    await settle();
    if (manager.damage.check) await manager.damage.check;
    assert.equal(manager.damage.pending, false);
    assert.equal(manager.active, null);
    assert.equal(manager.staging.downloadId, saved.downloadId);
  } finally {
    release.resolve();
    await holding;
  }
});

test("a stalled inventory releases the damage check and retains reports for a fresh scan", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  for (const stage of ["list", "manifest"]) {
    const { manager, options, saved } = await savedBookFixture();
    const { cacheStorage: caches, baseUrl } = options;
    const files = await caches.open(saved.cacheName);
    await files.put(offlineChunkUrl(baseUrl, saved.downloadId, 0),
      new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
    const entered = deferred();
    const release = deferred();
    const listing = caches.keys.bind(caches);
    const match = caches.match.bind(caches);
    let blocked = false;
    let resumed = false;
    let laterReads = 0;
    const list = t.mock.method(caches, "keys", async () => {
      if (stage === "list" && !blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return listing();
    });
    const lookup = t.mock.method(caches, "match", async (key, args) => {
      if (resumed) laterReads++;
      if (stage === "manifest" && !blocked && key === offlineManifestUrl(baseUrl)) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return match(key, args);
    });
    const report = () => {
      manager.store.reportDamagedChunk(saved.downloadId, 0);
      manager.damage.report();
    };
    report();
    const firstCheck = manager.damage.check;
    try {
      await entered.promise;
      if (stage === "list") report();
      t.mock.timers.tick(20_000);
      await settle();
      if (stage === "manifest") {
        assert.equal(manager.damage.check, null);
        assert.equal(manager.damage.pending, true);
        assert.equal(manager.active.downloadId, saved.downloadId);
        report();
        t.mock.timers.tick(3000);
        await settle();
      } else {
        assert.notEqual(manager.damage.check, firstCheck);
      }
      await firstCheck;
      await manager.damage.check;
      assert.equal(manager.active, null, stage);
      assert.equal(manager.damage.pending, false);
      assert.equal(manager.staging.downloadId, saved.downloadId);
      assert.deepEqual(manager.staging.completed, []);
      resumed = true;
      release.resolve();
      await settle();
      assert.equal(laterReads, 0);
    } finally {
      release.resolve();
      await firstCheck;
      await manager.damage.check;
      lookup.mock.restore();
      list.mock.restore();
    }
  }
});

test("a stalled fallback sync releases damage processing and retries pending reports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved, configUrl } = await savedBookFixture();
  const { cacheStorage: caches, baseUrl } = options;
  const files = await caches.open(saved.cacheName);
  await files.put(offlineChunkUrl(baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));

  const listing = caches.keys.bind(caches);
  let shouldFail = true;
  t.mock.method(caches, "keys", async () => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error("Cache listing failed");
    }
    return listing();
  });
  const entered = deferred();
  const release = deferred();
  const match = caches.match.bind(caches);
  let blocked = false;
  let lateBodyReads = 0;
  let lateBodyClosed = false;
  t.mock.method(caches, "match", async (key, args) => {
    if (key !== configUrl || blocked) return match(key, args);
    blocked = true;
    entered.resolve();
    await release.promise;
    return new Response(new ReadableStream({
      pull(controller) {
        lateBodyReads++;
        controller.close();
      },
      cancel() { lateBodyClosed = true; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  });
  const report = () => {
    manager.store.reportDamagedChunk(saved.downloadId, 0);
    manager.damage.report();
  };
  report();
  const firstCheck = manager.damage.check;
  try {
    await entered.promise;
    report();
    t.mock.timers.tick(3000);
    await settle();
    assert.notEqual(manager.damage.check, firstCheck);
    await firstCheck;
    await manager.damage.check;
    assert.equal(manager.damage.pending, false);
    assert.equal(manager.active, null);
    assert.equal(manager.staging.downloadId, saved.downloadId);
    release.resolve();
    await settle();
    assert.equal(lateBodyReads, 0);
    assert.equal(lateBodyClosed, true);
    assert.equal(manager.active, null);
  } finally {
    release.resolve();
    await firstCheck;
    await manager.damage.check;
  }
});

test("a damage report received during player startup is checked after registration", async () => {
  const { options, saved } = await savedBookFixture();
  const messages = new EventTarget();
  const registration = deferred();
  const controller = workerController(options.baseUrl);
  Object.assign(options.navigatorObject.serviceWorker, {
    controller, register: () => registration.promise, addEventListener: messages.addEventListener.bind(messages),
  });
  const manager = new OfflineManager(options);
  const starting = manager.init();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  const marker = globalThis.CompactPlayerOfflineManifest.damagedChunkUrl(options.baseUrl, saved.downloadId, 0);
  await cache.put(chunk, new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  await cache.put(marker, new Response(""));
  messages.dispatchEvent(Object.assign(new Event("message"), { source: controller, data: {
    type: "compact-player-damaged-chunk", scope: options.baseUrl, downloadId: saved.downloadId, index: 0,
  } }));
  registration.resolve({});
  await starting;
  if (manager.damage.check) await manager.damage.check;
  assert.equal(manager.active, null);
  assert.equal(manager.staging?.downloadId, saved.downloadId);
  assert.deepEqual(manager.staging.completed, []);
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
      const repair = await cache.match(offlineMetaUrl(options.baseUrl, "manifest-repair"));
      assert.deepEqual((await repair.json()).manifest, manifest);
      const reread = await reopened.store.inspectBookManifest(manifest.cacheName, manifest);
      assert.equal(reread.repair, null, damage);
      assert.ok((await options.cacheStorage.keys()).includes(manifest.cacheName));
    }
  }
});

test("a stalled automatic manifest repair releases the lock and cannot overwrite a newer manifest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const local = offlineManifestUrl(options.baseUrl);
  const repair = offlineMetaUrl(options.baseUrl, "manifest-repair");
  await cache.delete(local);
  const reached = deferred();
  const release = deferred();
  const put = cache.put.bind(cache);
  let hold = true;
  cache.put = async (url, response) => {
    if (hold && [local, repair].includes(url)) {
      hold = false;
      reached.resolve();
      await release.promise;
    }
    return put(url, response);
  };
  t.after(() => release.resolve());

  let completed = false;
  const refreshing = manager.refresh().then(() => { completed = true; });
  await reached.promise;
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(completed, true);
  assert.equal(heldLocks.size, 0);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);

  const current = { ...saved, episodeTitle: "Updated title" };
  await cache.put(local, Response.json(current));
  release.resolve();
  await settle();
  await refreshing;
  assert.deepEqual(await (await cache.match(local)).json(), current);
  const inspected = await manager.store.inspectBookManifest(saved.cacheName, saved);
  assert.equal(inspected.manifest.episodeTitle, current.episodeTitle);
});

test("a late damage acknowledgment cannot hide a new service worker report", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const { confirmedChunkUrl, damagedChunkUrl, damageVersionHeader } = globalThis.CompactPlayerOfflineManifest;
  const marker = damagedChunkUrl(options.baseUrl, saved.downloadId, 0);
  const ack = confirmedChunkUrl(options.baseUrl, saved.downloadId, 0);
  await cache.put(marker, new Response("", { headers: { [damageVersionHeader]: "original" } }));
  await manager.refresh();
  assert.equal((await cache.match(ack)).headers.get(damageVersionHeader), "original");
  assert.equal((await manager.store.inspectBookManifest(saved.cacheName, saved)).confirmedChunks.size, 0);

  const reached = deferred();
  const release = deferred();
  const put = cache.put.bind(cache);
  await cache.put(marker, new Response("", { headers: { [damageVersionHeader]: "before-new-report" } }));
  cache.put = async (url, response) => {
    if (url === ack) {
      reached.resolve();
      await release.promise;
    }
    return put(url, response);
  };
  t.after(() => release.resolve());
  const refresh = manager.refresh();
  await reached.promise;
  t.mock.timers.tick(3000);
  await refresh;
  assert.equal(heldLocks.size, 0);

  const chunk = offlineChunkUrl(options.baseUrl, saved.downloadId, 0);
  const intact = await cache.match(chunk);
  await cache.put(chunk, new Response(Uint8Array.of(1), { headers: intact.headers }));
  const worker = await workerContext();
  let finish;
  const marked = new Promise((resolve) => { finish = resolve; });
  const response = await worker.cachedMediaResponse(new Request(saved.sourceUrl), saved, cache, finish);
  await assert.rejects(response.arrayBuffer(), /incomplete/);
  await marked;
  const newVersion = (await cache.match(marker)).headers.get(damageVersionHeader);
  assert.ok(newVersion && newVersion !== "before-new-report");

  release.resolve();
  await settle();
  assert.equal((await cache.match(ack)).headers.get(damageVersionHeader), "before-new-report");
  assert.equal((await cache.match(marker)).headers.get(damageVersionHeader), newVersion);
  await manager.refresh();
  assert.equal(manager.active, null);
  assert.equal(manager.staging?.downloadId, saved.downloadId);
});

test("startup reads an unchanged download without writing and a quota error keeps controls available", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved, configUrl } = await savedBookFixture();
  const meta = await nextActiveCache(manager);
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
  await waitForBookCacheRemoval(options.cacheStorage, saved.cacheName);
  assert.equal((await new OfflineManager(options).init()).active, null);
});

test("Remove at full cache quota retires the book before bounded file cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  const caches = options.cacheStorage;
  const candidate = nextActiveCache(manager);
  t.mock.method(candidate, "put", () => { throw new DOMException("Full", "QuotaExceededError"); });
  const list = caches.keys.bind(caches);
  let scansUnderLock = 0;
  t.mock.method(caches, "keys", () => {
    if (heldLocks.size) scansUnderLock++;
    return list();
  });
  const remove = caches.delete.bind(caches);
  const entered = deferred();
  const release = deferred();
  const deleted = deferred();
  t.mock.method(caches, "delete", async (name) => {
    if (name !== saved.cacheName) return remove(name);
    entered.resolve();
    await release.promise;
    const result = await remove(name);
    deleted.resolve();
    return result;
  });
  let finished = false;
  const removing = manager.removeActive().then(() => { finished = true; });
  try {
    await entered.promise;
    await settle();
    assert.equal(scansUnderLock, 0);
    assert.equal(finished, true);
    assert.equal(heldLocks.size, 0);
    assert.equal(manager.active, null);
    const worker = await workerContext({ caches });
    assert.equal(await worker.activeManifest(), null);
    assert.ok(await caches.has(saved.cacheName));
    const other = new OfflineManager(options);
    const next = await other.start({ ...selection(), episodeId: "next" });
    t.mock.timers.tick(3000);
    release.resolve();
    await deleted.promise;
    assert.equal((await worker.activeManifest()).downloadId, next.downloadId);
    assert.ok(await caches.has(next.cacheName));
  } finally {
    release.resolve();
    await removing;
  }
});

test("Remove preserves the saved book if IndexedDB cannot store a removal record", async (t) => {
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage } = options;
  const control = cacheStorage.offlineControl.bind(cacheStorage);
  t.mock.method(cacheStorage, "offlineControl", (baseUrl) => ({
    ...control(baseUrl),
    async write() { throw new DOMException("Full", "QuotaExceededError"); },
  }));
  await assert.rejects(manager.removeActive(), { code: "quota" });
  assert.equal(heldLocks.size, 0);
  assert.equal(manager.active.downloadId, saved.downloadId);
  const worker = await workerContext({ caches: cacheStorage });
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);
  assert.ok(await cacheStorage.has(saved.cacheName));
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
    const repair = await cache.match(offlineMetaUrl(options.baseUrl, "manifest-repair"));
    assert.deepEqual((await repair.json()).manifest, state.staging);
    assert.deepEqual(await reopened.readRecord("staging"), state.staging);
    assert.deepEqual(ranges, []);
    assert.equal((await reopened.resume()).downloadId, staging.downloadId);
    assert.deepEqual(ranges, ["bytes=0-0", ...(damage === "short chunk" ? ["bytes=0-8388607"] : []), "bytes=8388608-8388611"]);
  }
});

test("reopening retries a canceled draft's file cleanup and keeps the ready book", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  manager.fetchImpl = rangedFetch(9 * 1024 ** 2, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(), episodeId: "other" }), /connection lost/);
  const manifest = manager.staging;
  const { cacheName } = manifest;
  const legacy = await options.cacheStorage.open(manager.store.stagingMetaCacheName);
  await legacy.put(offlineMetaUrl(options.baseUrl, "staging"), Response.json({ cacheName, manifest }));
  const attempted = deferred();
  const removeCache = options.cacheStorage.delete.bind(options.cacheStorage);
  const remove = t.mock.method(options.cacheStorage, "delete", (key) => {
    if (key === cacheName) {
      attempted.resolve();
      throw new Error("Deletion interrupted");
    }
    return removeCache(key);
  });
  await manager.cancel();
  await attempted.promise;
  assert.equal(await options.cacheStorage.has(cacheName), true);
  remove.mock.restore();
  const reopened = new OfflineManager(options);
  assert.equal(await reopened.readRecord("staging"), null);
  const state = await reopened.init();
  assert.equal(state.staging, null);
  assert.equal(state.active.downloadId, saved.downloadId);
  await waitForBookCacheRemoval(options.cacheStorage, cacheName);
});

test("a rejected cancellation at full quota leaves the paused download safe for another tab to resume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage: caches, baseUrl } = options;
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "other" }), /connection lost/);
  const draft = manager.staging;
  const { cacheName, downloadId } = draft;
  const openControl = caches.offlineControl.bind(caches);
  const control = t.mock.method(caches, "offlineControl", (url) => {
    const stored = openControl(url);
    return { ...stored, async write(entries, signal) {
      if (entries.staging === null) throw new DOMException("Full", "QuotaExceededError");
      return stored.write(entries, signal);
    } };
  });
  const release = deferred();
  const remove = caches.delete.bind(caches);
  let deletionStarted = false;
  t.mock.method(caches, "delete", async (name) => {
    if (name === cacheName) {
      deletionStarted = true;
      await release.promise;
    }
    return remove(name);
  });

  let failure;
  const canceled = manager.cancel().catch((error) => { failure = error; });
  try {
    await settle();
    t.mock.timers.tick(3000);
    await canceled;
    assert.equal(failure?.code, "quota");
    assert.equal(deletionStarted, false);
    assert.equal(heldLocks.size, 0);
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.equal((await manager.readRecord("staging")).downloadId, downloadId);
    assert.ok(await caches.match(offlineChunkUrl(baseUrl, downloadId, 0), { cacheName }));

    control.mock.restore();
    const other = new OfflineManager({ ...options, fetchImpl: rangedFetch(total) });
    await other.init();
    assert.equal((await other.resume()).downloadId, downloadId);
    release.resolve();
    await settle();
    const worker = await workerContext({ caches });
    const url = new URL(offlineMetaUrl(baseUrl, "audio"));
    url.searchParams.set("download", downloadId);
    const media = await worker.savedAudioResponse(new Request(url, { headers: { Range: "bytes=0-2" } }), url, () => {});
    assert.equal(media.status, 206);
    assert.equal((await media.arrayBuffer()).byteLength, 3);
  } finally { release.resolve(); }
});

test("a rejected cancellation during transfer leaves the download paused and retryable", async (t) => {
  const { manager, options } = await savedBookFixture();
  const { cacheStorage: caches } = options;
  const total = 8 * 1024 ** 2 + 4;
  const entered = deferred();
  const release = deferred();
  const range = rangedFetch(total);
  manager.fetchImpl = async (url, request) => {
    if (request.headers.Range.startsWith("bytes=8388608-")) {
      entered.resolve();
      await release.promise;
    }
    return range(url, request);
  };
  const openControl = caches.offlineControl.bind(caches);
  const control = t.mock.method(caches, "offlineControl", (baseUrl) => {
    const store = openControl(baseUrl);
    return { ...store, async write(entries, signal) {
      if (entries.staging === null) throw new DOMException("Full", "QuotaExceededError");
      return store.write(entries, signal);
    } };
  });
  const download = assert.rejects(manager.start({ ...selection(total), episodeId: "staged" }), { code: "quota" });
  try {
    await entered.promise;
    assert.equal(manager.snapshot().phase, "downloading");
    await assert.rejects(manager.cancel(), { code: "quota" });
    await download;
    assert.equal(manager.snapshot().phase, "paused");
    assert.equal(manager.snapshot().busy, false);
    const paused = await manager.readRecord("staging");
    assert.deepEqual(paused.completed, [0]);
    control.mock.restore();
    release.resolve();
    assert.equal((await manager.resume()).downloadId, paused.downloadId);
  } finally { release.resolve(); }
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
  assert.ok(await caches.has(saved.cacheName));
  blocked.mock.restore();
  await writer.removeActive();
  assert.equal(await writer.readRecord("active"), null);
  await waitForBookCacheRemoval(caches, replacement.cacheName);
  await writer.refresh();
  assert.equal(writer.repairable, null);
  await waitForBookCacheRemoval(caches, saved.cacheName);
});

test("restoring book configuration checks only its cache and releases the lock on timeout or Cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const outcome of ["restore", "timeout", "cancel"]) {
    const { manager, options, saved, configUrl } = await savedBookFixture();
    const { cacheStorage, baseUrl } = options;
    const lock = `compact-player-offline:${baseUrl}`;
    const cache = await cacheStorage.open(saved.cacheName);
    await cache.delete(configUrl);
    await manager.refresh();
    assert.equal(manager.repairable?.downloadId, saved.downloadId);

    const neverList = deferred();
    const check = deferred();
    const keys = cacheStorage.keys.bind(cacheStorage);
    const has = cacheStorage.has.bind(cacheStorage);
    let listsUnderLock = 0;
    let held = false;
    const listing = t.mock.method(cacheStorage, "keys", () => {
      if (!heldLocks.has(lock)) return keys();
      listsUnderLock++;
      return neverList.promise;
    });
    const presence = t.mock.method(cacheStorage, "has", (name) => {
      if (outcome === "restore" || name !== saved.cacheName || held || !heldLocks.has(lock)) return has(name);
      held = true;
      return check.promise;
    });
    let restored;
    let failure;
    const repairing = manager.repairConfig().then(
      (manifest) => { restored = manifest; }, (error) => { failure = error; },
    );
    let canceling;
    try {
      await settle();
      assert.equal(listsUnderLock, 0, outcome);
      if (outcome === "restore") {
        await repairing;
        assert.equal(restored?.downloadId, saved.downloadId);
        assert.ok(await cache.match(offlineConfigCacheUrl(baseUrl, restored)));
        continue;
      }
      assert.equal(held, true, outcome);
      if (outcome === "cancel") canceling = manager.cancel();
      else t.mock.timers.tick(3000);
      await settle();
      assert.equal(heldLocks.has(lock), false, outcome);
      if (outcome === "cancel") assert.equal(failure?.name, "AbortError");
      else assert.equal(failure?.code, "storage-read-timeout");
      await canceling;
      assert.equal(manager.repairable?.downloadId, saved.downloadId);
      const other = new OfflineManager(options);
      await other.reset();
      check.resolve(true);
      await settle();
      assert.equal(await cache.match(configUrl), undefined, outcome);
      assert.equal(await other.readRecord("active"), null, outcome);
    } finally {
      listing.mock.restore();
      presence.mock.restore();
      neverList.resolve(await keys());
      check.resolve(true);
      await repairing;
      await canceling;
    }
  }
});

test("an older controlling worker can read a legacy download while the player waits to enable new writes", async () => {
  const { options, saved } = await savedBookFixture();
  const { cacheStorage, baseUrl } = options;
  const { activeCacheName } = globalThis.CompactPlayerOfflineManifest;
  cacheStorage.controlRecords.clear();
  const legacy = await cacheStorage.open(activeCacheName(baseUrl, 0));
  await legacy.put(offlineMetaUrl(baseUrl, "active"), Response.json({ revision: 1, cacheName: saved.cacheName, manifest: saved }));

  const workers = new EventTarget();
  workers.controller = workerController(baseUrl, "sw.js?v=19", {});
  workers.register = async () => ({});
  workers.ready = Promise.resolve({});
  const manager = new OfflineManager({ ...options, navigatorObject: { ...options.navigatorObject, serviceWorker: workers } });
  const state = await manager.init();
  assert.equal(state.active?.downloadId, saved.downloadId);
  assert.equal(state.canWrite, false);
  assert.ok(manager.routes.savedAudio(saved));
  await assert.rejects(manager.start({ ...selection(), episodeId: "next" }), { code: "unsupported" });
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(cacheStorage.controlRecords.size, 0);

  workers.controller = workerController(baseUrl, "sw.js?v=25");
  workers.dispatchEvent(new Event("controllerchange"));
  assert.equal(await manager.worker.supportsOfflineWrites(), true);
  const newBook = await manager.start({ ...selection(), episodeId: "next" });
  assert.equal((await manager.readRecord("active")).downloadId, newBook.downloadId);
});

test("an outside service worker blocks offline writes until the installation's worker takes control", async () => {
  const baseUrl = "https://example.test/books/";
  const workers = new EventTarget();
  workers.controller = workerController("https://example.test/");
  workers.register = async () => ({});
  workers.ready = Promise.resolve({});
  const cacheStorage = new MemoryCacheStorage();
  const selected = { ...selection(), sourceUrl: new URL("audio.webm", baseUrl).href };
  const manager = new OfflineManager({ baseUrl, cacheStorage,
    navigatorObject: { ...navigatorStub(), serviceWorker: workers }, fetchImpl: rangedFetch(10) });
  await manager.init();
  assert.equal(manager.snapshot().supported, true);
  assert.equal(manager.snapshot().canWrite, false);
  await assert.rejects(manager.start(selected), { code: "unsupported" });
  assert.equal(await manager.readRecord("active"), null);

  workers.controller = workerController(baseUrl);
  workers.dispatchEvent(new Event("controllerchange"));
  assert.equal(await manager.worker.supportsOfflineWrites(), true);
  const saved = await manager.start(selected);
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
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

test("download controls recover after a worker setup timeout when this installation takes control", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const config = { id: "book", defaultLanguage: "en", languages: { en: { sources: { mp3: { 64: "audio.mp3" } } } } };
  const baseUrl = "https://example.test/listen/";

  for (const failure of ["register timeout", "ready timeout", "storage denied", "registration denied", "controlling worker"]) {
    const deferredSetup = deferred();
    const workers = new EventTarget();
    const trusted = workerController(baseUrl, "sw.js?v=25");
    workers.register = async () => {
      if (failure === "registration denied") throw new DOMException("Worker denied", "SecurityError");
      if (failure === "register timeout" || failure === "controlling worker") return deferredSetup.promise;
      return {};
    };
    workers.ready = failure === "ready timeout" ? deferredSetup.promise : Promise.resolve({});
    const cacheStorage = new MemoryCacheStorage();
    if (failure === "storage denied") cacheStorage.keys = async () => { throw new DOMException("Cache denied", "SecurityError"); };
    const page = await openPlayerPage(config, assert.fail, new Map(), {
      caches: cacheStorage,
      location: new URL(baseUrl),
      navigator: { ...navigatorStub(), serviceWorker: workers },
    });
    await page.ready;
    const row = page.elements.get("offlineRow");
    const takeControl = async (worker) => {
      workers.controller = worker;
      workers.dispatchEvent(new Event("controllerchange"));
      await settle();
    };
    if (failure === "controlling worker") await takeControl(trusted);
    t.mock.timers.tick(8000);
    await settle();
    assert.equal(row.hidden, failure !== "controlling worker", failure);
    if (failure === "controlling worker") continue;

    const foreign = { scriptURL: "https://example.test/other/sw.js?v=25" };
    await takeControl(foreign);
    assert.equal(row.hidden, true, "another installation cannot restore download controls");
    workers.controller = trusted;
    workers.dispatchEvent(new Event("controllerchange"));
    await takeControl(foreign);
    assert.equal(row.hidden, true, "a replaced controller cannot finish recovery");
    await takeControl(trusted);
    const shouldRecover = failure.endsWith("timeout");
    assert.equal(row.hidden, !shouldRecover, failure);
    if (shouldRecover) assert.equal(page.elements.get("offlineDownloadBtn").disabled, false);
    deferredSetup.resolve({});
  }
});

test("an unreadable cache preserves the server response and the original network failure", async () => {
  let reads = 0;
  const forbidden = new Response("Forbidden", { status: 403 });
  const offline = new TypeError("Offline");
  const worker = await workerContext({
    fetch: async () => forbidden,
    caches: { match: async () => { reads++; throw new Error("Unreadable cache"); } },
  });
  const request = new Request("https://example.test/media/book/book.json");
  assert.equal(await worker.networkFirst(request), forbidden);
  assert.equal(reads, 2);
  worker.fetch = async () => { throw offline; };
  await assert.rejects(worker.networkFirst(request), (error) => error === offline);
  assert.equal(reads, 4);
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
  const ready = await waitForRecord(() => reloaded.readRecord("active"), (record) => record?.downloadId === saved.downloadId);
  await settle();
  assert.equal(ready?.downloadId, saved.downloadId);
  assert.equal(restore.hidden, true);
  assert.deepEqual(await (await cache.match(chunk)).arrayBuffer(), original);
  assert.deepEqual(await (await cache.match(offlineConfigCacheUrl(options.baseUrl, ready))).json(), config);
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
  const status = await waitForRecord(() => elements.get("offlineStatus").textContent, (text) => text.startsWith("Downloaded:"));
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(progress.value, 50);
  assert.match(status, /Downloaded: Book.*Other book.*paused at 50%/);
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

for (const target of ["complete draft", "saved book"]) test(`a late config write cannot replace the published repair of a ${target}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const draft = target === "complete draft";
  const { manager, options, saved, configUrl, config } = draft ? await interruptedReplacement(t) : await savedBookFixture();
  const copy = draft ? manager.staging : saved;
  const cache = await options.cacheStorage.open(copy.cacheName);
  await cache.delete(configUrl);
  if (!draft) await manager.refresh();
  const repair = () => draft ? manager.resume() : manager.repairConfig();
  const writing = deferred();
  const release = deferred();
  const finished = deferred();
  let firstKey;
  t.after(release.resolve);
  const put = cache.put.bind(cache);
  const stall = t.mock.method(cache, "put", async (url, response) => {
    if (url === configUrl || new URL(url).pathname.includes("/__compact_player_offline__/config/")) {
      firstKey = url;
      writing.resolve();
      await release.promise;
      await put(url, response);
      finished.resolve();
      return;
    }
    return put(url, response);
  });
  const requests = [];
  let title = "Before timeout";
  manager.fetchImpl = (url) => { requests.push(url); return Response.json({ ...config, title: { en: title } }); };

  const failed = assert.rejects(repair(), { code: "storage-timeout" });
  await writing.promise;
  t.mock.timers.tick(20_000);
  await failed;
  if (draft) {
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    assert.equal((await manager.readRecord("staging")).downloadId, copy.downloadId);
  } else assert.equal(manager.snapshot().repairable.downloadId, copy.downloadId);
  assert.ok(await cache.match(offlineChunkUrl(options.baseUrl, copy.downloadId, 0)));
  assert.equal(heldLocks.size, 0);

  stall.mock.restore();
  title = "Successful retry";
  const repaired = await repair();
  assert.equal(repaired.downloadId, copy.downloadId);
  assert.deepEqual(requests, [configUrl, configUrl]);
  release.resolve();
  await finished.promise;
  const worker = await workerContext({ caches: options.cacheStorage });
  const response = await worker.cachedBookResponse(new Request(configUrl));
  assert.equal((await response.json()).title.en, "Successful retry");
  assert.equal(await cache.match(firstKey), undefined);
});

test("a peer can finish an intact draft offline after the writer releases the lock", async (t) => {
  const { manager, options, selected } = await savedBookFixture();
  const reader = new OfflineManager({ ...options, fetchImpl: assert.fail });
  await reader.init();
  const replacement = { ...selected, sourceId: "mp3-64", mime: "audio/mpeg",
    sourceUrl: new URL("alternate.mp3", selected.sourceUrl).href };
  const meta = await nextActiveCache(manager);
  const put = meta.put.bind(meta);
  const failure = t.mock.method(meta, "put", (key, value) => {
    if (key.endsWith("/active.json")) throw new Error("Active record write failed");
    return put(key, value);
  });
  await assert.rejects(manager.start(replacement), /Active record write failed/);
  failure.mock.restore();
  options.navigatorObject.onLine = false;
  await reader.syncPublishedDownload();
  const state = reader.snapshot();
  assert.equal(state.progress, 1);
  assert.equal(state.canFinishOffline, true);
  assert.equal((await reader.resume()).downloadId, state.staging.downloadId);
});

test("reset in another tab invalidates a draft while its offline completion is being checked", async (t) => {
  const { manager, options } = await interruptedReplacement(t);
  const reader = new OfflineManager(options);
  const checked = deferred();
  const release = deferred();
  const completionFor = reader.store.completionFor.bind(reader.store);
  t.mock.method(reader.store, "completionFor", async (...args) => {
    const completion = await completionFor(...args);
    assert.equal(completion.status, "ready");
    checked.resolve();
    await release.promise;
    return completion;
  });

  const syncing = reader.syncPublishedDownload();
  try {
    await checked.promise;
    await manager.reset();
  } finally { release.resolve(); }
  await syncing;
  assert.equal(reader.snapshot().active, null);
  assert.equal(reader.snapshot().staging, null);
  assert.equal(reader.snapshot().canFinishOffline, false);
});

test("a peer still reads the published download when it cannot check the draft lock", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await interruptedReplacement(t);
  const navigator = { ...options.navigatorObject, locks: {
    request: async () => { throw new DOMException("Write lock unavailable", "SecurityError"); },
  } };
  const reader = new OfflineManager({ ...options, navigatorObject: navigator });
  t.after(() => reader.tabSync.updateLockStatus("free"));

  await reader.syncPublishedDownload();
  assert.equal(reader.snapshot().active?.downloadId, saved.downloadId);
  assert.equal(reader.snapshot().staging?.downloadId, manager.staging.downloadId);
  assert.equal(reader.snapshot().canWrite, false);
  assert.equal(reader.snapshot().writeLockBusy, false);
  assert.equal(reader.snapshot().canFinishOffline, false);
  assert.equal(reader.tabSync.retry, null);
});

test("a timed-out draft check still updates the published download in the reading tab", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await interruptedReplacement(t);
  const reader = new OfflineManager(options);
  const checking = deferred();
  const delayed = deferred();
  const check = t.mock.method(reader.store, "completionFor", () => {
    checking.resolve();
    return delayed.promise;
  });
  const pending = reader.syncPublishedDownload();
  try {
    await checking.promise;
    t.mock.timers.tick(3000);
    await pending;
    assert.equal(reader.snapshot().active?.downloadId, saved.downloadId);
    assert.equal(reader.snapshot().canFinishOffline, false);
  } finally { delayed.resolve(null); }

  check.mock.restore();
  await reader.syncPublishedDownload();
  assert.equal(reader.snapshot().staging?.downloadId, manager.staging.downloadId);
  assert.equal(reader.snapshot().canFinishOffline, true);
});

test("inventory reads the active and staging records from the same publication", async (t) => {
  const { manager, options, saved } = await interruptedReplacement(t);
  const draft = manager.staging;
  const read = deferred();
  const release = deferred();
  let firstRead = true;
  const pause = async (records) => {
    if (!firstRead) return records;
    firstRead = false;
    read.resolve();
    await release.promise;
    return records;
  };
  const getControl = options.cacheStorage.offlineControl.bind(options.cacheStorage);
  t.mock.method(options.cacheStorage, "offlineControl", (url) => {
    const control = getControl(url);
    return { ...control,
      async read(key, signal) {
        const value = await control.read(key, signal);
        return key === "active" ? pause(value) : value;
      },
      async readMany(keys, signal) { return pause(await control.readMany(keys, signal)); },
    };
  });
  const reader = new OfflineManager(options);
  const records = reader.inventory.readRecords();
  try {
    await read.promise;
    assert.equal((await manager.resume()).downloadId, draft.downloadId);
  } finally { release.resolve(); }
  const previous = await records;
  assert.equal(previous.saved.downloadId, saved.downloadId);
  assert.equal(previous.staging?.downloadId, draft.downloadId);
  const current = await reader.inventory.readRecords();
  assert.equal(current.saved.downloadId, draft.downloadId);
  assert.equal(current.staging, null);
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
    const meta = await nextActiveCache(manager);
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
    const failKey = failAt === "staging record" ? manager.store.stagingMetaCacheName : saved.cacheName;
    const remove = storage.delete.bind(storage);
    const attempted = deferred();
    const failure = t.mock.method(storage, "delete", async (key) => {
      if (key === failKey) {
        attempted.resolve();
        throw new DOMException("Delete failed", "UnknownError");
      }
      return remove(key);
    });
    const ready = await manager.start(replacement, await manager.inspectSource(replacement));
    assert.equal(manager.phase, "ready");
    assert.equal((await manager.readRecord("active")).downloadId, ready.downloadId);
    if (failAt === "previous cache") await attempted.promise;
    else {
      assert.equal(await manager.readRecord("staging"), null);
      assert.ok(!failure.mock.calls.some(({ arguments: [key] }) => key === failKey));
    }
    failure.mock.restore();
    const reopened = new OfflineManager(options);
    await reopened.init();
    assert.equal(reopened.active.downloadId, ready.downloadId);
    assert.equal(await reopened.readRecord("staging"), null);
    await waitForBookCacheRemoval(storage, saved.cacheName);
  }
});

test("startup keeps the published replacement usable when clearing staging fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await interruptedReplacement(t);
  const replacement = manager.staging;
  const storage = options.cacheStorage;
  const remove = storage.delete.bind(storage);
  const failure = t.mock.method(storage, "delete", (key) => {
    if (key === manager.store.stagingMetaCacheName) throw new Error("Cleanup interrupted");
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
  const match = t.mock.method(cacheStorage, "match");
  const readState = t.mock.fn(contract.readActiveState);
  const chunkUrl = t.mock.fn(contract.offlineChunkUrl);
  const worker = await workerContext({ caches: cacheStorage, self: { registration: { scope }, addEventListener() {} } },
    (format) => ({ ...format, readActiveState: readState, offlineChunkUrl: chunkUrl }));
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);
  const response = await worker.cachedBookResponse(new Request(saved.sourceUrl, { headers: { range: "bytes=2-4" } }));
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 3);
  assert.equal(readState.mock.calls[0].arguments[0], scope);
  assert.equal(match.mock.callCount(), 0);
  await useCachedActiveRecord(manager);
  assert.equal((await worker.activeManifest()).downloadId, saved.downloadId);
  const [activeUrl, query] = match.mock.calls[0].arguments;
  assert.equal(activeUrl, contract.offlineMetaUrl(scope, "active"));
  assert.ok(query.cacheName.startsWith(contract.activeCandidatePrefix(scope)));
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

test("an expired background lock request aborts an IndexedDB upgrade that starts later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager } = await savedBookFixture();
  const request = { transaction: { abort: t.mock.fn() }, result: { close: t.mock.fn() } };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open: () => request } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else delete globalThis.indexedDB;
  });
  manager.navigator.locks = undefined;
  const waiting = assert.rejects(manager.withLock(assert.fail, undefined, 3000), { name: "TimeoutError" });
  await settle();
  t.mock.timers.tick(3000);
  await waiting;
  request.onupgradeneeded();
  request.error = new DOMException("Aborted", "AbortError");
  request.onerror();
  await settle();
  assert.equal(request.transaction.abort.mock.callCount(), 1);
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

test("worker registration uses the current version without cached imports", async () => {
  const navigator = navigatorStub();
  const calls = [];
  navigator.serviceWorker.register = async (script, options) => { calls.push({ script, options }); return {}; };
  const manager = new OfflineManager({ baseUrl: "https://example.test/player/", cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigator, fetchImpl: async () => new Response(null, { status: 404 }) });
  await manager.init();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script.href, "https://example.test/player/sw.js?v=25");
  assert.deepEqual(calls[0].options, { scope: "/player/", updateViaCache: "none" });
});

function isolatedOfflineNavigator(navigator) {
  const suffix = globalThis.crypto.randomUUID();
  return { ...navigator, onLine: false, locks: {
    request: (name, options, action) => navigator.locks.request(name + suffix, options, action),
  } };
}

async function activeRecordLookup(manager) {
  const journalCacheName = await useCachedActiveRecord(manager);
  const activeUrl = offlineMetaUrl(manager.baseUrl, "active");
  return (url, options) => url === activeUrl && options.cacheName === journalCacheName;
}

test("offline startup opens a published legacy book while cache maintenance is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { config, configUrl, options, saved } = await savedBookFixture("episode.json");
  const cache = await options.cacheStorage.open(saved.cacheName);
  const inventory = deferred();
  const listing = t.mock.method(options.cacheStorage, "keys", () => inventory.promise);
  const navigator = isolatedOfflineNavigator(options.navigatorObject);
  const page = await openPlayerPage(config, assert.fail, new Map(), {
    caches: options.cacheStorage, navigator,
    fetch: async (url) => await cache.match(url) || new Response(null, { status: 404 }),
  });
  const title = page.elements.get("bookTitle");
  const play = page.elements.get("playPauseBtn");
  try {
    for (let attempt = 0; attempt < 40 && play.disabled; attempt++) await settle();
    assert.ok(listing.mock.callCount() > 0);
    assert.equal(title.textContent, "Saved book");
    assert.equal(play.disabled, false);
    play.dispatchEvent(new Event("click"));
    assert.equal(page.audio.src, new URL("audio.webm", configUrl).href);
    page.audio.dispatchEvent(new Event("playing"));
  } finally {
    inventory.resolve([saved.cacheName]);
    await page.ready;
  }
});

test("reconnecting during a pending offline startup opens the live book before cache reads finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, config, options } = await savedBookFixture();
  const isActiveRecord = await activeRecordLookup(manager);
  const onlineBook = { ...config, id: "live", title: { en: "Live book" } };
  const stored = deferred();
  const match = options.cacheStorage.match.bind(options.cacheStorage);
  t.mock.method(options.cacheStorage, "match", async (url, cacheOptions) => {
    if (isActiveRecord(url, cacheOptions)) await stored.promise;
    return match(url, cacheOptions);
  });
  const navigator = isolatedOfflineNavigator(options.navigatorObject);
  const page = await openPlayerPage(onlineBook, assert.fail, new Map(), {
    caches: options.cacheStorage, navigator,
    fetch: (url) => {
      assert.equal(navigator.onLine, true);
      if (url.endsWith("/library.json")) return Response.json({ books: [{ id: "live" }], ui: { onboardingEnabled: false } });
      return Response.json(url.endsWith("/live/book.json") ? onlineBook : config);
    },
  });
  const title = page.elements.get("bookTitle");
  navigator.onLine = true;
  page.window.dispatchEvent(new Event("online"));
  try {
    for (let attempt = 0; attempt < 40 && title.textContent !== "Live book"; attempt++) await settle();
    assert.equal(title.textContent, "Live book");
    assert.equal(page.elements.get("playPauseBtn").disabled, false);
  } finally {
    stored.resolve();
    await page.ready;
  }
  for (let attempt = 0; attempt < 5; attempt++) await settle();
  assert.equal(title.textContent, "Live book");
});

test("a focus event cannot invalidate the published download read needed for offline startup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, config, options, saved } = await savedBookFixture("episode.json");
  const isActiveRecord = await activeRecordLookup(manager);
  const cache = await options.cacheStorage.open(saved.cacheName);
  const first = deferred();
  const later = deferred();
  const match = options.cacheStorage.match.bind(options.cacheStorage);
  let reads = 0;
  t.mock.method(options.cacheStorage, "match", async (url, cacheOptions) => {
    if (isActiveRecord(url, cacheOptions)) await (++reads === 1 ? first : later).promise;
    return match(url, cacheOptions);
  });
  const navigator = isolatedOfflineNavigator(options.navigatorObject);
  const page = await openPlayerPage(config, assert.fail, new Map(), {
    caches: options.cacheStorage, navigator,
    fetch: async (url) => await cache.match(url) || new Response(null, { status: 404 }),
  });
  try {
    assert.equal(reads, 1);
    page.window.dispatchEvent(new Event("focus"));
    first.resolve();
    await page.ready;
    assert.equal(page.elements.get("bookTitle").textContent, "Saved book");
    assert.equal(page.elements.get("playPauseBtn").disabled, false);
  } finally {
    first.resolve();
    later.resolve();
    await settle();
  }
});

test("offline startup stops waiting when the published download read exceeds its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, config, options } = await savedBookFixture();
  const isActiveRecord = await activeRecordLookup(manager);
  const reading = deferred();
  const pending = deferred();
  const match = options.cacheStorage.match.bind(options.cacheStorage);
  t.mock.method(options.cacheStorage, "match", async (url, cacheOptions) => {
    if (isActiveRecord(url, cacheOptions)) {
      reading.resolve();
      await pending.promise;
    }
    return match(url, cacheOptions);
  });
  const navigator = isolatedOfflineNavigator(options.navigatorObject);
  const page = await openPlayerPage(config, assert.fail, new Map(), { caches: options.cacheStorage, navigator });
  const play = page.elements.get("playPauseBtn");
  try {
    await reading.promise;
    assert.equal(play.disabled, true);
    t.mock.timers.tick(3000);
    for (let attempt = 0; attempt < 40 && play.disabled; attempt++) await settle();
    assert.equal(play.disabled, false);
    assert.equal(page.elements.get("bookTitle").textContent, "Saved book");
  } finally {
    pending.resolve();
    await page.ready;
  }
});

test("late startup maintenance preserves a newly published download", async (t) => {
  const { manager, config, configUrl, options, saved } = await savedBookFixture();
  const inventory = deferred();
  const startedListing = deferred();
  t.mock.method(options.cacheStorage, "keys", () => {
    startedListing.resolve();
    return inventory.promise;
  });
  const reader = new OfflineManager(options);
  const boot = reader.init();
  try {
    await startedListing.promise;
    assert.equal(reader.snapshot().active.downloadId, saved.downloadId);
    const replacement = { ...saved, downloadId: "replacement", cacheName: saved.cacheName + "-replacement" };
    const cache = await options.cacheStorage.open(replacement.cacheName);
    await cache.put(configUrl, Response.json(config));
    await manager.writeRecord("active", replacement);
    inventory.resolve([saved.cacheName]);

    assert.equal((await boot).active.downloadId, replacement.downloadId);
    assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
  } finally {
    inventory.resolve([saved.cacheName]);
    await boot;
  }
});

test("refresh and damage scans let another tab remove a download while inventory waits", async (t) => {
  for (const reason of ["refresh", "damage report"]) {
    const { manager, options, saved } = await savedBookFixture();
    const reader = new OfflineManager(options);
    await reader.init();
    const inventory = deferred();
    const started = deferred();
    const list = t.mock.method(options.cacheStorage, "keys", () => {
      started.resolve();
      return inventory.promise;
    });
    let scanning;
    if (reason === "damage report") {
      reader.damage.pending = true;
      reader.store.reportDamagedChunk(saved.downloadId, 0);
      reader.damage.resume();
      scanning = reader.damage.check;
    } else {
      scanning = reader.refresh();
    }
    try {
      await started.promise;
      await manager.removeActive();
      assert.equal(await manager.readRecord("active"), null, reason);
    } finally {
      inventory.resolve([saved.cacheName]);
      list.mock.restore();
      await scanning;
    }
    assert.equal(reader.snapshot().active, null, reason);
    await waitForBookCacheRemoval(options.cacheStorage, saved.cacheName);
  }
});

test("starting a download releases the writer on a stalled record read after timeout or Cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["deadline", "cancel"]) {
    const { manager, options, saved } = await savedBookFixture();
    const isActiveRecord = await activeRecordLookup(manager);
    const { cacheStorage, baseUrl } = options;
    const lock = `compact-player-offline:${baseUrl}`;
    const reached = deferred();
    const release = deferred();
    const match = cacheStorage.match.bind(cacheStorage);
    let blocked = false;
    let lateBodyReads = 0;
    const reader = t.mock.method(cacheStorage, "match", async (url, lookup) => {
      const response = await match(url, lookup);
      if (!isActiveRecord(url, lookup) || !response || blocked || !heldLocks.has(lock)) return response;
      blocked = true;
      reached.resolve();
      await release.promise;
      return { text() { lateBodyReads++; return response.text(); } };
    });
    const download = manager.start({ ...selection(), episodeId: "blocked-download" });
    let downloadError;
    const ending = download.catch((error) => { downloadError = error; });
    let canceled;
    try {
      await reached.promise;
      if (failure === "cancel") canceled = manager.cancel();
      else t.mock.timers.tick(3000);
      await settle();
      await settle();
      assert.equal(heldLocks.has(lock), false, failure);
      if (failure === "deadline") assert.equal(downloadError?.code, "storage-read-timeout");
      else assert.equal(downloadError?.name, "AbortError");
      await canceled;
      assert.equal(manager.snapshot().active.downloadId, saved.downloadId, failure);
      assert.equal(await manager.readRecord("staging"), null, failure);
      const other = new OfflineManager(options);
      await other.reset();
      const replacement = await other.start({ ...selection(), episodeId: "other-tab" });
      release.resolve();
      await settle();
      assert.equal(lateBodyReads, 0, failure);
      assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId, failure);
    } finally {
      release.resolve();
      await ending;
      await canceled;
      reader.mock.restore();
    }
  }
});

test("a stalled final inventory check releases the reset lock and drops late reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  for (const stall of ["staging record", "scoped staging lookup", "legacy staging lookup", "local manifest"]) {
    const { manager, options, saved } = await savedBookFixture();
    const cacheStorage = options.cacheStorage;
    const manifestUrl = offlineManifestUrl(options.baseUrl);
    const staging = { ...saved, status: "downloading", downloadId: "partial", completed: [], downloadedAt: 0,
      cacheName: saved.cacheName.slice(0, -saved.downloadId.length) + "partial" };
    if (stall !== "local manifest") {
      const cache = await cacheStorage.open(staging.cacheName);
      await cache.put(manifestUrl, Response.json(staging));
      if (stall === "staging record") {
        await manager.writeRecord("staging", staging);
      } else {
        cacheStorage.controlRecords.delete(new URL(options.baseUrl).pathname + "\0staging");
        const metadata = stall === "scoped staging lookup" ? await cacheStorage.open(manager.store.stagingMetaCacheName) : await manager.metaCache();
        await metadata.put(offlineMetaUrl(options.baseUrl, "staging"), Response.json({ cacheName: staging.cacheName, manifest: staging }));
      }
    } else {
      await (await cacheStorage.open(saved.cacheName)).delete(manifestUrl);
    }

    const lock = `compact-player-offline:${options.baseUrl}`;
    const reachedCheck = deferred();
    const unblock = deferred();
    const match = cacheStorage.match.bind(cacheStorage);
    let blocked = false;
    let followedLateRead = false;
    let lateChecks = 0;
    let bodyReads = 0;
    const openControl = cacheStorage.offlineControl.bind(cacheStorage);
    const control = t.mock.method(cacheStorage, "offlineControl", (baseUrl) => {
      const stored = openControl(baseUrl);
      return { ...stored, async readMany(keys, signal) {
        const value = await stored.readMany(keys, signal);
        if (stall === "staging record" && keys.includes("staging") && !blocked && heldLocks.has(lock)) {
          blocked = true;
          reachedCheck.resolve();
          await unblock.promise;
        }
        return value;
      } };
    });
    const reader = t.mock.method(cacheStorage, "match", async (url, request) => {
      if (followedLateRead) lateChecks++;
      const target = stall === "local manifest" ? url === manifestUrl && request.cacheName === saved.cacheName
        : stall.endsWith(" lookup") && url === offlineMetaUrl(options.baseUrl, "staging")
          && request.cacheName === (stall === "scoped staging lookup" ? manager.store.stagingMetaCacheName : OFFLINE_META_CACHE);
      const response = await match(url, request);
      if (!target || blocked || !heldLocks.has(lock)) return response;
      blocked = true;
      reachedCheck.resolve();
      await unblock.promise;
      return response && { text() { bodyReads++; return response.text(); } };
    });
    const has = cacheStorage.has.bind(cacheStorage);
    const existence = t.mock.method(cacheStorage, "has", (name) => {
      if (followedLateRead) lateChecks++;
      return has(name);
    });

    const refreshing = manager.refresh();
    try {
      await reachedCheck.promise;
      t.mock.timers.tick(3000);
      await settle();
      await manager.reset();
      await refreshing;
      assert.equal(manager.snapshot().supported, true, stall);
      followedLateRead = true;
      unblock.resolve();
      await settle();
      assert.equal(bodyReads, 0, stall);
      assert.equal(lateChecks, 0, stall);
      assert.equal(manager.snapshot().active, null, stall);
      assert.ok(!(await cacheStorage.keys()).includes(saved.cacheName), stall);
    } finally {
      unblock.resolve();
      await refreshing;
      control.mock.restore();
      reader.mock.restore();
      existence.mock.restore();
    }
  }
});

test("Reset at full Cache Storage invalidates the saved book and draft before cleanup", async (t) => {
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage, baseUrl } = options;
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "draft" }), /connection lost/);
  const draft = manager.staging;
  const candidate = nextActiveCache(manager);
  t.mock.method(candidate, "put", () => { throw new DOMException("Full", "QuotaExceededError"); });
  const physical = cacheStorage.delete.bind(cacheStorage);
  const entered = deferred();
  const release = deferred();
  t.mock.method(cacheStorage, "delete", async (name) => {
    if (name === saved.cacheName) {
      entered.resolve();
      await release.promise;
    }
    return physical(name);
  });
  const resetting = manager.reset();
  try {
    await Promise.race([entered.promise, resetting]);
    assert.equal(heldLocks.size, 0);
    assert.equal(manager.active, null);
    assert.equal(manager.staging, null);
    const worker = await workerContext({ caches: cacheStorage });
    assert.equal(await worker.activeManifest(), null);
    assert.equal(await manager.readRecord("staging", true), null);
    assert.ok(await cacheStorage.has(saved.cacheName));
    const { resetId } = await cacheStorage.offlineControl(baseUrl).read("active");
    assert.ok(resetId);

    const other = new OfflineManager(options);
    const next = await other.start({ ...selection(), episodeId: "after-reset" });
    assert.ok(next.downloadId.startsWith(resetId + "."));
    release.resolve();
    await resetting;
    assert.equal((await worker.activeManifest()).downloadId, next.downloadId);
    assert.equal(await cacheStorage.has(draft.cacheName), false);
    assert.ok(await cacheStorage.has(next.cacheName));
  } finally { release.resolve(); }
});

test("Reset hides the saved book before cache cleanup finishes and protects a later download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  for (const scenario of ["stalled listing", "newer reset", "stalled deletion", "evicted reset marker"]) {
    const method = scenario === "stalled deletion" ? "delete" : "keys";
    const { manager, options, saved } = await savedBookFixture();
    const { cacheStorage } = options;
    const legacy = await manager.metaCache();
    const activeUrl = offlineMetaUrl(options.baseUrl, "active");
    await legacy.put(activeUrl, Response.json({ cacheName: saved.cacheName, manifest: saved }));
    const reachedCleanup = deferred();
    const unblock = deferred();
    const perform = cacheStorage[method].bind(cacheStorage);
    let blocked = false;
    const cleanup = t.mock.method(cacheStorage, method, async (...args) => {
      if (!blocked && (method === "keys" || args[0] === saved.cacheName)) {
        blocked = true;
        reachedCleanup.resolve();
        await unblock.promise;
      }
      return perform(...args);
    });
    const worker = await workerContext({ caches: cacheStorage });
    let resetDone = false;
    const resetting = manager.reset().then(() => { resetDone = true; });
    try {
      await reachedCleanup.promise;
      assert.equal(await manager.readRecord("active"), null, scenario);
      assert.equal(await worker.activeManifest(), null, scenario);
      assert.equal(await legacy.match(activeUrl), undefined, scenario);
      if (scenario === "evicted reset marker") {
        const { journalCacheName } = await manager.store.readActiveState();
        await cacheStorage.delete(journalCacheName);
        assert.equal(await manager.readRecord("active"), null, scenario);
        assert.equal(await worker.activeManifest(), null, scenario);
      }
      const other = new OfflineManager(options);
      if (scenario === "newer reset") await other.reset();
      const replacement = await other.start({ ...selection(), episodeId: "after-reset" });
      assert.equal((await worker.activeManifest()).downloadId, replacement.downloadId, scenario);

      if (method === "delete") {
        t.mock.timers.tick(3000);
        await settle();
        assert.equal(resetDone, true, "Reset finishes even if deletion is still pending");
      }
      unblock.resolve();
      await resetting;
      await settle();
      assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId, scenario);
      assert.ok((await cacheStorage.keys()).includes(replacement.cacheName), scenario);
      assert.ok(!(await cacheStorage.keys()).includes(saved.cacheName), scenario);
    } finally {
      unblock.resolve();
      await resetting;
      cleanup.mock.restore();
    }
  }
});

test("publication completes before a stalled cache deletion and leaves other offline writes available", async (t) => {
  for (const nextAction of ["download", "reset", "cache loss"]) {
    const { manager, options, saved } = await savedBookFixture();
    const { cacheStorage } = options;
    const cleaning = deferred();
    const release = deferred();
    const deleted = deferred();
    const remove = cacheStorage.delete.bind(cacheStorage);
    let blocked = false;
    const deletion = t.mock.method(cacheStorage, "delete", async (name) => {
      if (name !== saved.cacheName || blocked) return remove(name);
      blocked = true;
      cleaning.resolve();
      await release.promise;
      const result = await remove(name);
      deleted.resolve();
      return result;
    });
    let published = false;
    const publishing = manager.start({ ...selection(), episodeId: "second" }).then((manifest) => {
      published = true;
      return manifest;
    });
    try {
      await cleaning.promise;
      await settle();
      assert.equal(published, true, nextAction);
      assert.equal(manager.phase, "ready", nextAction);
      const ready = await publishing;
      assert.equal((await manager.readRecord("active")).downloadId, ready.downloadId);
      if (nextAction === "reset") {
        await manager.reset();
        assert.equal(await manager.readRecord("active"), null);
      } else if (nextAction === "cache loss") {
        await cacheStorage.delete(ready.cacheName);
        const reopened = new OfflineManager(options);
        assert.equal((await reopened.init()).active, null);
        assert.equal(await reopened.readRecord("active"), null);
      } else {
        const total = 8 * 1024 ** 2 + 4;
        const next = new OfflineManager({ ...options, fetchImpl: rangedFetch(total, { failSecondChunk: true }) });
        await next.syncPublishedDownload();
        await assert.rejects(next.start({ ...selection(total), episodeId: "third" }), /connection lost/);
        const staging = await next.readRecord("staging");
        assert.deepEqual(staging.completed, [0]);

        release.resolve();
        await deleted.promise;
        assert.equal((await next.readRecord("staging")).downloadId, staging.downloadId);
        assert.ok(await cacheStorage.has(staging.cacheName));
        assert.equal((await next.readRecord("active")).downloadId, ready.downloadId);
      }
    } finally {
      release.resolve();
      await publishing;
      await deleted.promise;
      deletion.mock.restore();
    }
  }
});

test("timed-out staging checks preserve resumable bytes and ignore late cache reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stall of ["manifest lookup", "manifest body", "chunk lookup", "chunk body", "marker lookup", "config lookup", "config body"]) {
    const { manager, options, configUrl, selected, saved } = await savedBookFixture();
    const { cacheStorage, baseUrl } = options;
    const blocked = deferred();
    const release = deferred();
    const match = cacheStorage.match.bind(cacheStorage);
    let delayed = false;
    let auditLate = false;
    let lateReads = 0;
    let bodyCanceled = false;
    const reader = t.mock.method(cacheStorage, "match", async (url, query) => {
      if (auditLate) lateReads++;
      const response = await match(url, query);
      const stage = manager.staging;
      if (delayed || !stage || stage.completed.length !== stage.totalChunks || query.cacheName !== stage.cacheName) return response;
      const expected = {
        manifest: offlineManifestUrl(baseUrl),
        chunk: offlineChunkUrl(baseUrl, stage.downloadId, 0),
        marker: globalThis.CompactPlayerOfflineManifest.damagedChunkUrl(baseUrl, stage.downloadId, 0),
        config: configUrl,
      };
      if (url !== expected[stall.split(" ")[0]]) return response;
      delayed = true;
      if (!stall.endsWith("body")) {
        blocked.resolve();
        await release.promise;
        return response;
      }
      return new Response(new ReadableStream({
        pull() {
          blocked.resolve();
          return release.promise;
        },
        cancel() { bodyCanceled = true; },
      }, { highWaterMark: 0 }), { headers: response.headers });
    });
    let result;
    const transfer = manager.start({ ...selected, episodeId: "replacement", configBookId: "book" }).then(
      (value) => { result = value; }, (error) => { result = error; },
    );
    try {
      await blocked.promise;
      t.mock.timers.tick(3000);
      await settle();
      assert.equal(result?.code, "storage-read-timeout", stall);
      if (stall.endsWith("body")) assert.equal(bodyCanceled, true, stall);
      await manager.withLock(() => {}, assert.fail);
      const staged = await manager.readRecord("staging");
      assert.equal(manager.phase, "paused", stall);
      assert.deepEqual(staged.completed, [0], stall);
      assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId, stall);

      const writes = t.mock.method(MemoryCache.prototype, "put");
      auditLate = true;
      release.resolve();
      await settle();
      assert.equal(lateReads, 0, stall);
      assert.equal(writes.mock.callCount(), 0, stall);
      writes.mock.restore();
      auditLate = false;
      manager.fetchImpl = assert.fail;
      assert.equal((await manager.resume()).downloadId, staged.downloadId, stall);
    } finally {
      release.resolve();
      await transfer;
      reader.mock.restore();
    }
  }
});

test("Cancel and Reset release a stalled staging check before its cache read returns", async (t) => {
  for (const action of ["cancel", "reset"]) {
    const { manager, options, saved } = await savedBookFixture();
    const { baseUrl, cacheStorage } = options;
    const reading = deferred();
    const release = deferred();
    const match = cacheStorage.match.bind(cacheStorage);
    let staging;
    const lookup = t.mock.method(cacheStorage, "match", async (url, query) => {
      const response = await match(url, query);
      const pending = manager.staging;
      if (staging || !pending?.completed.length || query.cacheName !== pending.cacheName
        || url !== offlineChunkUrl(baseUrl, pending.downloadId, 0)) return response;
      staging = pending;
      reading.resolve();
      await release.promise;
      return response;
    });
    const download = manager.start({ ...selection(), episodeId: "canceled" });
    const aborted = assert.rejects(download, { name: "AbortError" });
    let stopping;
    try {
      await reading.promise;
      let stopped = false;
      stopping = manager[action]().then(() => { stopped = true; });
      await settle();
      assert.equal(stopped, true, action);
      await aborted;
      assert.equal(await manager.readRecord("staging"), null, action);
      assert.equal(await cacheStorage.has(staging.cacheName), false, action);
      const active = await manager.readRecord("active");
      assert.equal(active?.downloadId, action === "cancel" ? saved.downloadId : undefined, action);

      const next = new OfflineManager(options);
      await next.syncPublishedDownload();
      const replacement = await next.start({ ...selection(), episodeId: "replacement" });
      release.resolve();
      await settle();
      assert.equal((await next.readRecord("active")).downloadId, replacement.downloadId, action);
      assert.equal(await cacheStorage.has(staging.cacheName), false, action);
    } finally {
      release.resolve();
      await Promise.allSettled([aborted, stopping]);
      lookup.mock.restore();
    }
  }
});

test("removing a saved book releases the writer before deleting its files", async (t) => {
  for (const cacheFormat of ["scoped", "legacy without local manifest"]) {
    const { manager, options, saved, configUrl } = await savedBookFixture();
    const { baseUrl, cacheStorage } = options;
    let removed = saved;
    if (cacheFormat === "legacy without local manifest") {
      removed = { ...saved, cacheName: "compact-player-offline-book-v1-" + saved.downloadId };
      const files = await cacheStorage.open(removed.cacheName);
      const original = await cacheStorage.open(saved.cacheName);
      const chunk = offlineChunkUrl(baseUrl, saved.downloadId, 0);
      for (const key of [chunk, configUrl]) await files.put(key, await original.match(key));
      await manager.writeRecord("active", removed);
      await cacheStorage.delete(saved.cacheName);
      await manager.syncPublishedDownload();
    }

    const worker = await workerContext({ caches: cacheStorage });
    assert.equal((await worker.activeManifest()).cacheName, removed.cacheName);
    const reachedDeletion = deferred();
    const release = deferred();
    const deleted = deferred();
    const remove = cacheStorage.delete.bind(cacheStorage);
    const deleting = t.mock.method(cacheStorage, "delete", async (name) => {
      if (name !== removed.cacheName) return remove(name);
      reachedDeletion.resolve();
      await release.promise;
      const result = await remove(name);
      deleted.resolve();
      return result;
    });
    let finished = false;
    const removal = manager.removeActive().then(() => { finished = true; });
    try {
      await reachedDeletion.promise;
      await settle();
      assert.equal(finished, true, cacheFormat);
      assert.equal(manager.snapshot().active, null, cacheFormat);
      assert.equal(await worker.activeManifest(), null, cacheFormat);
      assert.equal(await cacheStorage.has(removed.cacheName), true, cacheFormat);

      const next = new OfflineManager(options);
      await next.syncPublishedDownload();
      const replacement = await next.start({ ...selection(), episodeId: "replacement" });
      release.resolve();
      await deleted.promise;
      assert.equal(await cacheStorage.has(removed.cacheName), false, cacheFormat);
      assert.equal(await cacheStorage.has(replacement.cacheName), true, cacheFormat);
      assert.equal((await worker.activeManifest()).downloadId, replacement.downloadId, cacheFormat);
    } finally {
      release.resolve();
      await removal;
      deleting.mock.restore();
    }
  }
});

test("canceling a download retires its draft before file deletion and leaves a newer draft intact", async (t) => {
  const total = 8 * 1024 ** 2 + 4;
  for (const scenario of ["paused", "late manifest write", "first download"]) {
    const options = scenario === "first download"
      ? { baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(), navigatorObject: navigatorStub() }
      : (await savedBookFixture()).options;
    const { baseUrl, cacheStorage } = options;
    const manager = new OfflineManager({ ...options, fetchImpl: rangedFetch(total, { failSecondChunk: true }) });
    await manager.init();
    const saved = manager.active;
    const heldWrite = deferred();
    const releaseWrite = deferred();
    const wrote = deferred();
    const partial = { ...selection(total), episodeId: "partial" };
    let aborted;
    let stalledWrite;
    if (scenario === "late manifest write") {
      const put = MemoryCache.prototype.put;
      let pending = false;
      stalledWrite = t.mock.method(MemoryCache.prototype, "put", async function (key, response) {
        if (!pending && key === offlineManifestUrl(baseUrl) && (await response.clone().json()).completed?.length) {
          pending = true;
          heldWrite.resolve();
          await releaseWrite.promise;
          await put.call(this, key, response);
          wrote.resolve();
          return;
        }
        return put.call(this, key, response);
      });
      aborted = assert.rejects(manager.start(partial), { name: "AbortError" });
      await heldWrite.promise;
    } else {
      await assert.rejects(manager.start(partial), /connection lost/);
    }

    const retired = manager.staging;
    const deleting = deferred();
    const releaseDeletion = deferred();
    const deleted = deferred();
    const remove = cacheStorage.delete.bind(cacheStorage);
    const stalledDeletion = t.mock.method(cacheStorage, "delete", async (name) => {
      if (name !== retired.cacheName) return remove(name);
      deleting.resolve();
      await releaseDeletion.promise;
      const result = await remove(name);
      deleted.resolve();
      return result;
    });
    let finished = false;
    const cancellation = manager.cancel().then(() => { finished = true; });
    try {
      await deleting.promise;
      await settle();
      assert.equal(finished, true, scenario);
      await aborted;
      assert.equal(await manager.readRecord("staging", true), null, scenario);
      assert.equal(manager.snapshot().staging, null, scenario);
      assert.equal(await cacheStorage.has(retired.cacheName), true, scenario);

      const peer = new OfflineManager({ ...options, fetchImpl: rangedFetch(total, { failSecondChunk: true }) });
      await peer.init();
      assert.equal(peer.staging, null, scenario);
      await assert.rejects(peer.start({ ...selection(total), episodeId: "new-draft" }), /connection lost/);
      const replacement = await peer.readRecord("staging");
      assert.notEqual(replacement.downloadId, retired.downloadId, scenario);
      assert.deepEqual(replacement.completed, [0], scenario);

      releaseWrite.resolve();
      if (stalledWrite) await wrote.promise;
      const olderPointer = await cacheStorage.open(manager.store.stagingMetaCacheName);
      await olderPointer.put(offlineMetaUrl(baseUrl, "staging"), Response.json({ cacheName: retired.cacheName, manifest: retired }));
      assert.equal((await manager.readRecord("staging")).downloadId, replacement.downloadId, scenario);
      releaseDeletion.resolve();
      await deleted.promise;
      assert.equal(await cacheStorage.has(retired.cacheName), false, scenario);
      assert.equal(await cacheStorage.has(replacement.cacheName), true, scenario);
      assert.equal((await manager.readRecord("active"))?.downloadId, saved?.downloadId, scenario);
    } finally {
      releaseWrite.resolve();
      releaseDeletion.resolve();
      await Promise.allSettled([cancellation, aborted]);
      stalledWrite?.mock.restore();
      stalledDeletion.mock.restore();
    }
  }
});

test("a reclamation timeout preserves the prepared replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const mib = 1024 ** 2;
  const total = 8 * mib + 4;
  const { manager, options, saved } = await savedBookFixture();
  const { cacheStorage: caches } = options;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "paused" }), /connection lost/);
  const prior = manager.staging;
  options.navigatorObject.storage.estimate = async () => ({ quota: 100 * mib, usage: 80 * mib });
  manager.fetchImpl = rangedFetch(total);
  const remove = caches.delete.bind(caches);
  const entered = deferred();
  const release = deferred();
  t.mock.method(caches, "delete", async (name) => {
    if (name === prior.cacheName) {
      entered.resolve();
      await release.promise;
    }
    return remove(name);
  });
  const replacement = assert.rejects(manager.start({ ...selection(total), episodeId: "new" }), { code: "storage-timeout" });
  try {
    await entered.promise;
    const prepared = await manager.readRecord("staging");
    assert.equal(prepared.episodeId, "new");
    t.mock.timers.tick(3000);
    await replacement;
    assert.equal((await manager.readRecord("staging")).downloadId, prepared.downloadId);
    assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
    release.resolve();
    await waitForBookCacheRemoval(caches, prior.cacheName);
  } finally { release.resolve(); }
});


test("a concurrent reset cannot restore an outdated active book in another tab", async (t) => {
  const {manager, saved, options} = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  assert.equal(reader.snapshot().active?.downloadId, saved.downloadId);
  const checked = deferred();
  const finish = deferred();
  const originalCheck = reader.store.checkReadyConfig.bind(reader.store);
  t.mock.method(reader.store, "checkReadyConfig", async (...args) => {
    const answer = await originalCheck(...args);
    checked.resolve();
    await finish.promise;
    return answer;
  });
  const sync = reader.syncPublishedDownload();
  try {
    await checked.promise;
    await manager.reset();
    assert.notEqual((await reader.readRecord("active", true))?.downloadId, saved.downloadId);
  } finally { finish.resolve(); }
  await sync;
  assert.equal(reader.snapshot().phase, "idle");
  assert.equal(reader.snapshot().active, null);
});

test("reset invalidates preflights started in another tab while the download store was empty", async () => {
  for (const mode of ["during Start", "before Start"]) {
    const options = { baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(),
      navigatorObject: navigatorStub() };
    const started = deferred();
    const release = deferred();
    const range = rangedFetch(10);
    const writer = new OfflineManager({ ...options, async fetchImpl(url, request) {
      if (request.headers.Range === "bytes=0-0") {
        started.resolve();
        await release.promise;
      }
      return range(url, request);
    } });
    const resetting = new OfflineManager(options);
    await writer.init();
    await resetting.init();
    const selected = selection();
    const preparation = mode === "during Start" ? writer.start(selected) : writer.inspectSource(selected);
    const rejected = mode === "during Start" ? assert.rejects(preparation, { code: "conflict" }) : null;
    try {
      await started.promise;
      await resetting.reset();
    } finally { release.resolve(); }
    if (rejected) await rejected;
    else await assert.rejects(writer.start(selected, await preparation), { code: "conflict" });
    assert.equal(await resetting.readRecord("active"), null);
    assert.equal(await resetting.readRecord("staging"), null);
    const fresh = await writer.start(selected);
    assert.equal((await resetting.readRecord("active")).downloadId, fresh.downloadId);
  }
});

test("focus during an offline cache read rechecks an evicted book configuration", async (t) => {
  const { manager, config, options, saved, configUrl } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const page = await openPlayerPage(config, assert.fail, new Map(), {
    caches: options.cacheStorage, navigator: isolatedOfflineNavigator(options.navigatorObject, true),
  });
  await page.ready;
  const read = deferred();
  const release = deferred();
  const original = OfflineManager.prototype.readPublishedBook;
  let reads = 0;
  t.mock.method(OfflineManager.prototype, "readPublishedBook", async function (...args) {
    const result = await original.apply(this, args);
    if (this !== manager && ++reads === 1) {
      read.resolve();
      await release.promise;
    }
    return result;
  });
  page.window.dispatchEvent(new Event("focus"));
  try {
    await read.promise;
    assert.ok(await cache.delete(configUrl));
    page.window.dispatchEvent(new Event("focus"));
  } finally { release.resolve(); }
  for (let attempt = 0; attempt < 10 && reads < 2; attempt++) await settle();
  assert.equal(reads, 2);
  assert.match(page.elements.get("offlineStatus").textContent, /Restore its configuration/);
});

test("sync retries an atomic snapshot when another tab cancels the staged download", async (t) => {
  const { manager, options } = await savedBookFixture();
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "partial" }), /connection lost/);
  const reader = new OfflineManager(options);
  await reader.init();
  assert.equal(reader.snapshot().staging.episodeId, "partial");
  const entered = deferred();
  const resume = deferred();
  const original = reader.store.checkReadyConfig.bind(reader.store);
  let once = true;
  t.mock.method(reader.store, "checkReadyConfig", async (...args) => {
    const result = await original(...args);
    if (once) { once = false; entered.resolve(); await resume.promise; }
    return result;
  });
  const syncing = reader.syncPublishedDownload();
  try {
    await entered.promise;
    await manager.writeRecord("staging", null);
  } finally { resume.resolve(); }
  await syncing;
  assert.equal(reader.snapshot().staging, null);
  assert.equal(reader.snapshot().active.episodeId, "book");
});

test("a temporary registration error keeps a compatible worker available and can be retried", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { options, saved } = await savedBookFixture();
  const workers = new EventTarget();
  workers.controller = workerController(options.baseUrl, "sw.js?v=25");
  let attempts = 0;
  workers.register = async () => {
    if (++attempts === 1) throw new TypeError("Temporary registration failure");
  };
  workers.ready = Promise.resolve();
  const manager = new OfflineManager({ ...options, navigatorObject: { ...navigatorStub(), serviceWorker: workers } });
  await manager.init();
  assert.equal(manager.active?.downloadId, saved.downloadId);
  assert.equal(manager.snapshot().supported, true);
  assert.equal(manager.snapshot().canWrite, true);
  assert.equal(manager.workerRegistrationFailed, true);
  await manager.retryWorkerConnection();
  assert.equal(attempts, 2);
  assert.equal(manager.workerRegistrationFailed, false);
  assert.equal(manager.snapshot().canWrite, true);
});

test("damage checks wait for a compatible worker without repeatedly reading the old worker's download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { options, saved } = await savedBookFixture();
  const workers = new EventTarget();
  workers.controller = workerController(options.baseUrl, "sw.js?v=23", { offlineJournal: 1 });
  workers.register = async () => {};
  workers.ready = Promise.resolve({});
  const manager = new OfflineManager({ ...options, navigatorObject: { ...navigatorStub(), serviceWorker: workers } });
  await manager.init();
  const scan = t.mock.method(manager.inventory, "scan");
  manager.damage.report();
  await manager.damage.check;
  assert.equal(scan.mock.callCount(), 1);
  assert.equal(manager.snapshot().active?.downloadId, saved.downloadId);
  assert.equal(manager.damage.pending, true);
  assert.equal(manager.damage.retryTimer, null);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(scan.mock.callCount(), 1);

  workers.controller = workerController(options.baseUrl, "sw.js?v=25");
  workers.dispatchEvent(new Event("controllerchange"));
  for (let attempt = 0; attempt < 20 && manager.damage.pending; attempt++) await settle();
  if (manager.damage.check) await manager.damage.check;
  assert.equal(scan.mock.callCount(), 2);
  assert.equal(manager.damage.pending, false);
});

test("a temporary registration failure without a controller can be retried", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { options } = await savedBookFixture();
  const workers = new EventTarget();
  let attempts = 0;
  workers.register = async () => {
    if (++attempts === 1) throw new TypeError("Temporary registration failure");
  };
  workers.ready = Promise.resolve();
  const manager = new OfflineManager({ ...options, navigatorObject: { ...navigatorStub(), serviceWorker: workers } });
  await manager.init();
  assert.equal(manager.snapshot().supported, false);
  await manager.retryWorkerConnection();
  assert.equal(attempts, 2);
  assert.equal(manager.snapshot().supported, false);
  workers.controller = workerController(options.baseUrl, "sw.js?v=25");
  workers.dispatchEvent(new Event("controllerchange"));
  for (let i = 0; i < 30 && !manager.snapshot().supported; i++) await settle();
  assert.equal(manager.snapshot().supported, true);
  assert.equal(manager.snapshot().canWrite, true);
});

test("a transient cache scan failure automatically retries a damaged download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  const files = await options.cacheStorage.open(saved.cacheName);
  await files.put(offlineChunkUrl(options.baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  const list = options.cacheStorage.keys.bind(options.cacheStorage);
  let attempts = 0;
  t.mock.method(options.cacheStorage, "keys", async () => {
    if (++attempts === 1) throw new Error("Temporary cache failure");
    return list();
  });
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.damage.report();
  await manager.damage.check;
  assert.equal(manager.active?.downloadId, saved.downloadId);
  assert.equal(manager.damage.pending, true);
  t.mock.timers.tick(3000);
  await settle();
  await manager.damage.check;
  assert.equal(manager.active, null);
  assert.equal(manager.staging?.downloadId, saved.downloadId);
  assert.equal(manager.damage.pending, false);
});

test("repeated stale damage scans wait before retrying and eventually repair the download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const files = await options.cacheStorage.open(saved.cacheName);
  await files.put(offlineChunkUrl(options.baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  const apply = manager.inventory.apply.bind(manager.inventory);
  let attempts = 0;
  t.mock.method(manager.inventory, "apply", (...args) => {
    if (++attempts <= 3) return Promise.resolve("stale");
    return apply(...args);
  });
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.damage.report();
  await manager.damage.check;
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 2);
  assert.equal(manager.active?.downloadId, saved.downloadId);
  manager.damage.report();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  await settle();
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 3);
  t.mock.timers.tick(6000);
  await settle();
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 4);
  assert.equal(manager.active, null);
  assert.equal(manager.staging?.downloadId, saved.downloadId);
  assert.equal(manager.damage.pending, false);
});

test("new damage reports during repeated failed scans retain backoff and repair the download", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { manager, options, saved } = await savedBookFixture();
  const files = await options.cacheStorage.open(saved.cacheName);
  await files.put(offlineChunkUrl(options.baseUrl, saved.downloadId, 0),
    new Response(Uint8Array.of(1), { headers: { "content-length": "10" } }));
  const apply = manager.inventory.apply.bind(manager.inventory);
  let attempts = 0;
  t.mock.method(manager.inventory, "apply", (...args) => {
    if (++attempts <= 3) {
      manager.store.reportDamagedChunk(saved.downloadId, 0);
      manager.damage.report();
      return Promise.resolve("failed");
    }
    return apply(...args);
  });
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.damage.report();
  await manager.damage.check;
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 2);
  assert.equal(manager.active?.downloadId, saved.downloadId);
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  await settle();
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 3);
  t.mock.timers.tick(6000);
  await settle();
  if (manager.damage.check) await manager.damage.check;
  assert.equal(attempts, 4);
  assert.equal(manager.active, null);
  assert.equal(manager.staging?.downloadId, saved.downloadId);
  assert.equal(manager.damage.pending, false);
});

test("reset drops old damage reports and preserves reports from its new epoch", async (t) => {
  const { manager, saved } = await savedBookFixture();
  const epoch = "new-reset-epoch";
  t.mock.method(manager.store, "newResetId", () => epoch);
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  const committed = deferred();
  const release = deferred();
  const original = manager.store.commitRemoval.bind(manager.store);
  t.mock.method(manager.store, "commitRemoval", async (...args) => {
    const result = await original(...args);
    committed.resolve();
    await release.promise;
    return result;
  });
  const reset = manager.reset();
  try {
    await committed.promise;
    manager.store.reportDamagedChunk(saved.downloadId, 1);
    manager.store.reportDamagedChunk(epoch + ".new-download", 2);
  } finally { release.resolve(); }
  await reset;
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...manager.store.reportedChunks.get(epoch + ".new-download")], [2]);
});

test("a failed reset keeps the existing damage reports", async (t) => {
  const { manager, saved } = await savedBookFixture();
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  t.mock.method(manager.store, "commitRemoval", async () => { throw new Error("Storage failed"); });
  await assert.rejects(manager.reset(), /Storage failed/);
  assert.deepEqual([...manager.store.reportedChunks.get(saved.downloadId)], [0]);
  assert.equal(manager.active.downloadId, saved.downloadId);
});

test("sync after another tab resets removes old reports and keeps new epoch reports", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  await manager.reset();
  const resetId = (await manager.store.readActiveState()).resetId;
  reader.store.reportDamagedChunk(resetId + ".new-download", 1);
  await reader.syncPublishedDownload();
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...reader.store.reportedChunks.get(resetId + ".new-download")], [1]);
  reader.store.reportDamagedChunk(saved.downloadId, 2);
  await reader.syncPublishedDownload();
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...reader.store.reportedChunks.get(resetId + ".new-download")], [1]);
});

test("confirming intact audio removes the empty damage-report entry", async () => {
  const { manager, saved } = await savedBookFixture();
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  await manager.refresh();
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.equal(manager.active?.downloadId, saved.downloadId);
});

test("removing a download clears its damage reports after the removal is committed", async (t) => {
  const { manager, saved } = await savedBookFixture();
  const committed = deferred();
  const release = deferred();
  const original = manager.store.removePublishedBook.bind(manager.store);
  t.mock.method(manager.store, "removePublishedBook", async (...args) => {
    const result = await original(...args);
    committed.resolve();
    await release.promise;
    return result;
  });
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.store.reportDamagedChunk("other-download", 7);
  const removal = manager.removeActive();
  try {
    await committed.promise;
    manager.store.reportDamagedChunk(saved.downloadId, 1);
    manager.store.reportDamagedChunk("other-download", 8);
  } finally { release.resolve(); }
  await removal;
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...manager.store.reportedChunks.get("other-download")], [7, 8]);
  assert.equal(manager.active, null);

  manager.store.reportDamagedChunk(saved.downloadId, 2);
  await manager.syncPublishedDownload();
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...manager.store.reportedChunks.get("other-download")], [7, 8]);
});

test("a failed removal retains damage reports", async (t) => {
  const { manager, saved } = await savedBookFixture();
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  t.mock.method(manager.store, "removePublishedBook", async () => { throw new Error("Removal failed"); });
  await assert.rejects(manager.removeActive(), /Removal failed/);
  assert.equal(manager.active?.downloadId, saved.downloadId);
  assert.deepEqual([...manager.store.reportedChunks.get(saved.downloadId)], [0]);
});

test("canceling a staged download clears its reports while preserving the active book's reports", async () => {
  const { manager, saved } = await savedBookFixture();
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "partial" }), /connection lost/);
  const staging = manager.staging;
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  manager.store.reportDamagedChunk(staging.downloadId, 0);
  await manager.cancel();
  assert.equal(manager.store.reportedChunks.has(staging.downloadId), false);
  assert.deepEqual([...manager.store.reportedChunks.get(saved.downloadId)], [0]);
  assert.equal(manager.active?.downloadId, saved.downloadId);
});

test("canceling a staged record keeps reports for a still-active download with the same ID", async () => {
  const { manager, saved } = await savedBookFixture();
  manager.staging = { ...saved, status: "downloading" };
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  await manager.withLock(() => manager.removeStagingLocked());
  assert.equal(manager.active?.downloadId, saved.downloadId);
  assert.deepEqual([...manager.store.reportedChunks.get(saved.downloadId)], [0]);
});

test("another tab's removal clears reports for the retired download on sync", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  reader.store.reportDamagedChunk("other-download", 1);
  await manager.removeActive();
  await reader.syncPublishedDownload();
  assert.equal(reader.active, null);
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...reader.store.reportedChunks.get("other-download")], [1]);
});

test("publishing a replacement clears the retired download's reports", async () => {
  const { manager, saved } = await savedBookFixture();
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  const replacement = await manager.start({ ...selection(), episodeId: "replacement" });
  assert.notEqual(replacement.downloadId, saved.downloadId);
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.equal(manager.active?.downloadId, replacement.downloadId);
});

test("a late report for a canceled download is removed after a verified scan", async () => {
  const { manager, saved } = await savedBookFixture();
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "partial" }), /connection lost/);
  const staging = manager.staging;
  await manager.cancel();
  manager.store.reportDamagedChunk(staging.downloadId, 0);
  manager.damage.report();
  await manager.damage.check;
  assert.equal(manager.store.reportedChunks.has(staging.downloadId), false);
  assert.equal(manager.active?.downloadId, saved.downloadId);
});

test("another tab's cancellation clears the staged report while keeping the active report", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const total = 8 * 1024 ** 2 + 4;
  manager.fetchImpl = rangedFetch(total, { failSecondChunk: true });
  await assert.rejects(manager.start({ ...selection(total), episodeId: "partial" }), /connection lost/);
  const staging = manager.staging;
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  reader.store.reportDamagedChunk(staging.downloadId, 0);
  await manager.cancel();
  await reader.syncPublishedDownload();
  assert.equal(reader.store.reportedChunks.has(staging.downloadId), false);
  assert.deepEqual([...reader.store.reportedChunks.get(saved.downloadId)], [0]);
  assert.equal(reader.active?.downloadId, saved.downloadId);
});

test("reports received during an inspection survive cleanup of unreferenced downloads", async (t) => {
  const { manager, saved } = await savedBookFixture();
  const entered = deferred();
  const release = deferred();
  const apply = manager.store.applyInspection.bind(manager.store);
  t.mock.method(manager.store, "applyInspection", async (...args) => {
    entered.resolve();
    await release.promise;
    return apply(...args);
  });
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  const refresh = manager.refresh();
  try {
    await entered.promise;
    manager.store.reportDamagedChunk("new-report", 1);
  } finally { release.resolve(); }
  await refresh;
  assert.deepEqual([...manager.store.reportedChunks.get("new-report")], [1]);
});

test("a stale tab clears retired reports when a removal conflicts with a replacement", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  const replacement = await manager.start({ ...selection(), episodeId: "replacement" });
  await assert.rejects(reader.removeActive(), { code: "conflict" });
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.equal(reader.active?.downloadId, replacement.downloadId);
  assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
});

test("active-only sync remembers retired reports until staging is checked", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  const replacement = await manager.start({ ...selection(), episodeId: "replacement" });
  await reader.syncPublishedDownload(false);
  assert.equal(reader.active?.downloadId, replacement.downloadId);
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), true);
  await reader.syncPublishedDownload();
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.equal(reader.pendingDamageRetirements.size, 0);
});

test("active-only sync preserves a report if the old ID is still staged", async (t) => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  reader.store.reportDamagedChunk(saved.downloadId, 0);
  await manager.start({ ...selection(), episodeId: "replacement" });
  await reader.syncPublishedDownload(false);
  const staging = { ...saved, status: "downloading" };
  t.mock.method(reader.store, "readStagingState", async () => ({ manifest: staging, authoritative: true }));
  await reader.syncPublishedDownload();
  assert.equal(reader.staging?.downloadId, saved.downloadId);
  assert.deepEqual([...reader.store.reportedChunks.get(saved.downloadId)], [0]);
  assert.equal(reader.pendingDamageRetirements.size, 0);
});

test("full sync clears a late report for a download displaced by an earlier active-only sync", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  await reader.init();
  const replacement = await manager.start({ ...selection(), episodeId: "replacement" });
  await reader.syncPublishedDownload(false);
  assert.equal(reader.active?.downloadId, replacement.downloadId);

  reader.store.reportDamagedChunk(saved.downloadId, 0);
  reader.store.reportDamagedChunk(replacement.downloadId, 0);
  await reader.syncPublishedDownload();
  assert.equal(reader.store.reportedChunks.has(saved.downloadId), false);
  assert.deepEqual([...reader.store.reportedChunks.get(replacement.downloadId)], [0]);
});

test("the worker sees the new active and staging state together when a draft is published", async (t) => {
  const { manager } = await interruptedReplacement(t);
  const draft = manager.staging;
  manager.store.reportDamagedChunk(draft.downloadId, 0);
  const states = [];
  t.mock.method(manager.routes, "prepare", async (active) => {
    if (active?.downloadId === draft.downloadId) states.push(manager.staging);
  });

  const saved = await manager.resume();
  assert.equal(saved.downloadId, draft.downloadId);
  assert.deepEqual(states, [null]);
  assert.equal(manager.active?.downloadId, draft.downloadId);
});

test("inventory builds a repair without writing and discards it if the manifest changes before the lock", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const cache = await options.cacheStorage.open(saved.cacheName);
  const manifestKey = offlineManifestUrl(options.baseUrl);
  const repairKey = offlineMetaUrl(options.baseUrl, "manifest-repair");
  await cache.delete(manifestKey);
  const records = await manager.inventory.readRecords();
  const inventory = await manager.inventory.inspect(records);
  assert.equal(inventory.inspections[0].repair.downloadId, saved.downloadId);
  assert.equal("match" in inventory.inspections[0], false);
  assert.equal(await cache.match(manifestKey), undefined);
  assert.equal(await cache.match(repairKey), undefined);

  await cache.put(manifestKey, Response.json(saved));
  assert.equal(await manager.withLock(() => manager.inventory.apply(records, inventory)), "stale");
  assert.equal(await cache.match(repairKey), undefined);

  await cache.delete(manifestKey);
  assert.equal(await manager.inventory.scan(), "applied");
  assert.equal((await (await cache.match(repairKey)).json()).manifest.downloadId, saved.downloadId);
});

test("only reports for inspected downloads invalidate a damage scan", async () => {
  const { manager, saved } = await savedBookFixture();
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  const records = await manager.inventory.readRecords();
  const scan = await manager.inventory.inspect(records);
  manager.store.reportDamagedChunk("another-download", 0);
  assert.equal(await manager.store.inspectionIsCurrent(scan), true);
  await manager.store.applyInspection(scan);
  assert.equal(manager.store.reportedChunks.has(saved.downloadId), false);
  assert.equal(manager.store.reportedChunks.has("another-download"), true);

  const next = await manager.inventory.inspect(records);
  manager.store.reportDamagedChunk(saved.downloadId, 0);
  assert.equal(await manager.store.inspectionIsCurrent(next), false);
  await manager.store.applyInspection(next);
  assert.equal(manager.store.reportedChunks.get(saved.downloadId).has(0), true);
});

test("concurrent sync requests share a read and changes trigger one follow-up", async (t) => {
  const { manager } = await savedBookFixture();
  const entered = deferred();
  const release = deferred();
  const read = t.mock.method(manager, "readPublishedBook", async () => {
    entered.resolve();
    await release.promise;
    return { records: {}, isCurrent: async () => true };
  });
  const first = manager.syncPublishedDownload();
  await entered.promise;
  assert.equal(manager.syncPublishedDownload(), first);
  assert.equal(manager.syncPublishedDownload(true, { changed: true }), first);
  assert.equal(manager.syncPublishedDownload(true, { changed: true }), first);
  assert.equal(read.mock.callCount(), 1);
  release.resolve();
  await first;
  assert.equal(read.mock.callCount(), 2);
});

test("an operation ending during a skipped sync queues a fresh cross-tab read", async (t) => {
  const manager = new OfflineManager({ baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigatorStub() });
  const read = t.mock.method(manager, "readPublishedBook", async () => ({ records: {}, isCurrent: async () => true }));
  const change = deferred();
  const operation = manager.runOperation(() => change.promise);
  const sync = manager.syncPublishedDownload(true, { changed: true });
  for (let i = 0; i < 10 && !manager.tabSync.deferred; i++) await Promise.resolve();
  const wasDeferred = manager.tabSync.deferred;
  change.resolve();
  await Promise.all([operation, sync]);
  await settle();
  assert.equal(wasDeferred, true);
  assert.equal(read.mock.callCount(), 1);
});

test("removal rechecks worker compatibility after acquiring the write lock", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const workers = options.navigatorObject.serviceWorker;
  workers.controller = workerController(options.baseUrl, "sw.js?v=25");
  const requesting = deferred();
  const grant = deferred();
  options.navigatorObject.locks = {
    async request(name, settings, action) {
      requesting.resolve();
      await grant.promise;
      return locks.request(name, settings, action);
    },
  };
  const removing = assert.rejects(manager.removeActive(), { code: "unsupported" });
  try {
    await requesting.promise;
    workers.controller = workerController(options.baseUrl, "sw.js?v=21", { offlineJournal: 0 });
  } finally {
    grant.resolve();
  }
  await removing;
  assert.equal((await manager.readRecord("active")).downloadId, saved.downloadId);
  assert.equal(heldLocks.size, 0);

  workers.controller = workerController(options.baseUrl, "sw.js?v=25");
  await manager.removeActive();
  assert.equal(await manager.readRecord("active"), null);
});

test("cache refresh keeps controls available across a temporary worker incompatibility", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const { serviceWorker } = options.navigatorObject;
  const compatible = workerController(options.baseUrl);
  serviceWorker.controller = compatible;
  options.navigatorObject.locks = {
    async request(name, settings, action) {
      serviceWorker.controller = workerController(options.baseUrl, "sw.js?v=23", { offlineJournal: 1 });
      return locks.request(name, settings, action);
    },
  };
  const during = await manager.refresh();
  assert.equal(during.supported, true);
  assert.equal(during.canWrite, false);
  assert.equal(during.active.downloadId, saved.downloadId);

  options.navigatorObject.locks = locks;
  serviceWorker.controller = compatible;
  await manager.retryWorkerConnection();
  assert.equal(manager.snapshot().supported, true);
  assert.equal(manager.snapshot().canWrite, true);
  await manager.removeActive();
  assert.equal(await manager.readRecord("active"), null);
});

test("a temporary write-lock error leaves the offline book and download controls available for retry", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { manager, options, saved } = await savedBookFixture();
  let checks = 0;
  options.navigatorObject.locks = {
    async request(name, settings, action) {
      if (++checks === 1) throw new DOMException("The database is temporarily unavailable.", "UnknownError");
      return locks.request(name, settings, action);
    },
  };
  const fallback = await manager.refresh();
  assert.equal(fallback.supported, true);
  assert.equal(fallback.active.downloadId, saved.downloadId);
  assert.equal((await manager.refresh()).active.downloadId, saved.downloadId);
  const replacement = await manager.start({ ...selection(), episodeId: "after-lock-error" });
  assert.equal((await manager.readRecord("active")).downloadId, replacement.downloadId);
});

test("download status stays ready after reconciling or declining a replacement", async () => {
  const { manager, options, saved } = await savedBookFixture();
  const reader = new OfflineManager(options);
  const onOpen = await reader.init();
  assert.equal(onOpen.phase, "ready");
  assert.equal(onOpen.progress, 1);
  assert.equal(onOpen.active.downloadId, saved.downloadId);

  const result = await manager.start({ ...selection(), episodeId: "declined" }, undefined, { confirmDownload: () => false });
  assert.equal(result, null);
  const afterDecline = manager.snapshot();
  assert.equal(afterDecline.phase, "ready");
  assert.equal(afterDecline.progress, 1);
  assert.equal(afterDecline.active.downloadId, saved.downloadId);
});

test("the offline panel moves focus from a hidden Cancel button to the completed download's action", async () => {
  const { manager, saved, selected } = await savedBookFixture();
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new Element();
        element.focus = () => { document.activeElement = element; };
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
  const render = createOfflinePanel({ document }, {
    offline: manager, getSelection: () => selected, getLocale: () => "en", isOnline: () => true, t: (key) => key,
  });
  const state = manager.snapshot();
  render({ ...state, phase: "downloading", busy: true, canCancel: true, active: null, staging: saved });
  const cancel = document.getElementById("offlineCancelBtn");
  assert.equal(cancel.hidden, false);
  cancel.focus();
  render(state);
  assert.equal(cancel.hidden, true);
  assert.equal(document.activeElement, document.getElementById("offlineRemoveBtn"));
});

test("losing the connection moves focus from a disabled Resume button to Cancel", async () => {
  const { manager, saved, selected } = await savedBookFixture();
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new Element();
        element.focus = () => { document.activeElement = element; };
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
  let online = true;
  const render = createOfflinePanel({ document }, {
    offline: manager, getSelection: () => selected, getLocale: () => "en", isOnline: () => online, t: (key) => key,
  });
  const state = { ...manager.snapshot(), active: null, staging: saved, phase: "paused", canCancel: true };
  render(state);
  const resume = document.getElementById("offlineDownloadBtn");
  assert.equal(resume.disabled, false);
  resume.focus();
  online = false;
  render(state);
  assert.equal(resume.disabled, true);
  assert.equal(document.activeElement, document.getElementById("offlineCancelBtn"));
});

test("other tabs block draft actions while the write lock is held and enable Resume after interruption", async (t) => {
  const total = 8 * 1024 ** 2 + 4;
  const firstChunk = deferred();
  const range = rangedFetch(total, { failSecondChunk: true });
  const options = { baseUrl: "https://example.test/first-draft/", cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigatorStub() };
  const manager = new OfflineManager({ ...options, fetchImpl: async (url, init) => {
    if (init.headers.Range === "bytes=0-8388607") await firstChunk.promise;
    return range(url, init);
  } });
  const draftSeen = deferred();
  const partialSeen = deferred();
  const reader = new OfflineManager({ ...options, onChange: ({ staging, writeLockBusy }) => {
    if (staging?.completed.length === 0) draftSeen.resolve(staging);
    if (staging?.completed.length === 1 && !writeLockBusy) partialSeen.resolve(staging);
  } });
  await manager.init();
  await reader.init();
  manager.listenForPublishedChanges(BroadcastChannel);
  reader.listenForPublishedChanges(BroadcastChannel);
  t.after(() => {
    manager.tabSync.channel.close();
    reader.tabSync.channel.close();
  });

  const path = new URL("audio.webm", options.baseUrl).href;
  const failed = assert.rejects(manager.start({ ...selection(total), sourceUrl: path }), /connection lost/);
  let draft;
  try {
    draft = await draftSeen.promise;
    assert.equal(draft.downloadId, manager.staging?.downloadId);
    assert.equal(reader.snapshot().writeLockBusy, true);
    assert.equal(reader.snapshot().canCancel, false);
  } finally {
    firstChunk.resolve();
  }
  await failed;
  const paused = await partialSeen.promise;
  assert.equal(paused.downloadId, draft.downloadId);
  assert.deepEqual(paused.completed, [0]);
  assert.equal(reader.snapshot().phase, "paused");
  assert.equal(reader.snapshot().canCancel, true);
});

test("a tab clears the remote download status after a missed release and a failed read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reader = new OfflineManager({ baseUrl: "https://example.test/", cacheStorage: new MemoryCacheStorage(),
    navigatorObject: navigatorStub() });
  reader.staging = { downloadId: "draft-in-another-tab", totalSize: 10, totalChunks: 1, completed: [] };
  let staleReads = 0;
  t.mock.method(reader, "readPublishedBook", async () => {
    if (staleReads === 0) return { records: { staging: reader.staging }, isCurrent: async () => true };
    staleReads--;
    return null;
  });
  const release = deferred();
  const owner = locks.request(reader.coordinationName, {}, () => release.promise);
  t.after(release.resolve);
  await reader.syncPublishedDownload();
  assert.equal(reader.snapshot().writeLockBusy, true);

  release.resolve();
  await owner;
  staleReads = 2;
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(reader.snapshot().writeLockBusy, true);
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(reader.snapshot().writeLockBusy, false);
  assert.equal(reader.snapshot().canCancel, true);
});
