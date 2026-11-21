import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import { createCustomSelects } from "../js/custom-select.js";
import { deferred, Element, openPlayerPage } from "./player-page.mjs";
import { OfflineManager } from "../js/offline.js";

const book = {
  id: "sample", defaultLanguage: "en", title: { en: "Sample audiobook" },
  languages: { en: { sources: { aac: { 96: "sample.m4b" } } } },
};

test("custom selects commit a keyboard choice and restore focus on Escape", () => {
  const label = new Element();
  const document = { createElement() {
    const element = new Element();
    element.getBoundingClientRect = () => ({ top: 0, bottom: 10, height: 10 });
    return element;
  }, querySelector: () => label };
  const controls = createCustomSelects(document, { innerHeight: 600 });
  const select = Object.assign(new Element(), { id: "language", value: "da",
    options: [{ value: "da", textContent: "Dansk" }, { value: "en", textContent: "English" }] });
  Object.defineProperty(select, "selectedIndex", { get: () => select.options.findIndex((option) => option.value === select.value) });
  const wrapper = controls.selectWithArrow(select);
  assert.equal(wrapper.children[1].getAttribute("aria-hidden"), "true");
  wrapper.insertBefore = (button) => wrapper.children.unshift(button);
  select.closest = () => wrapper;
  let changes = 0;
  select.addEventListener("change", () => changes++);
  const { button, menu } = controls.enhanceCustomSelect(select);
  const key = (key) => button.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key }));
  assert.equal(button.getAttribute("role"), "combobox");
  assert.equal(menu.getAttribute("role"), "listbox");
  assert.equal(button.getAttribute("aria-labelledby"), label.id);
  let focused = false;
  button.focus = () => { focused = true; };
  key("ArrowDown");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(menu.children[1].getAttribute("role"), "option");
  key("Enter");
  assert.equal(select.value, "en");
  assert.equal(changes, 1);
  assert.ok(menu.hidden && focused);
  focused = false;
  key("ArrowUp");
  key("Escape");
  assert.ok(menu.hidden && focused);
  assert.equal(select.value, "en");
  assert.equal(changes, 1);
});

test("reset clears only this installation's progress, even for a shared book ID", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map([["compactPlayer:sample", JSON.stringify({ progressByLang: { en: 45 } })]]);
  async function visit(path, reload = assert.fail) {
    const location = Object.assign(new URL(path, "https://example.test"), { reload });
    const page = await openPlayerPage(
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
  const visit = () => openPlayerPage({ ...book, duration: 600 }, assert.fail, saved);
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

test("reset discards its pending position before pause, pagehide or a delayed save", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = await openPlayerPage(book, assert.fail, new Map(), {
    location: Object.assign(new URL("https://example.test/"), { reload() {} }),
  });
  queueListeningPosition(page);
  page.elements.get("resetOk").dispatchEvent(new Event("click"));
  page.audio.currentTime = 40;
  page.audio.dispatchEvent(new Event("timeupdate"));
  page.window.dispatchEvent(new Event("pagehide"));
  t.mock.timers.tick(5000);
  assert.equal(page.storage.getProgress(book.id, "en"), 0);
});

test("reset prevents late chapter and probe results from repopulating local storage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const offlineReset = deferred();
  t.mock.method(OfflineManager.prototype, "reset", () => offlineReset.promise);
  const saved = new Map();
  const chapter = deferred();
  const probes = [];
  const config = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  const location = Object.assign(new URL("https://example.test"), { reload: t.mock.fn() });
  const { elements, window } = await openPlayerPage(config, (url) => {
    if (url.endsWith(".vtt")) return chapter.promise;
    probes.push(url);
    return new Response(null, { status: 200 });
  }, saved, { location });
  elements.get("resetOk").dispatchEvent(new Event("click"));
  window.dispatchEvent(new Event("online"));
  chapter.resolve(new Response(chapterText));
  await settle();
  t.mock.timers.tick(5000);
  await settle();
  offlineReset.resolve();
  await settle();
  assert.equal(location.reload.mock.callCount(), 1);
  assert.deepEqual([...saved.keys()], ["compactPlayer@%2F:reset"]);
  assert.deepEqual(probes, []);
});

test("a reset invalidates queued positions from another tab, including after a second reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const visit = (location = new URL("https://example.test/")) => openPlayerPage(
    book, assert.fail, saved, { location });
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
  const page = await openPlayerPage({ ...book,
    languages: { en: { sources: { aac: { 96: "high.m4b", 64: "low.m4b" } } } } }, assert.fail);
  queueListeningPosition(page);
  const quality = page.elements.get("qualitySelect");
  quality.value = "aac-64";
  quality.dispatchEvent(new Event("change"));
  page.window.dispatchEvent(new Event("pagehide"));
  const saved = page.storage;
  assert.equal(saved.readBook(book.id).quality, "aac-64");
  assert.equal(saved.getProgress(book.id, "en"), 20);
});

