import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate as settle } from "node:timers/promises";
import { probeUrl } from "../js/availability.js";
import { openPlayerPage } from "./player-page.mjs";
import { UI_STRINGS } from "../i18n.js";

function response(status) {
  return { status, ok: status >= 200 && status < 300, body: { cancel: async () => {} } };
}

test("availability uses Range when HEAD is unsupported", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => { methods.push(options.method); return options.method === "HEAD" ? response(405) : response(206); };
  assert.equal(await probeUrl("https://example.test/audio", { fetchImpl }), "available");
  assert.deepEqual(methods, ["HEAD", "GET"]);
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

test("English contains every literal translation key used by the coordinator", async () => {
  const source = await readFile(new URL("../js/player-app.js", import.meta.url), "utf8");
  const keys = new Set([...source.matchAll(/\bt\("([A-Za-z0-9]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...keys].filter((key) => !(key in UI_STRINGS.en)), []);
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
