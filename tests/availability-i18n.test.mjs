import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { setImmediate as settle } from "node:timers/promises";
import { probeUrl } from "../js/availability.js?v=19";
import { deferred, openPlayerPage } from "./player-page.mjs";
import { resolveUiLocale, translateAt, uiLanguageOptions, UI_STRINGS } from "../i18n.js?v=19";

function response(status) {
  return { status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } };
}

test("availability uses Range when HEAD is unsupported", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => { methods.push(options.method); return options.method === "HEAD" ? response(405) : response(206); };
  assert.equal(await probeUrl("https://example.test/audio", { fetchImpl }), "available");
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("canceling an inconclusive HEAD probe prevents the fallback Range request", async () => {
  const controller = new AbortController();
  const methods = [];
  const fetchImpl = async (_url, { method }) => {
    methods.push(method);
    if (method === "HEAD") return { status: 405, body: { cancel: async () => controller.abort() } };
    return response(206);
  };
  const result = probeUrl("https://example.test/audio", { fetchImpl, signal: controller.signal });
  await assert.rejects(result, { name: "AbortError" });
  assert.deepEqual(methods, ["HEAD"]);
});

test("one inconclusive probe cannot make a source missing", async () => {
  const fetchImpl = async (_url, options) => options.method === "HEAD" ? response(404) : response(500);
  assert.equal(await probeUrl("https://example.test/audio", { fetchImpl }), "unknown");
});

test("two definitive missing responses mark a source missing", async () => {
  assert.equal(await probeUrl("https://example.test/audio", { fetchImpl: async () => response(404) }), "missing");
});

test("a late missing probe preserves the source that played on the next selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = { opus: { 128: "book.webm", 64: "low.webm" }, aac: { 128: "book.m4b" } };
  const book = { id: "book", defaultLanguage: "en", languages: { en: { sources } } };
  let finishHead;
  const pendingHead = new Promise((resolve) => { finishHead = resolve; });
  const requests = [];
  const saved = new Map();
  const { audio, elements, storage } = await openPlayerPage(book, (url, options) => {
    requests.push([new URL(url).pathname.split("/").pop(), options.method]);
    if (url.endsWith("/book.webm") && options.method === "HEAD") return pendingHead;
    return response(url.endsWith(".webm") ? 404 : 200);
  }, saved);
  const options = elements.get("optionsBtn");
  options.dispatchEvent(new Event("click"));
  assert.ok(requests.some(([file, method]) => file === "book.webm" && method === "HEAD"));
  options.dispatchEvent(new Event("click"));
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(audio.src.endsWith("/book.webm"));
  audio.dispatchEvent(new Event("playing"));
  finishHead(response(404));
  await settle();
  assert.ok(requests.some(([file, method]) => file === "book.webm" && method === "GET"));
  const cache = storage.readAvailabilityCache(book.id, 1);
  assert.equal(cache.byLanguage.en["opus-64"], "missing");
  assert.equal(cache.byLanguage.en["opus-128"], "available");
  const select = elements.get("bookSelect");
  select.value = book.id;
  select.dispatchEvent(new Event("change"));
  await settle();
  assert.equal(elements.get("qualitySelect").children.find((option) => option.selected)?.value, "opus-128");
  options.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(requests.filter(([file, method]) => file === "book.webm" && method === "HEAD").length, 1);
  assert.equal(requests.filter(([file, method]) => file === "low.webm" && method === "HEAD").length, 2);
});

test("a late probe in another tab cannot hide a source that played", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const book = { id: "book", defaultLanguage: "en", languages: { en: {
    sources: { opus: { 128: "book.webm" }, mp3: { 64: "book.mp3" } },
  } } };
  const saved = new Map();
  const head = deferred();
  const probing = await openPlayerPage(book, (url, { method }) => {
    if (!url.endsWith("book.webm")) return response(200);
    return method === "HEAD" ? head.promise : response(404);
  }, saved);
  probing.elements.get("optionsBtn").dispatchEvent(new Event("click"));
  const playing = await openPlayerPage(book, assert.fail, saved);
  playing.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(playing.audio.src.endsWith("book.webm"));
  playing.audio.dispatchEvent(new Event("playing"));
  head.resolve(response(404));
  await settle();

  const reopened = await openPlayerPage(book, assert.fail, saved);
  reopened.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(reopened.audio.src, playing.audio.src);
  assert.ok(probing.elements.get("qualitySelect").children.some((option) => option.value === "opus-128"));
});

