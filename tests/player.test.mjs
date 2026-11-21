import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import { openPlayerPage } from "./player-page.mjs";
import { PlayerStorage } from "../js/storage.js";

const book = {
  id: "sample", defaultLanguage: "en", title: { en: "Sample audiobook" },
  languages: { en: { sources: { aac: { 96: "sample.m4b" } } } },
};

test("reset clears only this installation's progress, even for a shared book ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map([["compactPlayer:sample", JSON.stringify({ progressByLang: { en: 45 } })]]);
  const restore = [];
  t.after(() => { for (const cleanup of restore.reverse()) cleanup(); });
  async function visit(path, reload = assert.fail) {
    const location = Object.assign(new URL(path, "https://example.test"), { reload });
    const page = await openPlayerPage({ after: (cleanup) => restore.push(cleanup) },
      { ...book, duration: 600 }, assert.fail, saved, { location });
    return page.elements;
  }
  function seek(elements, value) {
    elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    const slider = elements.get("seek");
    assert.equal(slider.disabled, false);
    slider.value = value;
    slider.dispatchEvent(new Event("change"));
  }

  const second = await visit("/books/kids/");
  assert.equal(second.get("timeCur").textContent, "0:45");
  seek(second, 500);
  let reloaded;
  const reset = new Promise((resolve) => { reloaded = resolve; });
  const first = await visit("/books/index.html?book=sample", reloaded);
  assert.equal(first.get("timeCur").textContent, "0:45");
  seek(first, 250);
  first.get("resetOk").dispatchEvent(new Event("click"));
  await reset;

  assert.equal((await visit("/books/kids/")).get("timeCur").textContent, "5:00");
  assert.equal((await visit("/books/")).get("timeCur").textContent, "0:00");
  assert.equal(JSON.parse(saved.get("compactPlayer:sample")).progressByLang.en, 45);
});

test("a passive tab and a delayed progress save preserve the latest listening position", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const saved = new Map();
  const restore = [];
  t.after(() => { for (const cleanup of restore.reverse()) cleanup(); });
  const visit = () => openPlayerPage({ after: (cleanup) => restore.push(cleanup) }, { ...book, duration: 600 }, assert.fail, saved);
  function listen(page, seconds) {
    page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    page.audio.duration = 600;
    page.audio.dispatchEvent(new Event("loadedmetadata"));
    page.audio.dispatchEvent(new Event("playing"));
    page.audio.currentTime = seconds;
    page.audio.dispatchEvent(new Event("timeupdate"));
  }
  const passive = await visit();
  const first = await visit();
  listen(first, 10);
  first.audio.currentTime = 20;
  first.audio.dispatchEvent(new Event("timeupdate"));
  const second = await visit();
  listen(second, 300);
  second.document.visibilityState = "hidden";
  second.document.dispatchEvent(new Event("visibilitychange"));
  first.window.dispatchEvent(new Event("pagehide"));
  passive.window.dispatchEvent(new Event("pagehide"));
  assert.equal((await visit()).elements.get("timeCur").textContent, "5:00");

  const slider = second.elements.get("seek");
  slider.value = "100";
  slider.dispatchEvent(new Event("change"));
  passive.window.dispatchEvent(new Event("pagehide"));
  assert.equal((await visit()).elements.get("timeCur").textContent, "1:00");
});

function queueListeningPosition(page) {
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  page.audio.duration = 600;
  page.audio.dispatchEvent(new Event("loadedmetadata"));
  page.audio.dispatchEvent(new Event("playing"));
  for (const seconds of [10, 20]) {
    page.audio.currentTime = seconds;
    page.audio.dispatchEvent(new Event("timeupdate"));
  }
}

test("a reset invalidates queued positions from another tab, including after a second reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const restore = [];
  t.after(() => { for (const cleanup of restore.reverse()) cleanup(); });
  const visit = (location = new URL("https://example.test/")) => openPlayerPage(
    { after: (cleanup) => restore.push(cleanup) }, book, assert.fail, saved, { location });
  for (let attempt = 0; attempt < 2; attempt++) {
    const listener = await visit();
    queueListeningPosition(listener);
    let reloaded;
    const reset = new Promise((resolve) => { reloaded = resolve; });
    const tab = await visit(Object.assign(new URL("https://example.test/"), { reload: reloaded }));
    tab.elements.get("resetOk").dispatchEvent(new Event("click"));
    await reset;
    listener.window.dispatchEvent(new Event("pagehide"));
    assert.equal((await visit()).elements.get("timeCur").textContent, "0:00");
    listener.audio.currentTime = 30;
    listener.audio.dispatchEvent(new Event("timeupdate"));
    listener.window.dispatchEvent(new Event("pagehide"));
    assert.equal((await visit()).elements.get("timeCur").textContent, "0:30");
  }
});

