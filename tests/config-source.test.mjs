import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBook, normalizeLibrary, resolveCover, resolveLanguageAsset } from "../js/config.js?v=25";
import { buildFallbackQueue, buildSources, chooseDefaultSource, mimeFor, visibleSources } from "../js/source-selection.js?v=25";

test("normalizes the documented book schema without changing paths", () => {
  const book = normalizeBook({
    id: "book",
    defaultLanguage: "en-US",
    languages: {
      en: { label: "English", basePath: "media/book/en/", chapters: "chapters.vtt", sources: { opus: { 96: "audio.webm" }, mp3: { 128: "audio.mp3" } } },
    },
  }, { bookBaseUrl: "https://example.test/media/book/", documentBaseUrl: "https://example.test/" });
  assert.equal(book.defaultLanguage, "en");
  assert.equal(book.languages.en.chapterSource, "vtt");
  assert.equal(resolveLanguageAsset(book.languages.en, "audio.webm"), "https://example.test/media/book/en/audio.webm");
  assert.equal(resolveLanguageAsset(book.languages.en, "chapters.vtt"), "https://example.test/media/book/en/chapters.vtt");
});

test("normalizes explicit embedded chapter modes", () => {
  const book = normalizeBook({
    id: "book",
    defaultLanguage: "en",
    languages: {
      en: { label: "English", chapterSource: "embedded", sources: { aac: { 128: "book.m4b" } } },
    },
  }, { bookBaseUrl: "https://example.test/media/book/", documentBaseUrl: "https://example.test/" });
  assert.equal(book.languages.en.chapterSource, "embedded");
  assert.equal(book.languages.en.chapters, "");
});

test("normalizes cover source modes without changing legacy behavior", () => {
  const context = { bookBaseUrl: "https://example.test/media/book/", documentBaseUrl: "https://example.test/" };
  const base = { id: "book", defaultLanguage: "en", languages: { en: { sources: { aac: { 128: "book.m4b" } } } } };
  assert.equal(normalizeBook({ ...base, cover: "cover.webp" }, context).coverSource, "file");
  assert.equal(normalizeBook({ ...base, coverSource: "embedded" }, context).coverSource, "embedded");
  assert.equal(normalizeBook(base, context).coverSource, "none");
});

test("supports legacy library collection aliases", () => {
  const library = normalizeLibrary({ defaultId: "two", episodes: [{ id: "one" }, { id: "two", path: "nested/two" }] });
  assert.equal(library.defaultId, "two");
  assert.equal(library.byId.get("two").folder, "nested/two");
});

test("accepts a minimal library index and defaults folders to IDs", () => {
  const library = normalizeLibrary({ default: "one", audiofiles: [{ id: "one" }, { id: "two" }] });
  assert.equal(library.defaultId, "one");
  assert.equal(library.ui.onboardingEnabled, true);
  assert.deepEqual(library.books.map(({ id, folder, title }) => ({ id, folder, title })), [
    { id: "one", folder: "one", title: null },
    { id: "two", folder: "two", title: null },
  ]);
});

test("preserves significant whitespace in library folder paths", () => {
  const library = normalizeLibrary({ books: [{ id: "war", folder: "The_Art_of_War " }] });
  assert.equal(library.books[0].folder, "The_Art_of_War ");
});

test("normalizes onboarding as a library-wide setting", () => {
  assert.equal(normalizeLibrary({ ui: { onboardingEnabled: false }, audiofiles: [{ id: "one" }] }).ui.onboardingEnabled, false);
  assert.equal(normalizeLibrary({ ui: { onboardingEnabled: true }, audiofiles: [{ id: "one" }] }).ui.onboardingEnabled, true);
});

test("rejects unsafe library traversal", () => {
  const library = normalizeLibrary({ audiofiles: [{ id: "bad", folder: "../secret" }, { id: "good", folder: "good" }] });
  assert.deepEqual(library.books.map((item) => item.id), ["good"]);
});