test("chapter updates keep one WebVTT copy and discard older versions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const chapterUrl = "https://example.test/media/sample/chapters.vtt";
  const text = "WEBVTT\n\n00:00.000 --> 00:10.000\nOpening";
  const series = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  let requests = 0;
  const visit = (cacheVersion) => openPlayerPage(
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
  const { audio, elements, navigator, window } = await openPlayerPage(book, assert.fail);
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

test("a blocked Media Session leaves playback and chapter controls available", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const navigator = { language: "en", onLine: true,
    get mediaSession() { throw new DOMException("Blocked", "SecurityError"); },
  };
  const { elements, audio } = await openPlayerPage({ ...book,
    languages: { en: { ...book.languages.en, chapters: "en.vtt" } } }, () => new Response(chapterText), new Map(), { navigator });
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(audio.src.endsWith("/sample.m4b"));
  assert.equal(elements.get("chaptersList").children[0].children[0].textContent, "Introduction");
});

test("the player starts and accepts Play when accessing localStorage throws", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audio, elements, window } = await openPlayerPage(book, assert.fail, null);
  assert.throws(() => window.localStorage, { name: "SecurityError" });
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
  const { audio, elements } = await openPlayerPage(book, assert.fail, new Map(), {
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
  const { audio, elements, document, navigator, window } = await openPlayerPage(book, assert.fail);
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
  const { elements, audio } = await openPlayerPage(invalidLanguageBook, assert.fail, new Map(), {
    navigator: { onLine: true, language: "da" },
  });
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.deepEqual(elements.get("langSelect").children.map((option) => option.value), ["en"]);
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(audio.src.endsWith("/sample.m4b"));
});

test("a rejected language switch preserves the playing source and its listening position", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = await openPlayerPage(invalidLanguageBook, assert.fail);
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
  assert.deepEqual(page.storage.readBook(book.id).progressByLang, { en: 42 });
});

const chapterText = "WEBVTT\n\n00:00.000 --> 00:10.000\nIntroduction";

for (const button of ["prevChapterBtn", "nextChapterBtn"]) {
  test(`pending ${button} keeps the new language's position`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const config = { ...book, languages: {
      en: { ...book.languages.en, chapters: "en.vtt" },
      da: { ...book.languages.en, chapters: "da.vtt" },
    } };
    const saved = new Map([["compactPlayer:sample", JSON.stringify({ progressByLang: { en: 10 } })]]);
    const { elements, storage } = await openPlayerPage(config, (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), saved);
    storage.writeChapters(book.id, "da", 1, "https://example.test/media/sample/da.vtt",
      "WEBVTT\n\n00:00.000 --> 00:30.000\nStart\n\n00:30.000 --> 01:00.000\nAndet kapitel");
    elements.get(button).dispatchEvent(new Event("click"));
    const language = elements.get("langSelect");
    language.value = "da";
    language.dispatchEvent(new Event("change"));
    await settle();
    assert.equal(elements.get("timeCur").textContent, "0:10");
    assert.equal(storage.getProgress(book.id, "da"), 10);
  });
}

test("chapter sleep respects a newer timer choice while the chapter file is loading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let finish;
  const { elements } = await openPlayerPage({ ...book, languages: { en: { ...book.languages.en, chapters: "en.vtt" } } },
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
  const { elements } = await openPlayerPage({ ...book, duration: 28800 }, assert.fail);
  elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
  await settle();
  assert.equal(elements.get("sleepBtn").dataset.tooltip, "Sleep timer");
  assert.match(elements.get("statusAnnouncer").textContent, /unavailable/i);
});

test("switching language loads WebVTT while the new audio play request is still pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const { elements, audio } = await openPlayerPage({ ...book, languages: { en: book.languages.en,
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

test("reconnection restores a missing catalog without interrupting the active book", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigator = { onLine: false, language: "en" };
  const counts = { library: 0, book: 0 };
  const { window, elements, audio } = await openPlayerPage(book, assert.fail, new Map([["compactAudioPlayer.onboardingShown.v1", "1"]]), {
    navigator, location: new URL("https://example.test/?book=sample"),
    fetch: async (url) => {
      if (url.endsWith("/library.json")) {
        counts.library++;
        if (!navigator.onLine) return new Response(null, { status: 404 });
        return Response.json({ books: [{ id: book.id }, { id: "another" }] });
      }
      counts.book++;
      if (url.endsWith("/another/book.json")) return Response.json({ ...book, id: "another", title: { en: "Another book" } });
      return Response.json(book);
    },
  });
  assert.equal(elements.get("bookRow").hidden, true);
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  audio.dispatchEvent(new Event("playing"));
  const pause = t.mock.method(audio, "pause");
  const source = audio.src;
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(elements.get("bookRow").hidden, false);
  assert.deepEqual(elements.get("bookSelect").children.map((entry) => entry.value), [book.id, "another"]);
  assert.equal(elements.get("bookSelect").children.find((option) => option.selected)?.value, book.id);
  assert.equal(audio.src, source);
  assert.equal(pause.mock.callCount(), 0);
  assert.deepEqual(counts, { library: 2, book: 1 });
  const selector = elements.get("bookSelect");
  selector.value = "another";
  selector.dispatchEvent(new Event("change"));
  await settle();
  assert.equal(elements.get("bookTitle").textContent, "Another book");
});

