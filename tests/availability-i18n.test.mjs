import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { probeUrl } from "../js/availability.js";
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

test("English contains every literal translation key used by the coordinator", async () => {
  const source = await readFile(new URL("../player.js", import.meta.url), "utf8");
  const keys = new Set([...source.matchAll(/\bt\("([A-Za-z0-9]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...keys].filter((key) => !(key in UI_STRINGS.en)), []);
});

test("all bundled locales contain the full English key set", () => {
  const required = Object.keys(UI_STRINGS.en);
  for (const [locale, values] of Object.entries(UI_STRINGS)) assert.deepEqual(required.filter((key) => !(key in values)), [], locale);
});
