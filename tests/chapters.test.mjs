import test from "node:test";
import assert from "node:assert/strict";
import { CHAPTER_REQUEST_TIMEOUT_MS, loadChapterFile } from "../js/chapters.js";

test("chapter requests use the browser cache and parse WebVTT", async () => {
  let requestOptions;
  const fetchImpl = async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      text: async () => "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nOpening",
    };
  };

  const result = await loadChapterFile("https://example.test/chapters.vtt", { fetchImpl });

  assert.equal(requestOptions.cache, "default");
  assert.equal(requestOptions.credentials, "same-origin");
  assert.equal(result.cues[0].title, "Opening");
  assert.equal(CHAPTER_REQUEST_TIMEOUT_MS, 20000);
});

test("chapter requests report HTTP failures", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  await assert.rejects(
    loadChapterFile("https://example.test/missing.vtt", { fetchImpl }),
    /HTTP 404/,
  );
});
