import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { BookConfigStore, queryBookId } from "../js/book-config.js";
import { normalizeBook, normalizeLibrary, resolveCover, resolveLanguageAsset } from "../js/config.js";

const baseUrl = "https://example.test/";
const configuration = (id = "one") => ({
  id, defaultLanguage: "en", title: { en: `Book ${id}` }, cover: "cover.jpg",
  languages: { en: { chapters: "chapters.vtt", sources: { aac: { 64: "audio.m4b" } } } },
});
const json = (value) => new Response(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

function store(fetchImpl, entries = [{ id: "one" }]) {
  return new BookConfigStore({ library: normalizeLibrary({ books: entries }), documentBaseUrl: baseUrl, fetchImpl, retries: 1 });
}

test("prefers books, including an empty list, over every legacy collection", () => {
  const aliases = { audiofiles: [{ id: "audio" }], episodes: [{ id: "episode" }], items: [{ id: "item" }] };
  assert.deepEqual(normalizeLibrary({ books: [{ id: "book" }], ...aliases }).books.map(({ id }) => id), ["book"]);
  for (const books of [[], null, "invalid"]) assert.deepEqual(normalizeLibrary({ books, ...aliases }).books, []);
  assert.equal(normalizeLibrary(aliases).defaultId, "audio");
  assert.equal(normalizeLibrary({ episodes: aliases.episodes, items: aliases.items }).defaultId, "episode");
  assert.equal(normalizeLibrary({ items: aliases.items }).defaultId, "item");
});

test("preserves library entry and default aliases", () => {
  for (const collection of ["books", "audiofiles", "episodes", "items"]) {
    const library = normalizeLibrary({ defaultId: "second", [collection]: [
      { episode: "first", path: "nested/First Book", label: "First", title: { en: "Legacy title" } },
      { key: "second" },
    ] });
    assert.equal(library.defaultId, "second");
    assert.deepEqual(library.books[0], { id: "first", folder: "nested/First Book", label: "First", title: { en: "Legacy title" } });
    assert.equal(library.books[1].folder, "second");
  }
});

test("book query takes precedence without falling back from an invalid non-empty value", () => {
  const library = normalizeLibrary({ books: [{ id: "known/id", folder: "safe-folder" }] });
  for (const [query, expected] of [
    ["?book=new&episode=old", "new"], ["?episode=old", "old"], ["?book=&episode=old", "old"],
    ["?book=known%2Fid", "known/id"], ["?book=../secret&episode=old", ""],
    ["?book=%20&episode=old", ""], ["?book=..", ""], ["?book=nested/unknown", ""],
    ["?book=https://evil.test", ""], ["?book=book-1.en", "book-1.en"], ["", ""],
  ]) assert.equal(queryBookId(new URLSearchParams(query), library), expected, query);
});

test("new-only config wins, keeps relative assets, and is reused for titles and selection", async () => {
  const calls = [];
  const configs = store(async (url, options) => { calls.push({ url, options }); return json(configuration()); });
  const loaded = await configs.load("one");
  assert.equal(loaded.configUrl, baseUrl + "media/one/book.json");
  assert.equal(resolveCover(loaded.book), baseUrl + "media/one/cover.jpg");
  const language = loaded.book.languages.en;
  assert.equal(resolveLanguageAsset(language, language.chapters), baseUrl + "media/one/chapters.vtt");
  assert.equal(resolveLanguageAsset(language, language.sources.aac[64]), baseUrl + "media/one/audio.m4b");
  assert.equal(await configs.load("one"), loaded);
  await configs.loadTitles();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, "default");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(configs.library.byId.get("one").title, { en: "Book one" });
});

test("book.json wins when both configurations exist", async () => {
  const calls = [];
  const configs = store(async (url) => {
    calls.push(url);
    return json(configuration(url.endsWith("/book.json") ? "new" : "old"));
  });
  assert.equal((await configs.load("one")).book.id, "new");
  assert.deepEqual(calls, [baseUrl + "media/one/book.json"]);
});

for (const status of [404, 410]) test(`legacy-only config loads after HTTP ${status}`, async () => {
  const calls = [];
  const configs = store(async (url) => {
    calls.push(url);
    return url.endsWith("/book.json") ? new Response(null, { status }) : json(configuration());
  });
  const loaded = await configs.load("one");
  assert.equal(loaded.configUrl, baseUrl + "media/one/episode.json");
  assert.equal(loaded.book.id, "one");
  assert.equal(await configs.load("one"), loaded);
  assert.deepEqual(calls, [baseUrl + "media/one/book.json", baseUrl + "media/one/episode.json"]);
});