test("a queued position preserves a subsequent quality selection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = await openPlayerPage(t, { ...book,
    languages: { en: { sources: { aac: { 96: "high.m4b", 64: "low.m4b" } } } } }, assert.fail);
  queueListeningPosition(page);
  const quality = page.elements.get("qualitySelect");
  quality.value = "aac-64";
  quality.dispatchEvent(new Event("change"));
  page.window.dispatchEvent(new Event("pagehide"));
  const saved = PlayerStorage.fromBrowser();
  assert.equal(saved.readBook(book.id).quality, "aac-64");
  assert.equal(saved.getProgress(book.id, "en"), 20);
});

test("chapter updates keep one WebVTT copy and discard older versions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const restore = [];
  t.after(() => { for (const cleanup of restore.reverse()) cleanup(); });
  const chapterUrl = "https://example.test/media/sample/chapters.vtt";
  const text = "WEBVTT\n\n00:00.000 --> 00:10.000\nOpening";
  const series = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  let requests = 0;
  const visit = (cacheVersion) => openPlayerPage({ after: (cleanup) => restore.push(cleanup) },
    { ...series, cacheVersion }, (url) => { assert.equal(url, chapterUrl); requests++; return new Response(text); }, saved);
  await visit(1);
  await visit(2);
  await visit(2);
  assert.equal(requests, 2);
  const copies = [...saved.entries()].filter(([key, value]) => key.includes("chapters:sample:en:") && JSON.parse(value).text === text);
  assert.equal(copies.length, 1);
  assert.ok(copies[0][0].includes("chapters:sample:en:2"));
});

test("pausing while offline keeps playback paused after reconnecting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audio, elements, navigator, window } = await openPlayerPage(t, book, assert.fail);
  const button = elements.get("playPauseBtn");
  const play = t.mock.method(audio, "play");
  function setOnline(online) {
    navigator.onLine = online;
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  }

  button.dispatchEvent(new Event("click"));
  audio.dispatchEvent(new Event("playing"));
  setOnline(false);
  audio.dispatchEvent(new Event("waiting"));
  setOnline(true);
  assert.equal(play.mock.callCount(), 2, "interrupted playback resumes");

  audio.dispatchEvent(new Event("playing"));
  setOnline(false);
  audio.dispatchEvent(new Event("waiting"));
  const pause = t.mock.method(audio, "pause");
  button.dispatchEvent(new Event("click"));
  assert.equal(pause.mock.callCount(), 1);
  t.mock.timers.tick(60_000);
  audio.dispatchEvent(new Event("error"));
  setOnline(true);
  assert.equal(play.mock.callCount(), 2, "reconnecting respects the latest pause");
  button.dispatchEvent(new Event("click"));
  assert.equal(play.mock.callCount(), 3, "the listener can resume manually");
});

test("the player starts and accepts Play when accessing localStorage throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audio, elements } = await openPlayerPage(t, book, assert.fail, null);
  assert.throws(() => globalThis.localStorage, { name: "SecurityError" });
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.ok(!audio.src);

  const button = elements.get("playPauseBtn");
  assert.equal(button.disabled, false);
  const play = t.mock.method(audio, "play");
  button.dispatchEvent(new Event("click"));
  audio.dispatchEvent(new Event("playing"));
  assert.equal(play.mock.callCount(), 1);
  assert.ok(audio.src.endsWith("/sample.m4b"));
});

test("the player starts and plays online when access to Cache Storage is blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audio, elements } = await openPlayerPage(t, book, assert.fail, new Map(), {
    navigator: { onLine: true, language: "en", serviceWorker: {} },
    get caches() { throw new DOMException("Cache Storage is blocked.", "SecurityError"); },
  });
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.equal(elements.get("offlineRow").hidden, true);
  assert.ok(!audio.src);
  const button = elements.get("playPauseBtn");
  assert.equal(button.disabled, false);
  const play = t.mock.method(audio, "play");
  button.dispatchEvent(new Event("click"));
  assert.equal(play.mock.callCount(), 1);
  assert.ok(audio.src.endsWith("/sample.m4b"));
});

