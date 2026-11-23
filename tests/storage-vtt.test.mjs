import test from "node:test";
import assert from "node:assert/strict";
import { PlayerStorage } from "../js/storage.js?v=20";
import { parseWebVtt } from "../js/vtt.js?v=20";

class MemoryStorage {
  map = new Map();
  get length() { return this.map.size; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  key(index) { return [...this.map.keys()][index] ?? null; }
}

test("migrates legacy book and UI preference names", (t) => {
  const memory = new MemoryStorage();
  memory.setItem("compactPlayer:book", JSON.stringify({ lang: "da", quality: "aac-96", progressByLang: { da: 42 }, lastTime: 12 }));
  memory.setItem("compactPlayer:ui", JSON.stringify({ uiLang: "sv", playbackRate: 9, volume: -2, skipSeconds: 30 }));
  const storage = new PlayerStorage(memory);
  const positions = t.mock.method(storage, "positionRecords");
  assert.deepEqual(storage.readBookSelection("book"), { language: "da", quality: "aac-96" });
  assert.equal(positions.mock.callCount(), 0);
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

test("refreshing chapters and clearing probes only touches the current installation", () => {
  const memory = new MemoryStorage();
  const first = new PlayerStorage(memory, "https://example.test/one/");
  const other = new PlayerStorage(memory, "https://example.test/two/");
  const url = "https://example.test/shared/chapters.vtt";
  const audio = "https://example.test/shared/audio.mp3";
  for (const store of [first, other]) {
    store.writeChapters("book", "en", 1, url, "First edition");
    store.availabilityCache("book", 1).recordProbe("en", "mp3-64", "available", audio);
  }
  first.writeChapters("book", "en", 2, url, "Second edition");
  first.clearAvailability("book", 1);
  assert.equal(first.readChapters("book", "en", 1, url), "");
  assert.equal(first.availabilityCache("book", 1).readProbe("en", "mp3-64", audio), "unknown");
  assert.equal(other.readChapters("book", "en", 1, url), "First edition");
  assert.equal(other.availabilityCache("book", 1).readProbe("en", "mp3-64", audio), "available");
});

test("confirmed playback expires and stale tabs cannot repopulate a cleared availability cache", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const storage = new PlayerStorage(new MemoryStorage());
  const url = "https://example.test/book.webm";
  const first = storage.availabilityCache("book", 1, 100);
  first.recordPlayback(url);
  assert.equal(storage.availabilityCache("book", 2).hasPlayed(url), false);
  t.mock.timers.tick(101);
  first.recordProbe("en", "opus-128", "missing", url);
  assert.equal(storage.availabilityCache("book", 1, 100).hasPlayed(url), false);
  for (const clear of [() => storage.clearAvailability("book", 1), () => storage.reset()]) {
    const old = storage.availabilityCache("book", 1);
    clear();
    old.recordPlayback(url);
    old.recordProbe("en", "opus-128", "missing", url);
    assert.deepEqual(storage.readAvailabilityCache("book", 1), { playedUrls: [], byLanguage: {} });
  }
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

  // Prior releases used the same chapter keys before and after a reset.
  memory.setItem(storage.resetKey, "previous-reset");
  memory.setItem(storage.prefix + "compactPlayer:chapters:book:en:2", JSON.stringify({
    kind: "vtt", url: "/chapters.vtt", text: "WEBVTT\n",
  }));
  assert.equal(storage.readChapters("book", "en", 2, "/chapters.vtt"), "WEBVTT\n");
  storage.writeChapters("book", "en", 3, "/chapters.vtt", "WEBVTT\n");
  assert.equal(storage.readChapters("book", "en", 2, "/chapters.vtt"), "");
});

test("chapter cache applies the byte limit to Unicode text and legacy entries", () => {
  const memory = new MemoryStorage();
  const storage = new PlayerStorage(memory);
  const url = "/chapters.vtt";
  const key = storage.prefix + "compactPlayer:chapters:book:en:1";
  const tooLarge = "漢".repeat(180_000);
  const withinLimit = "漢".repeat(1000);
  const atLimit = "é".repeat(256 * 1024);
  assert.equal(storage.writeChapters("book", "en", 1, url, atLimit), true);
  assert.equal(storage.readChapters("book", "en", 1, url), atLimit);
  assert.equal(storage.writeChapters("book", "en", 1, url, atLimit + "a"), false);
  assert.equal(storage.writeChapters("book", "en", 1, url, tooLarge), false);
  memory.setItem(key, JSON.stringify({ url, text: tooLarge }));
  assert.equal(storage.readChapters("book", "en", 1, url), "");
  memory.setItem(key, JSON.stringify({ url, text: withinLimit }));
  assert.equal(storage.readChapters("book", "en", 1, url), withinLimit);
  const source = "embedded:audio.m4b";
  const chapterKey = key + ":" + encodeURIComponent(source);
  const cues = [{ start: 0, end: 10, title: tooLarge }];
  assert.equal(storage.writeChapterData("book", "en", 1, source, { kind: "embedded", cues }), false);
  memory.setItem(chapterKey, JSON.stringify({ kind: "embedded", sourceKey: source, cues }));
  assert.equal(storage.readChapterData("book", "en", 1, source), null);
  cues[0].title = withinLimit;
  memory.setItem(chapterKey, JSON.stringify({ kind: "embedded", sourceKey: source, cues }));
  assert.deepEqual(storage.readChapterData("book", "en", 1, source), { kind: "embedded", cues });
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

test("WebVTT preserves chapters and multiline titles with CR, LF and CRLF line endings", () => {
  const lines = ["\uFEFFWEBVTT", "", "00:00.000 --> 00:04.500", "Opening", "credits", "",
    "00:04.500 --> 00:09.000", "Chapter two"];
  const expected = [
    { start: 0, end: 4.5, title: "Opening credits" },
    { start: 4.5, end: 9, title: "Chapter two" },
  ];
  for (const separator of ["\r", "\n", "\r\n"]) {
    assert.deepEqual(parseWebVtt(lines.join(separator)), expected, JSON.stringify(separator));
  }
});

test("WebVTT requires complete start and end timestamps and preserves both millisecond separators", () => {
  const invalid = ["00:01oops.000", "00:01.000x", "00:0.000", "1x:00:01.000", "00:60.000", "00:01.0", "00:01"];
  const badCues = invalid.flatMap((stamp) => [
    stamp + " --> 00:03.000\nBad start", "00:00.000 --> " + stamp + "\nBad end",
  ]);
  const text = ["WEBVTT", "00:00,250 --> 00:01.750 align:start\nOpening", ...badCues,
    "00:05.000 --> 00:04.000\nBackwards", "00:06.000 --> 00:06.000\nEmpty interval",
    "100:02:03.004 --> 100:02:04,005\nClosing"].join("\n\n");
  assert.deepEqual(parseWebVtt(text), [
    { start: 0.25, end: 1.75, title: "Opening" },
    { start: 360123.004, end: 360124.005, title: "Closing" },
  ]);
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

test("interleaved progress writes for two languages preserve both positions and legacy data", () => {
  const memory = new MemoryStorage();
  const first = new PlayerStorage(memory);
  const second = new PlayerStorage(memory);
  memory.setItem(first.prefix + "book:book::progress", JSON.stringify({ progressByLang: { sv: 30 }, lastTime: 30 }));
  const write = memory.setItem.bind(memory);
  memory.setItem = (key, value) => {
    memory.setItem = write;
    second.setProgress("book", "da", 20, { updatedAt: 20 });
    write(key, value);
  };
  first.setProgress("book", "en", 10, { updatedAt: 10 });
  const prefs = new PlayerStorage(memory).readBook("book");
  assert.deepEqual(prefs.progressByLang, { en: 10, da: 20, sv: 30 });
  assert.equal(prefs.lastTime, 20);
});

test("concurrent saves in one language preserve the latest activity, including a backward seek", () => {
  const memory = new MemoryStorage();
  const first = new PlayerStorage(memory);
  const second = new PlayerStorage(memory);
  const legacy = first.prefix + "book:book::progress:en";
  memory.setItem(legacy, JSON.stringify({ seconds: 40, updatedAt: 5 }));
  assert.equal(first.getProgress("book", "en"), 40);
  const write = memory.setItem.bind(memory);
  memory.setItem = (key, value) => {
    memory.setItem = write;
    second.setProgress("book", "en", 90, { updatedAt: 20, previousUpdate: 5 });
    write(key, value);
  };
  first.setProgress("book", "en", 10, { updatedAt: 10, previousUpdate: 5 });
  const reader = new PlayerStorage(memory);
  assert.equal(reader.getProgress("book", "en"), 90);
  assert.equal(reader.progressTimestamp("book", "", "en"), 20);
  first.setProgress("book", "en", 3, { updatedAt: 30 });
  assert.equal(reader.getProgress("book", "en"), 3);
  assert.equal([...memory.map.keys()].filter((key) => key.startsWith(legacy + ":")).length, 1);
});
