import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBook, normalizeLibrary, resolveLanguageAsset } from "../js/config.js";
import { buildFallbackQueue, buildSources, chooseDefaultSource, mimeFor, visibleSources } from "../js/source-selection.js";

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

test("builds MIME evidence and one visible codec family", () => {
  const audio = { canPlayType: (mime) => mime.includes("opus") ? "probably" : "maybe" };
  const sources = buildSources({ baseUrl: "https://example.test/audio/", sources: { opus: { 96: "a.webm", 128: "b.webm" }, aac: { 128: "b.m4a" }, mp3: { 128: "b.mp3" } } }, audio);
  assert.equal(mimeFor("aac", "m4a"), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(chooseDefaultSource(sources).id, "opus-128");
  assert.deepEqual(visibleSources(sources).map((source) => source.id), ["opus-128", "opus-96"]);
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