test("rejects traversal in configured media paths while preserving ordinary URLs", () => {
  const context = { bookBaseUrl: "https://example.test/media/book/", documentBaseUrl: "https://example.test/" };
  for (const path of ["../secret.mp3", "nested/../../secret.mp3", "%2e%2e/secret.mp3",
    "nested/%2E%2e%2fsecret.mp3", "..\\secret.mp3", ".\t./secret.mp3"]) {
    const book = normalizeBook({ id: "book", defaultLanguage: "en", cover: path,
      languages: { en: { chapters: path, sources: { mp3: { 64: path, 128: "audio.mp3" } } } } }, context);
    assert.deepEqual(book.languages.en.sources.mp3, { 128: "audio.mp3" }, path);
    assert.equal(resolveLanguageAsset(book.languages.en, path), "", path);
    assert.equal(resolveCover(book), "", path);
    assert.throws(() => normalizeBook({ id: "book", defaultLanguage: "en",
      languages: { en: { basePath: path, sources: { mp3: { 64: "audio.mp3" } } } } }, context), /no usable languages/);
  }
  const book = normalizeBook({ id: "book", defaultLanguage: "en",
    languages: { en: { sources: { mp3: { 64: "./nested/audio%20one.mp3?x=../ok", 128: "https://cdn.example/audio.mp3" } } } } }, context);
  assert.equal(resolveLanguageAsset(book.languages.en, "./nested/audio%20one.mp3?x=../ok"),
    "https://example.test/media/book/nested/audio%20one.mp3?x=../ok");
  assert.equal(resolveLanguageAsset(book.languages.en, "https://cdn.example/audio.mp3"), "https://cdn.example/audio.mp3");
});

test("builds MIME evidence and one visible codec family", () => {
  const audio = { canPlayType: (mime) => mime.includes("opus") ? "probably" : "maybe" };
  const sources = buildSources({ baseUrl: "https://example.test/audio/", sources: { opus: { 96: "a.webm", 128: "b.webm" }, aac: { 128: "b.m4a" }, mp3: { 128: "b.mp3" } } }, audio);
  assert.equal(mimeFor("aac", "m4a"), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(chooseDefaultSource(sources).id, "opus-128");
  assert.deepEqual(visibleSources(sources).map((source) => source.id), ["opus-128", "opus-96"]);
});

test("Ogg Opus files with the opus extension use Ogg evidence for selection", () => {
  const audio = { canPlayType: (mime) => mime.startsWith("audio/ogg") || mime === "audio/mpeg" ? "probably" : "" };
  const baseUrl = "https://example.test/audio/";
  for (const path of ["book.opus", "book.OPUS?token=1", "book.ogg", "book.webm"]) {
    const sources = buildSources({ baseUrl, sources: { opus: { 96: path }, mp3: { 96: "book.mp3" } } }, audio);
    const opus = sources.find((source) => source.codec === "opus");
    const ogg = !path.endsWith(".webm");
    assert.equal(opus.mime, ogg ? 'audio/ogg; codecs="opus"' : 'audio/webm; codecs="opus"', path);
    assert.equal(opus.support, ogg ? 2 : 0, path);
    assert.equal(chooseDefaultSource(sources).codec, ogg ? "opus" : "mp3", path);
    assert.deepEqual(visibleSources(sources).map((source) => source.codec), [ogg ? "opus" : "mp3"], path);
  }
});

test("uses HE-AAC MIME evidence when AAC-LC is not reported", () => {
  const audio = { canPlayType: (mime) => mime.includes("mp4a.40.5") ? "probably" : "" };
  const [source] = buildSources({ baseUrl: "https://example.test/audio/", sources: { aac: { 64: "book.m4b" } } }, audio);
  assert.equal(source.mime, 'audio/mp4; codecs="mp4a.40.5"');
  assert.equal(source.support, 2);
});

test("fallback queue is deterministic and contains no duplicate URL", () => {
  const sources = [
    { id: "opus-128", codec: "opus", bitrate: 128, url: "o128", support: 2, availability: "unknown" },
    { id: "opus-96", codec: "opus", bitrate: 96, url: "o96", support: 2, availability: "unknown" },
    { id: "aac-128", codec: "aac", bitrate: 128, url: "a128", support: 1, availability: "unknown" },
    { id: "mp3-128", codec: "mp3", bitrate: 128, url: "m128", support: 1, availability: "missing" },
  ];
  assert.deepEqual(buildFallbackQueue(sources, "opus-128").map((source) => source.id), ["opus-128", "opus-96", "aac-128", "mp3-128"]);
});