test("mixed libraries keep each configuration's actual URL", async () => {
  const configs = store(async (url) => {
    if (url.endsWith("legacy/book.json")) return new Response(null, { status: 404 });
    return json(configuration(url.includes("/legacy/") ? "legacy" : "new"));
  }, [{ id: "new" }, { id: "legacy" }]);
  const [first, second] = await Promise.all([configs.load("new"), configs.load("legacy")]);
  assert.ok(first.configUrl.endsWith("/new/book.json"));
  assert.ok(second.configUrl.endsWith("/legacy/episode.json"));
});

for (const name of ["TypeError", "NetworkError", "TimeoutError", "AbortError"]) test(`tries legacy config after fetch ${name}`, async () => {
  const calls = [];
  const configs = store(async (url) => {
    calls.push(url);
    if (url.endsWith("/book.json")) throw Object.assign(new Error("Network unavailable"), { name });
    return json(configuration());
  });
  assert.ok((await configs.load("one")).configUrl.endsWith("/episode.json"));
  assert.equal(calls.length, 2);
});

test("a network failure reading the response body can use the legacy config", async () => {
  const configs = store(async (url) => url.endsWith("/book.json")
    ? { ok: true, text: async () => { throw new TypeError("Connection lost"); } }
    : json(configuration()));
  assert.ok((await configs.load("one")).configUrl.endsWith("/episode.json"));
});

for (const status of [401, 403, 429, 500, 503]) test(`HTTP ${status} does not hide behind episode.json`, async () => {
  const calls = [];
  const configs = store(async (url) => { calls.push(url); return new Response(null, { status }); });
  await assert.rejects(configs.load("one"), new RegExp(`HTTP ${status}`));
  assert.equal(calls.length, 1);
  assert.equal(configs.cache.size, 0);
});

test("invalid book JSON and schema do not load legacy config", async () => {
  for (const body of ["{broken", "null", "{}", JSON.stringify({ ...configuration(), languages: {} })]) {
    let calls = 0;
    const configs = store(async () => { calls++; return new Response(body); });
    await assert.rejects(configs.load("one"), /JSON|Book configuration/);
    assert.equal(calls, 1);
  }
});

test("non-network errors do not trigger legacy fallback", async () => {
  let calls = 0;
  const configs = store(async () => { calls++; throw new Error("Unexpected failure"); });
  await assert.rejects(configs.load("one"), /Unexpected failure/);
  assert.equal(calls, 1);
});

test("missing configurations fail finitely and remain retryable", async () => {
  let available = false;
  const calls = [];
  const configs = store(async (url) => {
    calls.push(url);
    return available ? json(configuration()) : new Response(null, { status: 404 });
  });
  await assert.rejects(configs.load("one"), /episode\.json \(HTTP 404\)/);
  assert.equal(calls.length, 2);
  assert.equal(configs.requests.size, 0);
  available = true;
  assert.equal((await configs.load("one")).book.id, "one");
  assert.equal(calls.length, 3);
});

test("folder overrides are encoded once and unknown unsafe IDs make no requests", async () => {
  const calls = [];
  const configs = store(async (url) => { calls.push(url); return json(configuration()); }, [{ id: "one", folder: "nested/Book & Cover" }]);
  await configs.load("one");
  assert.equal(calls[0], baseUrl + "media/nested/Book%20%26%20Cover/book.json");
  for (const id of ["../secret", "/root", "x/y", "https://evil.test", ""]) await assert.rejects(configs.load(id), /identifier/);
  assert.equal(calls.length, 1);
});

test("in-flight selection and title requests share work with independent cancellation", async () => {
  const pending = deferred();
  let calls = 0;
  const configs = store(async () => { calls++; return pending.promise; });
  const controller = new AbortController();
  const leaving = configs.load("one", { signal: controller.signal });
  const staying = configs.load("one");
  const titles = configs.loadTitles();
  const rejected = assert.rejects(leaving, { name: "AbortError" });
  controller.abort();
  await rejected;
  pending.resolve(json(configuration()));
  assert.equal((await staying).book.id, "one");
  await titles;
  assert.equal(calls, 1);
  assert.equal(configs.requests.size, 0);
});

