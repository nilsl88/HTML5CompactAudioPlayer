import test from "node:test";
import assert from "node:assert/strict";
import { PlayerStorage } from "../js/storage.js";
import { parseWebVtt } from "../js/vtt.js";

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

test("migrates legacy episode and UI preference names", () => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:book", JSON.stringify({ lang: "da", quality: "aac-96", progressByLang: { da: 42 }, lastTime: 12 }));
  memory.setItem("compactPlayer:ui", JSON.stringify({ uiLang: "sv", playbackRate: 9, volume: -2, skipSeconds: 30 }));
  const storage = new PlayerStorage(memory);
  assert.deepEqual(storage.readEpisode("book"), { schemaVersion: 2, language: "da", quality: "aac-96", progressByLang: { da: 42 }, lastTime: 12 });
  assert.equal(storage.readUi().uiLanguage, "sv");
  assert.equal(storage.readUi().playbackRate, 2);
  assert.equal(storage.readUi().volume, 0);
});

test("corrupt storage does not block startup", () => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:book", "{broken");
  const storage = new PlayerStorage(memory);
  assert.equal(storage.readEpisode("book").lastTime, 0);
  assert.deepEqual(storage.readEpisode("book").progressByLang, {});
});

test("reads legacy availability cache values", () => {
  const memory = new MemoryStorage();
  memory.setItem("cap_avail_book_v1", JSON.stringify({ ts: Date.now(), existsByLang: { en: { "opus-96": true } } }));
  assert.equal(new PlayerStorage(memory).readAvailability("book", 1).en["opus-96"], true);
});

test("stores chapters by episode, language, version, and URL", () => {
  const memory = new MemoryStorage();
  const storage = new PlayerStorage(memory);
  const text = "WEBVTT\n\n00:00.000 --> 00:10.000\nOpening";
  assert.equal(storage.writeChapters("book", "en", 1, "https://example.test/en.vtt", text), true);
  assert.equal(storage.readChapters("book", "en", 1, "https://example.test/en.vtt"), text);
  assert.equal(storage.readChapters("book", "da", 1, "https://example.test/en.vtt"), "");
  assert.equal(storage.readChapters("book", "en", 2, "https://example.test/en.vtt"), "");
  assert.equal(storage.readChapters("book", "en", 1, "https://example.test/other.vtt"), "");
  storage.reset();
  assert.equal(storage.readChapters("book", "en", 1, "https://example.test/en.vtt"), "");
});

test("chapter cache replaces obsolete versions and rejects corrupt values", () => {
  const memory = new MemoryStorage();
  const storage = new PlayerStorage(memory);
  storage.writeChapters("book", "en", 1, "/chapters.vtt", "WEBVTT\n");
  storage.writeChapters("book", "en", 2, "/chapters.vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\nNew");
  assert.equal(storage.readChapters("book", "en", 1, "/chapters.vtt"), "");
  memory.setItem("compactPlayer:chapters:book:en:2", "{broken");
  assert.equal(storage.readChapters("book", "en", 2, "/chapters.vtt"), "");
});

test("parses real-world WebVTT without retaining cue markup", () => {
  const cues = parseWebVtt(`WEBVTT\nKind: chapters\n\nintro\n00:00.000 --> 00:10.000 align:start\n<v Narrator>Intro &amp; setup</v>\n\nNOTE ignored\ntext\n\n00:10,000 --> 00:20,000\nSecond\nline\n\n00:bad --> 00:30.000\nInvalid`);
  assert.deepEqual(cues, [
    { start: 0, end: 10, title: "Intro & setup" },
    { start: 10, end: 20, title: "Second line" },
  ]);
});

test("keeps overlapping cues ordered and drops exact duplicates", () => {
  const cues = parseWebVtt(`WEBVTT\n\n00:05.000 --> 00:10.000\nTwo\n\n00:00.000 --> 00:08.000\nOne\n\n00:00.000 --> 00:08.000\nOne`);
  assert.deepEqual(cues.map((cue) => cue.title), ["One", "Two"]);
});
