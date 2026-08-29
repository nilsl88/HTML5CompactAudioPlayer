import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEpisode, normalizeLibrary, resolveLanguageAsset } from "../js/config.js";
import { buildFallbackQueue, buildSources, chooseDefaultSource, mimeFor, visibleSources } from "../js/source-selection.js";

test("normalizes the documented episode schema without changing paths", () => {
  const episode = normalizeEpisode({
    id: "book",
    defaultLanguage: "en-US",
    languages: {
      en: { label: "English", basePath: "media/book/en/", chapters: "chapters.vtt", sources: { opus: { 96: "audio.webm" }, mp3: { 128: "audio.mp3" } } },
    },
  }, { episodeBaseUrl: "https://example.test/media/book/", documentBaseUrl: "https://example.test/" });
  assert.equal(episode.defaultLanguage, "en");
  assert.equal(resolveLanguageAsset(episode.languages.en, "audio.webm"), "https://example.test/media/book/en/audio.webm");
  assert.equal(resolveLanguageAsset(episode.languages.en, "chapters.vtt"), "https://example.test/media/book/en/chapters.vtt");
});

test("supports legacy library collection aliases", () => {
  const library = normalizeLibrary({ defaultId: "two", episodes: [{ id: "one" }, { id: "two", path: "nested/two" }] });
  assert.equal(library.defaultId, "two");
  assert.equal(library.byId.get("two").folder, "nested/two");
});

test("rejects unsafe library traversal", () => {
  const library = normalizeLibrary({ audiofiles: [{ id: "bad", folder: "../secret" }, { id: "good", folder: "good" }] });
  assert.deepEqual(library.episodes.map((item) => item.id), ["good"]);
});

test("builds MIME evidence and one visible codec family", () => {
  const audio = { canPlayType: (mime) => mime.includes("opus") ? "probably" : "maybe" };
  const sources = buildSources({ baseUrl: "https://example.test/audio/", sources: { opus: { 96: "a.webm", 128: "b.webm" }, aac: { 128: "b.m4a" }, mp3: { 128: "b.mp3" } } }, audio);
  assert.equal(mimeFor("aac", "m4a"), 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(chooseDefaultSource(sources).id, "opus-128");
  assert.deepEqual(visibleSources(sources).map((source) => source.id), ["opus-128", "opus-96"]);
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