test("already cancelled consumers do not start requests or receive cached results", async () => {
  let calls = 0;
  const configs = store(async () => { calls++; return json(configuration()); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(configs.load("one", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  await configs.load("one");
  await assert.rejects(configs.load("one", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("title requests stay lazy, use two workers, reuse cached books, and retry failures", async () => {
  const pending = new Map();
  const calls = [];
  const failures = [];
  let active = 0;
  let peak = 0;
  const configs = store(async (url) => {
    const id = new URL(url).pathname.split("/")[2];
    calls.push(id);
    if (id === "one") return json(configuration(id));
    active++; peak = Math.max(peak, active);
    const gate = deferred(); pending.set(id, gate);
    try { return await gate.promise; } finally { active--; }
  }, ["one", "two", "three", "four"].map((id) => ({ id })));
  await configs.load("one");
  assert.deepEqual(calls, ["one"]);
  const titles = configs.loadTitles((id) => failures.push(id));
  assert.equal(configs.loadTitles(), titles);
  assert.deepEqual(calls, ["one", "two", "three"]);
  pending.get("two").resolve(json(configuration("two")));
  await flush();
  assert.deepEqual(calls, ["one", "two", "three", "four"]);
  pending.get("three").resolve(new Response(null, { status: 500 }));
  pending.get("four").resolve(json(configuration("four")));
  await titles;
  assert.equal(peak, 2);
  assert.deepEqual(failures, ["three"]);
  assert.equal(configs.library.byId.get("three").title, null);
  await configs.load("two");
  assert.equal(calls.filter((id) => id === "two").length, 1);
  const retry = configs.loadTitles();
  pending.get("three").resolve(json(configuration("three")));
  await retry;
  assert.deepEqual(configs.library.byId.get("three").title, { en: "Book three" });
});

test("a stale cancelled book load cannot overwrite a newer selection", async () => {
  const source = await readFile(new URL("../player.js", import.meta.url), "utf8");
  const loadFunction = source.slice(source.indexOf("async function loadBook("), source.indexOf("function setBookUrl("));
  const old = deferred();
  const configs = store(async (url) => url.includes("/old/") ? old.promise : json(configuration("new")), [{ id: "old" }, { id: "new" }]);
  const context = {
    bookConfigs: configs, bookController: null, bookGeneration: 0, chapterController: null, chapterGeneration: 0,
    trackObjectUrl: "", navigator: { onLine: true }, location: { href: baseUrl }, offline: {}, uiPrefs: {},
    els: { chaptersList: { setAttribute() {} }, chaptersTrack: { removeAttribute() {} } },
    storage: { readBook: () => ({}), getProgress: () => 0, setLastBook() {} },
    media: { setSelection() {}, setPlaybackRate() {}, setVolume() {} },
    t: () => "", buildSources: () => [{ id: "aac-64" }], chooseDefaultSource: (sources) => sources[0],
    guessLanguage: () => "en", playbackSources: (sources) => sources, getChapterSourceKey: () => "",
    resolveLanguageAsset: () => "", ensureChapters: () => Promise.resolve(), AbortController, URL, Map, Set,
  };
  for (const name of ["saveProgress", "cancelSleep", "cancelAvailabilityWork", "setLoading", "setBusy", "clearCover",
    "setText", "setMeta", "applyCachedAvailability", "populateLibrarySelect", "populateLanguageSelect", "populateQualitySelect",
    "updateTitle", "updateMeta", "applyCover", "updateChapterButtons", "setBookUrl", "renderOfflineUi", "requestAvailabilityScan"])
    context[name] = () => {};
  const sandbox = vm.createContext(context);
  vm.runInContext(loadFunction, sandbox);
  const first = sandbox.loadBook("old");
  await sandbox.loadBook("new");
  await first;
  assert.equal(sandbox.book.id, "new");
  old.resolve(json(configuration("old")));
  await configs.load("old");
  assert.equal(sandbox.book.id, "new");
  assert.equal(sandbox.bookId, "new");
});

test("offline selection retains manifest fields and requires the actual configuration URL", async () => {
  const source = await readFile(new URL("../player.js", import.meta.url), "utf8");
  const selectionFunction = source.slice(source.indexOf("function currentOfflineSelection("), source.indexOf("function selectionFromManifest("));
  const book = normalizeBook(configuration(), { bookBaseUrl: baseUrl + "media/one/", documentBaseUrl: baseUrl });
  for (const filename of ["book.json", "episode.json"]) {
    const context = vm.createContext({
      book, bookId: "one", bookConfigUrl: baseUrl + "media/one/" + filename, languageCode: "en", displayTitle: () => "Book one",
      currentSource: { id: "aac-64", url: baseUrl + "media/one/audio.m4b", mime: "audio/mp4" },
      sourceLabel: () => "64 kbps", libraryUrl: baseUrl + "media/library.json", resolveCover,
      chapterUrl: baseUrl + "media/one/chapters.vtt", documentBaseUrl: baseUrl, URL,
    });
    const selected = vm.runInContext(selectionFunction + "\ncurrentOfflineSelection()", context);
    assert.equal(selected.episodeId, "one");
    assert.equal(selected.episodeTitle, "Book one");
    assert.equal(selected.assets.find((asset) => asset.required).url, context.bookConfigUrl);
    assert.equal(Object.hasOwn(selected, "bookId"), false);
  }
});
