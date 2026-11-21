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

test("migrates legacy book and UI preference names", () => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:book", JSON.stringify({ lang: "da", quality: "aac-96", progressByLang: { da: 42 }, lastTime: 12 }));
  memory.setItem("compactPlayer:ui", JSON.stringify({ uiLang: "sv", playbackRate: 9, volume: -2, skipSeconds: 30 }));
  const storage = new PlayerStorage(memory);
  assert.deepEqual(storage.readBook("book"), { schemaVersion: 2, language: "da", quality: "aac-96", progressByLang: { da: 42 }, progressUpdatedAt: {}, lastTime: 12 });
  assert.equal(storage.readUi().uiLanguage, "sv");
  assert.equal(storage.readUi().playbackRate, 2);
  assert.equal(storage.readUi().volume, 0);
});

test("corrupt storage does not block startup", () => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:book", "{broken");
  const storage = new PlayerStorage(memory);
  assert.equal(storage.readBook("book").lastTime, 0);
  assert.deepEqual(storage.readBook("book").progressByLang, {});
});

test("book IDs that match settings keys preserve progress, appearance and catalog selection", () => {
  const memory = new MemoryStorage();
  const storage = new PlayerStorage(memory);
  storage.writeUi({ theme: "dark", playbackRate: 1.5 });
  storage.setLastBook("north");
  storage.setProgress("ui", "en", 80);
  storage.setProgress("lastEpisode", "en", 90);
  assert.equal(storage.readUi().theme, "dark");
  assert.equal(storage.readUi().playbackRate, 1.5);
  assert.equal(storage.getLastBook(), "north");
  storage.writeUi({ volume: 0.5 });
  storage.setLastBook("ui");
  assert.equal(storage.getProgress("ui", "en"), 80);
  assert.equal(storage.getProgress("lastEpisode", "en"), 90);

  const legacy = new MemoryStorage();
  const previous = new PlayerStorage(legacy);
  const record = JSON.stringify({ progressByLang: { en: 42 }, quality: "aac-96" });
  legacy.setItem(previous.prefix + "compactPlayer:ui", record);
  legacy.setItem(previous.prefix + "compactPlayer:lastEpisode", record);
  previous.writeUi({ theme: "light" });
  previous.setLastBook("another");
  for (const id of ["ui", "lastEpisode"]) {
    assert.equal(previous.getProgress(id, "en"), 42);
    assert.equal(previous.readBook(id).quality, "aac-96");
  }
});

test("old book records migrate to installation storage and preserve the last selection key", () => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:lastEpisode", "episode-001");
  memory.setItem("compactPlayer:episode-001", JSON.stringify({ language: "en", quality: "aac-64", progressByLang: { en: 123, da: 456 } }));
  const storage = new PlayerStorage(memory);
  assert.equal(storage.getLastBook(), "episode-001");
  assert.equal(storage.getProgress("episode-001", "en"), 123);
  storage.setProgress("episode-001", "en", 789);
  storage.setLastBook("next");
  assert.equal(storage.readBook("episode-001").quality, "aac-64");
  assert.equal(storage.getProgress("episode-001", "da"), 456);
  assert.equal(memory.getItem(storage.prefix + "compactPlayer:lastEpisode"), "next");
  assert.equal(memory.getItem(storage.prefix + "compactPlayer:lastBook"), null);
  assert.equal(new PlayerStorage(memory).getProgress("episode-001", "en"), 789);
  assert.equal(memory.getItem("compactPlayer:lastEpisode"), "episode-001");
  assert.equal(JSON.parse(memory.getItem("compactPlayer:episode-001")).progressByLang.en, 123);
});

test("reads legacy availability cache values", () => {
  const memory = new MemoryStorage();
  memory.setItem("cap_avail_book_v1", JSON.stringify({ ts: Date.now(), existsByLang: { en: { "opus-96": true } } }));
  assert.equal(new PlayerStorage(memory).readAvailability("book", 1).en["opus-96"], true);
});

test("stores chapters by book, language, version, and URL", () => {
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
  memory.setItem(storage.prefix + "compactPlayer:chapters:book:en:2", "{broken");
  assert.equal(storage.readChapters("book", "en", 2, "/chapters.vtt"), "");
});

test("caches embedded chapter cues by active source", () => {
  const storage = new PlayerStorage(new MemoryStorage());
  const cues = [{ start: 0, end: 12, title: "Opening" }];
  assert.equal(storage.writeChapterData("book", "en", 1, "embedded:https://example.test/book.m4b", { kind: "embedded", cues }), true);
  assert.deepEqual(storage.readChapterData("book", "en", 1, "embedded:https://example.test/book.m4b"), { kind: "embedded", cues });
  assert.equal(storage.readChapterData("book", "en", 1, "embedded:https://example.test/other.m4b"), null);
});

test("legacy chapter copies migrate while current embedded sources and other languages remain readable", () => {
  const memory = new MemoryStorage();
  const storage = new PlayerStorage(memory);
  const url = "https://example.test/chapters.vtt";
  const text = "WEBVTT\n\n00:00.000 --> 00:10.000\nOpening";
  const key = storage.prefix + "compactPlayer:chapters:book:en:2";
  const autoSource = "auto:" + url + "|audio.m4b";
  memory.setItem(key + ":" + encodeURIComponent(autoSource), JSON.stringify({ kind: "vtt", sourceKey: autoSource, text }));
  const cues = [{ start: 0, end: 10, title: "Opening" }];
  storage.writeChapterData("book", "da", 1, "embedded:dansk", { kind: "embedded", cues });
  for (const source of ["embedded:large", "embedded:small"]) {
    storage.writeChapterData("book", "en", 2, source, { kind: "embedded", cues });
  }
  assert.equal(storage.readChapterData("book", "en", 2, autoSource, url).text, text);
  assert.equal(memory.getItem(key + ":" + encodeURIComponent(autoSource)), null);
  assert.equal(storage.readChapterData("book", "en", 2, "auto:other-quality", url).text, text);
  for (const source of ["embedded:large", "embedded:small"]) assert.deepEqual(storage.readChapterData("book", "en", 2, source).cues, cues);
  storage.writeChapterData("book", "en", 20, "embedded:small", { kind: "embedded", cues });
  assert.equal(storage.readChapterData("book", "en", 2, "embedded:small"), null);
  assert.equal(storage.readChapters("book", "en", 2, url), "");
  assert.deepEqual(storage.readChapterData("book", "da", 1, "embedded:dansk").cues, cues);
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