test("chapter gaps clear the active title and still allow previous-chapter navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const vtt = chapterText + "\n\n00:20.000 --> 00:30.000\nFinale";
  const { elements, audio } = await openPlayerPage({ ...book, duration: 60,
    languages: { en: { ...book.languages.en, chapters: "en.vtt" } } }, () => new Response(vtt));
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  audio.duration = 60;
  audio.dispatchEvent(new Event("loadedmetadata"));
  audio.dispatchEvent(new Event("playing"));
  for (const [position, title] of [[5, "Introduction"], [10, ""], [15, ""], [20, "Finale"], [30, ""]]) {
    audio.currentTime = position;
    audio.dispatchEvent(new Event("timeupdate"));
    assert.equal(elements.get("bookMeta").textContent, ["en", "Low quality", title].filter(Boolean).join(" • "));
  }
  audio.currentTime = 15;
  audio.dispatchEvent(new Event("timeupdate"));
  elements.get("sleepList").children[0].dispatchEvent(new Event("click"));
  await settle();
  assert.match(elements.get("statusAnnouncer").textContent, /unavailable/i);
  elements.get("prevChapterBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(audio.currentTime, 0);
});

test("reconnection opens the only catalog book after offline startup failed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const navigator = { onLine: false, language: "en" };
  const requests = [];
  const { window, elements, audio } = await openPlayerPage(book, assert.fail, new Map(), {
    navigator, fetch: async (url) => {
      if (!navigator.onLine) return new Response(null, { status: 404 });
      requests.push(new URL(url).pathname);
      return url.endsWith("/library.json")
        ? Response.json({ books: [{ id: book.id, folder: "edition" }], ui: { onboardingEnabled: false } })
        : Response.json(book);
    },
  });
  const play = elements.get("playPauseBtn");
  assert.equal(play.disabled, true);
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.deepEqual(requests, ["/media/library.json", "/media/edition/book.json"]);
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.equal(play.disabled, false);
  assert.ok(!audio.src);
  play.dispatchEvent(new Event("click"));
  assert.equal(audio.src, "https://example.test/media/edition/sample.m4b");
});

test("invalid cached and downloaded chapter text remains retryable until valid WebVTT arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const key = "compactPlayer@%2F:compactPlayer:chapters:sample:en:1";
  const url = "https://example.test/media/sample/en.vtt";
  const saved = new Map([[key, JSON.stringify({ kind: "vtt", url, text: "<html>Old error</html>" })]]);
  const texts = ["<html>Temporary error</html>", "<html>Still unavailable</html>", "WEBVTT\n"];
  let calls = 0;
  const { window, elements } = await openPlayerPage({ ...book, languages: {
    en: { ...book.languages.en, chapterSource: "vtt", chapters: "en.vtt" },
  } }, (requestedUrl, options) => {
    assert.equal(requestedUrl, url);
    assert.equal(options.cache, "no-cache");
    return new Response(texts[calls++]);
  }, saved);
  assert.equal(calls, 1);
  const failure = elements.get("chaptersList").children[0];
  assert.match(failure.className, /chapter-load-error/);
  assert.ok(!saved.get(key)?.includes("Temporary error"));
  failure.children[1].dispatchEvent(new Event("click"));
  await settle();
  assert.equal(calls, 2);
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(calls, 3);
  assert.equal(JSON.parse(saved.get(key)).text, "WEBVTT\n");
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(calls, 3);
  assert.equal(elements.get("nextChapterBtn").disabled, true);
});

test("a successfully loaded empty catalog stays empty on reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigator = { onLine: false, language: "en" };
  let catalogs = 0;
  const { window, elements } = await openPlayerPage(book, assert.fail, new Map(), {
    navigator, location: new URL("https://example.test/?book=sample"), fetch: async (url) => {
      if (!url.endsWith("/library.json")) return Response.json(book);
      catalogs++;
      return Response.json({ books: [], episodes: [{ id: "old" }], ui: { onboardingEnabled: false } });
    },
  });
  navigator.onLine = true;
  window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(catalogs, 1);
  assert.equal(elements.get("bookRow").hidden, true);
});
