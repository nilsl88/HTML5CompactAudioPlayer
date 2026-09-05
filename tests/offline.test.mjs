import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { BookConfigStore } from "../js/book-config.js";
import { normalizeLibrary } from "../js/config.js";
import {
  OfflineManager,
  chunkBounds,
  completedBytes,
  manifestMatchesSelection,
  offlineChunkUrl,
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
  async delete(name) { return this.map.delete(name); }
}

function navigatorStub(estimate = { quota: 1024 ** 3, usage: 0 }) {
  return {
    onLine: true,
    serviceWorker: { register: async () => ({}), ready: Promise.resolve({}) },
    storage: { estimate: async () => estimate, persist: async () => true },
  };
}

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

function rangedFetch(total, { failSecondChunk = false } = {}) {
  let chunkRequests = 0;
  return async (_url, options) => {
    const range = options.headers.Range;
    if (range === "bytes=0-0") {
      return new Response(new Uint8Array([0]), { status: 206, headers: { "content-range": `bytes 0-0/${total}`, etag: '"one"' } });
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
  const resumed = await manager.inspectSource(selected);
  assert.equal(resumed.canResume, true);
  assert.equal(resumed.remainingBytes, 4);
  const manifest = await manager.start(selected, resumed);
  assert.equal(manifest.status, "ready");
  assert.deepEqual(manifest.completed, [0, 1]);
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

for (const filename of ["book.json", "episode.json"]) test(`downloads and reloads offline with ${filename} after a shell upgrade`, async () => {
  const baseUrl = "https://example.test/";
  const raw = { id: "book", defaultLanguage: "en", languages: { en: { sources: { opus: { 64: "audio.webm" } } } } };
  const library = normalizeLibrary({ books: [{ id: "book" }] });
  const audioFetch = rangedFetch(10);
  const fetchImpl = async (url, options) => {
    if (url.endsWith(`/media/book/${filename}`)) return new Response(JSON.stringify(raw));
    if (url.endsWith("/book.json")) return new Response(null, { status: 404 });
    return audioFetch(url, options);
  };
  const configs = new BookConfigStore({ library, documentBaseUrl: baseUrl, fetchImpl, retries: 1 });
  const loaded = await configs.load("book");
  const cacheStorage = new MemoryCacheStorage();
  const manager = new OfflineManager({ baseUrl, fetchImpl, cacheStorage, navigatorObject: navigatorStub() });
  await manager.init();
  const selected = { ...selection(), assets: [{ url: loaded.configUrl, required: true }] };
  const manifest = await manager.start(selected, await manager.inspectSource(selected));
  assert.equal(manifest.episodeId, "book");
  assert.equal(manifest.episodeTitle, "Book");
  assert.ok(await (await cacheStorage.open(manifest.cacheName)).match(loaded.configUrl));

  await cacheStorage.open("compact-player-shell-v8");
  await cacheStorage.open("compact-player-shell-v9");
  const events = {};
  const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  const context = vm.createContext({
    self: { registration: { scope: baseUrl }, location: { origin: new URL(baseUrl).origin },
      addEventListener: (name, handler) => { events[name] = handler; }, clients: { claim: async () => {} } },
    caches: cacheStorage, fetch: async () => { throw new TypeError("Offline"); },
    URL, Request, Response, ReadableStream,
  });
  vm.runInContext(source, context);
  let activated;
  events.activate({ waitUntil: (promise) => { activated = promise; } });
  await activated;
  assert.equal((await cacheStorage.keys()).includes("compact-player-shell-v8"), false);
  assert.ok((await cacheStorage.keys()).includes(manifest.cacheName));

  const offlineFetch = (url, options) => context.networkFirst(new Request(url, options));
  const offlineNavigator = navigatorStub();
  offlineNavigator.onLine = false;
  const reloaded = new OfflineManager({ baseUrl, fetchImpl: offlineFetch, cacheStorage, navigatorObject: offlineNavigator });
  await reloaded.init();
  assert.equal(reloaded.active.episodeId, "book");
  const offlineConfigs = new BookConfigStore({ library, documentBaseUrl: baseUrl, fetchImpl: offlineFetch, retries: 1 });
  assert.equal((await offlineConfigs.load("book")).configUrl, loaded.configUrl);
  const response = await offlineFetch(selected.sourceUrl, { headers: { Range: "bytes=8-9" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 8-9/10");
  assert.equal((await response.arrayBuffer()).byteLength, 2);
});

test("service worker range parser handles open and suffix requests", async () => {
  const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  const context = vm.createContext({
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
  vm.runInContext(source, context);
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