test("click and Space can pause the first play request while it is loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audio, elements, document, navigator, window } = await openPlayerPage(t, book, assert.fail);
  const button = elements.get("playPauseBtn");
  let finishPlay;
  const play = t.mock.method(audio, "play", () => new Promise((resolve) => { finishPlay = resolve; }));
  const pause = t.mock.method(audio, "pause");
  for (const action of ["click", "Space"]) {
    button.dispatchEvent(new Event("click"));
    assert.equal(button.dataset.tooltip, "Pause");
    navigator.onLine = false;
    window.dispatchEvent(new Event("offline"));
    audio.dispatchEvent(new Event("waiting"));
    const previousPauses = pause.mock.callCount();
    if (action === "click") button.dispatchEvent(new Event("click"));
    else document.dispatchEvent(Object.assign(new Event("keydown"), { code: action }));
    assert.equal(pause.mock.callCount(), previousPauses + 1);
    const previousPlays = play.mock.callCount();
    finishPlay();
    await settle();
    navigator.onLine = true;
    window.dispatchEvent(new Event("online"));
    assert.equal(play.mock.callCount(), previousPlays);
    assert.equal(button.dataset.tooltip, "Play");
  }
});

const invalidLanguageBook = { ...book, languages: {
  ...book.languages, da: { sources: { aac: { 96: "http://" } } },
} };

test("an unusable preferred audio language falls back to the book default at startup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, audio } = await openPlayerPage(t, invalidLanguageBook, assert.fail, new Map(), {
    navigator: { onLine: true, language: "da" },
  });
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.deepEqual(elements.get("langSelect").children.map((option) => option.value), ["en"]);
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(audio.src.endsWith("/sample.m4b"));
});

test("a rejected language switch preserves the playing source and its listening position", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = await openPlayerPage(t, invalidLanguageBook, assert.fail);
  queueListeningPosition(page);
  const src = page.audio.src;
  const language = page.elements.get("langSelect");
  language.value = "da";
  language.dispatchEvent(new Event("change"));
  page.audio.currentTime = 42;
  page.audio.dispatchEvent(new Event("timeupdate"));
  page.window.dispatchEvent(new Event("pagehide"));
  assert.equal(language.value, "en");
  assert.equal(page.audio.src, src);
  assert.deepEqual(PlayerStorage.fromBrowser().readBook(book.id).progressByLang, { en: 42 });
});

const chapterText = "WEBVTT\n\n00:00.000 --> 00:10.000\nIntroduction";

test("chapter sleep respects a newer timer choice while the chapter file is loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let finish;
  const { elements } = await openPlayerPage(t, { ...book, languages: { en: { ...book.languages.en, chapters: "en.vtt" } } },
    () => new Promise((resolve) => { finish = resolve; }));
  const choices = elements.get("sleepList");
  choices.children[0].dispatchEvent(new Event("click"));
  choices.children[1].dispatchEvent(new Event("click"));
  const timer = elements.get("sleepBtn");
  assert.match(timer.dataset.tooltip, /5 min/);
  finish(new Response(chapterText));
  await settle();
  assert.match(timer.dataset.tooltip, /5 min/);
  choices.children[0].dispatchEvent(new Event("click"));
  await settle();
  assert.match(timer.dataset.tooltip, /End of chapter/);
});

test("chapter sleep requires a current chapter even when book duration is known", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements } = await openPlayerPage(t, { ...book, duration: 28800 }, assert.fail);
  elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
  await settle();
  assert.equal(elements.get("sleepBtn").dataset.tooltip, "Sleep timer");
  assert.match(elements.get("statusAnnouncer").textContent, /unavailable/i);
});

test("switching language loads WebVTT while the new audio play request is still pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const { elements, audio } = await openPlayerPage(t, { ...book, languages: { en: book.languages.en,
    da: { chapters: "da.vtt", sources: { aac: { 96: "da.m4b" } } },
  } }, (url) => { calls.push(new URL(url).pathname); return new Response(chapterText); });
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  audio.dispatchEvent(new Event("playing"));
  let finishPlay;
  audio.play = () => new Promise((resolve) => { finishPlay = resolve; });
  const language = elements.get("langSelect");
  language.value = "da";
  language.dispatchEvent(new Event("change"));
  await settle();
  assert.ok(audio.src.endsWith("/da.m4b"));
  assert.deepEqual(calls, ["/media/sample/da.vtt"]);
  assert.equal(elements.get("chaptersList").children[0].children[0].textContent, "Introduction");
  finishPlay();
  await settle();
  assert.equal(calls.length, 1);
});