test("language scans in different tabs retain each source result and its expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const book = { id: "book", defaultLanguage: "en", languages: {
    en: { sources: { mp3: { 64: "en.mp3" } } }, da: { sources: { mp3: { 64: "da.mp3" } } },
  } };
  const saved = new Map();
  const probe = (url) => response(url.endsWith("en.mp3") ? 404 : 200);
  const first = await openPlayerPage(book, probe, saved);
  const second = await openPlayerPage(book, probe, saved);
  const language = second.elements.get("langSelect");
  language.value = "da";
  language.dispatchEvent(new Event("change"));
  first.elements.get("optionsBtn").dispatchEvent(new Event("click"));
  await settle();
  t.mock.timers.tick(50);
  second.elements.get("optionsBtn").dispatchEvent(new Event("click"));
  await settle();
  const read = () => first.storage.readAvailability("book", 1, 100);
  assert.deepEqual(read(), { en: { "mp3-64": "missing" }, da: { "mp3-64": "available" } });
  t.mock.timers.tick(51);
  assert.deepEqual(read(), { da: { "mp3-64": "available" } });
});

test("editions with the same book and quality IDs only reuse probes for their own audio URL", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const saved = new Map();
  const book = { id: "book", defaultLanguage: "en", languages: { en: {
    sources: { opus: { 96: "audio.webm" }, mp3: { 64: "audio.mp3" } },
  } } };
  const visit = (folder) => openPlayerPage(book, assert.fail, saved, { fetch: async (url) => {
    if (url.endsWith("/library.json")) return Response.json({ books: [{ id: folder }], ui: { onboardingEnabled: false } });
    if (url.endsWith("/book.json")) return Response.json(book);
    return response(url.endsWith("/first/audio.webm") ? 404 : 200);
  } });
  const selected = (page) => page.elements.get("qualitySelect").children.find((option) => option.selected).value;
  const scan = async (page) => { page.elements.get("optionsBtn").dispatchEvent(new Event("click")); await settle(); };
  const first = await visit("first");
  const cache = first.storage.availabilityCache("book", 1);
  const oldKey = cache.scope + ":probe:en:opus-96";
  const firstUrl = "https://example.test/media/first/audio.webm";
  first.storage.writeJson(oldKey, { timestamp: Date.now(), language: "en", id: "opus-96", value: false });
  assert.equal(cache.readProbe("en", "opus-96", firstUrl), "unknown");
  first.storage.writeJson(oldKey, { timestamp: Date.now(), language: "en", id: "opus-96", value: false, url: firstUrl });
  assert.equal(cache.readProbe("en", "opus-96", firstUrl), "missing");
  assert.equal(cache.readProbe("en", "opus-96", firstUrl.replace("/first/", "/second/")), "unknown");
  await scan(first);
  assert.equal(selected(await visit("first")), "mp3-64");
  const second = await visit("second");
  assert.equal(selected(second), "opus-96");
  t.mock.timers.tick(50);
  await scan(second);
  assert.equal(selected(await visit("first")), "mp3-64");
  t.mock.timers.tick(51);
  assert.equal(first.storage.readAvailability("book", 1, 100).en["opus-96"], "available");
});

test("English contains the literal translation keys used by the player and its panels", async () => {
  const modules = new URL("../js/", import.meta.url);
  const files = (await readdir(modules)).filter((file) => file.endsWith(".js"));
  const sources = await Promise.all(files.map((file) => readFile(new URL(file, modules), "utf8")));
  const keys = new Set(sources.flatMap((source) => [...source.matchAll(/\b(?:t|ot)\("([A-Za-z0-9]+)"/g)].map((match) => match[1])));
  assert.deepEqual([...keys].filter((key) => !(key in UI_STRINGS.en)), []);
});

test("the language picker keeps native names and localizes the automatic choice", () => {
  const browser = { languages: ["fr", "no-NO"], language: "da" };
  const locale = resolveUiLocale("auto", browser);
  assert.equal(locale, "nb");
  assert.equal(resolveUiLocale("dk", browser), "da");
  assert.equal(resolveUiLocale("fr", browser), "en");
  const [automatic, ...choices] = uiLanguageOptions(locale);
  assert.deepEqual(automatic, { value: "auto", label: translateAt("nb", "uiLanguageAuto") });
  assert.equal(choices.find(({ value }) => value === "nb").label, "Norsk (bokmål)");
  assert.deepEqual(choices.map(({ value }) => value), Object.keys(UI_STRINGS));
  assert.deepEqual(uiLanguageOptions("da").slice(1), choices);
});

test("all bundled locales contain the full English key set", () => {
  const required = Object.keys(UI_STRINGS.en);
  for (const [locale, values] of Object.entries(UI_STRINGS)) assert.deepEqual(required.filter((key) => !(key in values)), [], locale);
});

test("missing availability requires agreement from HEAD and Range", async () => {
  for (const [head, range, expected] of [
    [503, 404, "unknown"], [405, 410, "unknown"], [null, 404, "unknown"],
    [410, 503, "unknown"], [404, 410, "missing"], [410, 206, "available"],
  ]) {
    const fetchImpl = async (_url, { method }) => {
      if (method === "HEAD" && head === null) throw new TypeError("Connection interrupted");
      return response(method === "HEAD" ? head : range);
    };
    assert.equal(await probeUrl("https://example.test/audio", { fetchImpl }), expected, `HEAD ${head}, Range ${range}`);
  }
});
