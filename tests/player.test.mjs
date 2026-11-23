import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import assert from "node:assert/strict";
import { createCustomSelects } from "../js/custom-select.js?v=19";
import { openDialog, closeDialog, openPanel, closePanel } from "../js/dialogs.js?v=19";
import { deferred, Element, openPlayerPage } from "./player-page.mjs";
import { OfflineManager } from "../js/offline.js?v=19";
import { sameOfflineSelection, validateOfflineBookConfig } from "../js/offline-selection.js?v=19";
import { BookSelection } from "../js/book-selection.js?v=19";
import { normalizeBook } from "../js/config.js?v=19";
import { buildSources } from "../js/source-selection.js?v=19";

const book = {
  id: "sample", defaultLanguage: "en", title: { en: "Sample audiobook" },
  languages: { en: { sources: { aac: { 96: "sample.m4b" } } } },
};

test("versioned audio paths and signed URLs reach the media element unchanged", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signed = "https://cdn.example.test/audio-v2.m4b?signature=a%2Fb%2Bc&expires=123";
  const saved = new Map();
  for (const [version, path, expected] of [
    [1, "audio-v1.m4b", "https://example.test/media/sample/audio-v1.m4b"],
    [2, signed, signed],
  ]) {
    const edition = { ...book, cacheVersion: version,
      languages: { en: { sources: { aac: { 96: path } } } } };
    const page = await openPlayerPage(edition, assert.fail, saved);
    await page.ready;
    assert.ok(!page.audio.src);
    page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
    assert.equal(page.audio.src, expected);
  }
});

test("network errors use a saved source only for the selected book version", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manifest = { schemaVersion: 1, status: "ready", downloadId: "one", cacheName: "saved",
    episodeId: "sample", languageCode: "en", sourceId: "aac-96",
    sourceUrl: "https://example.test/media/sample/sample.m4b", cacheVersion: "1", mime: "audio/mp4",
    totalSize: 1, chunkSize: 1, totalChunks: 1, completed: [0] };
  t.mock.method(OfflineManager.prototype, "init", async function () { this.active = manifest; });
  for (const onlineAtPlay of [true, false]) {
    for (const [version, expectedSaved] of [[1, true], [2, false]]) {
      const page = await openPlayerPage({ ...book, cacheVersion: version }, assert.fail, new Map(),
        { navigator: { onLine: true, language: "en", serviceWorker: { controller: { scriptURL: "https://example.test/sw.js" } } } });
      await page.ready;
      page.navigator.onLine = onlineAtPlay;
      const attempts = [];
      page.audio.play = async () => {
        attempts.push(page.audio.src);
        if (page.audio.src === manifest.sourceUrl) throw new DOMException("Network unavailable", "NetworkError");
      };
      page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
      await settle();
      assert.equal(attempts.some((url) => url.includes("__compact_player_offline__/audio.json")), expectedSaved,
        `version ${version}, online ${onlineAtPlay}`);
      if (!onlineAtPlay && expectedSaved) assert.ok(attempts[0].includes("__compact_player_offline__/audio.json"));
    }
  }
});

test("regional recordings keep separate identities and reopen saved and downloaded language choices", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const edition = { id: "regional", defaultLanguage: "en-US", title: { "en-US": "American", "en-GB": "British" },
    languages: { "en-GB": { sources: { mp3: { 64: "british.mp3" } } }, "en-US": { sources: { mp3: { 64: "american.mp3" } } } } };
  const saved = new Map([["compactPlayer:regional", JSON.stringify({ language: "en", quality: "mp3-64", progressByLang: { en: 24 }, lastTime: 8 })]]);
  const visit = (language, values = saved) => openPlayerPage(edition, assert.fail, values, { navigator: { onLine: true, language } });
  const page = await visit("da");
  const select = page.elements.get("langSelect");
  const selectedTrack = (page) => page.elements.get("langSelect").children.find((option) => option.selected)?.value;
  assert.deepEqual(select.children.map((option) => option.value), ["en-GB", "en-US"]);
  assert.equal(selectedTrack(page), "en-US");
  assert.equal(page.elements.get("timeCur").textContent, "0:24");
  select.value = "en-GB";
  select.dispatchEvent(new Event("change"));
  assert.equal(page.elements.get("bookTitle").textContent, "British");
  const reopened = await visit("en-US");
  assert.equal(selectedTrack(reopened), "en-GB");
  reopened.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.ok(reopened.audio.src.endsWith("/british.mp3"));
  assert.equal(selectedTrack(await visit("en-gb", new Map())), "en-GB");
  assert.equal(selectedTrack(await visit("en-AU", new Map())), "en-US");
  const bilingual = await openPlayerPage({ ...edition, languages: { ...edition.languages, da: { sources: { mp3: { 64: "danish.mp3" } } } } },
    assert.fail, new Map(), { navigator: { onLine: true, languages: ["da-DK", "en-US"] } });
  assert.equal(selectedTrack(bilingual), "da");

  const root = "https://example.test/";
  const bookBaseUrl = root + "media/regional/";
  const book = normalizeBook(edition, { bookBaseUrl, documentBaseUrl: root });
  const sources = new Map(Object.values(book.languages).map((lang) => [lang.code, buildSources(lang)]));
  const legacy = { episodeId: book.id, languageCode: "en", cacheVersion: 1, sourceId: "mp3-64", sourceUrl: bookBaseUrl + "british.mp3" };
  const offline = new BookSelection({ bookId: book.id, book, sources, preferences: {}, downloaded: legacy,
    browserLanguages: ["en-US"], saveSelection: assert.fail });
  assert.equal(offline.languageCode, "en-GB");
  assert.equal(offline.source.url, legacy.sourceUrl);
  assert.equal(validateOfflineBookConfig(JSON.stringify(edition), bookBaseUrl + "book.json", root, legacy), book.id);
  const selected = { ...legacy, languageCode: "en-GB" };
  assert.ok(sameOfflineSelection(legacy, selected));
  assert.equal(sameOfflineSelection({ ...selected, languageCode: "en-US" }, selected), false);
  assert.equal(sameOfflineSelection({ ...legacy, languageTag: "en" }, selected), false);
});

test("dialog focus callbacks respect a closed dialog and subsequent user focus", () => {
  const frames = [];
  const original = { isConnected: true, focus() { document.activeElement = this; } };
  const first = { focus() { document.activeElement = this; } };
  const other = { isConnected: true, focus() { document.activeElement = this; } };
  const document = { activeElement: original, defaultView: { requestAnimationFrame: (fn) => frames.push(fn) } };
  const dialog = { ownerDocument: document, open: false, showModal() { this.open = true; },
    close() { this.open = false; }, hasAttribute() { return false; } };
  openDialog(dialog, first);
  closeDialog(dialog);
  frames.shift()();
  assert.equal(document.activeElement, original);
  frames.shift()();
  openDialog(dialog, first);
  document.activeElement = other;
  frames.shift()();
  assert.equal(document.activeElement, other);
  document.activeElement = first;
  closeDialog(dialog);
  document.activeElement = other;
  frames.shift()();
  assert.equal(document.activeElement, other);
});

test("opening a panel sets initial focus unless the user has already moved it or closed it", () => {
  const trigger = new Element();
  const panel = new Element();
  const first = new Element();
  const chapter = new Element();
  let draw;
  const document = { activeElement: trigger, defaultView: { requestAnimationFrame: (fn) => { draw = fn; } } };
  panel.ownerDocument = document;
  first.focus = () => { document.activeElement = first; };
  for (const action of ["open", "choose chapter", "close"]) {
    document.activeElement = trigger;
    openPanel(panel, trigger, first);
    if (action === "choose chapter") document.activeElement = chapter;
    if (action === "close") panel.hidden = true;
    draw();
    const expected = { open: first, "choose chapter": chapter, close: trigger };
    assert.equal(document.activeElement, expected[action]);
  }
});

test("closing a panel restores focus only while its closure remains current", () => {
  const frames = [];
  const trigger = new Element();
  const panel = new Element();
  const inside = new Element();
  const elsewhere = new Element();
  const document = { activeElement: inside, defaultView: { requestAnimationFrame: (fn) => frames.push(fn) } };
  trigger.focus = () => { document.activeElement = trigger; };
  panel.ownerDocument = document;
  panel.hidden = false;
  closePanel(panel, trigger, true);
  frames.shift()();
  assert.equal(document.activeElement, trigger);

  document.activeElement = inside;
  panel.hidden = false;
  closePanel(panel, trigger, true);
  document.activeElement = elsewhere;
  frames.shift()();
  assert.equal(document.activeElement, elsewhere);

  document.activeElement = inside;
  panel.hidden = false;
  closePanel(panel, trigger, true);
  panel.hidden = false;
  frames.shift()();
  assert.equal(document.activeElement, inside);
});

test("holding Space toggles playback once per press while repeated arrow keys continue seeking", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { document, audio, storage, ready } = await openPlayerPage(book, assert.fail);
  await ready;
  const press = (code, repeat = false) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { code, repeat });
    document.dispatchEvent(event);
    assert.ok(event.defaultPrevented);
  };
  audio.play = async () => { audio.paused = false; };
  audio.pause = () => { audio.paused = true; };
  press("Space");
  assert.equal(audio.paused, false);
  press("Space", true);
  assert.equal(audio.paused, false);
  press("Space");
  assert.equal(audio.paused, true);
  press("Space", true);
  assert.equal(audio.paused, true);
  press("ArrowRight");
  press("ArrowRight", true);
  assert.equal(storage.getProgress(book.id, "en"), 10);
});

test("arrow shortcuts use the configured interval and leave focused controls alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { document, elements, storage, ready } = await openPlayerPage(book, assert.fail);
  await ready;
  const skip = elements.get("skipSelect");
  skip.value = "30";
  skip.dispatchEvent(new Event("change"));
  const press = (code) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { code });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  for (const [code, expected] of [["ArrowUp", 30], ["ArrowRight", 35], ["ArrowDown", 5], ["ArrowLeft", 0]]) {
    assert.ok(press(code));
    assert.equal(storage.getProgress(book.id, "en"), expected);
  }
  document.closest = () => skip;
  assert.equal(press("ArrowUp"), false);
  assert.equal(storage.getProgress(book.id, "en"), 0);
});

test("translated control tooltips follow the accessible labels after a language change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { elements, ready } = await openPlayerPage(book, assert.fail);
  await ready;
  const select = elements.get("uiLangSelect");
  const options = elements.get("optionsBtn");
  const english = options.dataset.tooltip;
  select.value = "da";
  select.dispatchEvent(new Event("change"));
  assert.notEqual(options.dataset.tooltip, english);
  for (const id of ["playPauseBtn", "skipBackBtn", "skipForwardBtn", "sleepBtn", "prevChapterBtn",
    "nextChapterBtn", "chaptersBtn", "optionsBtn", "resetBtn"]) {
    const button = elements.get(id);
    assert.ok(button.dataset.tooltip, id);
    assert.equal(button.dataset.tooltip, button.getAttribute("aria-label") || button.textContent, id);
  }
});

test("first-visit onboarding follows the catalog setting and saved acknowledgement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [enabled, seen] of [[true, false], [false, false], [true, true]]) {
    const saved = seen ? new Map([["compactAudioPlayer.onboardingShown.v1", "1"]]) : new Map();
    const { elements, ready } = await openPlayerPage(book, assert.fail, saved, {
      fetch: async (url) => Response.json(url.endsWith("/library.json")
        ? { books: [{ id: book.id }], ui: { onboardingEnabled: enabled } }
        : { ...book, ui: { onboardingEnabled: !enabled } }),
    });
    await ready;
    assert.equal(elements.get("onboardingDialog").getAttribute("open") !== null, enabled && !seen);
  }
});

test("changing playback speed in another tab preserves the chosen theme", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const first = await openPlayerPage(book, assert.fail, saved);
  const second = await openPlayerPage(book, assert.fail, saved);
  const theme = first.elements.get("themeSelect");
  theme.value = "dark";
  theme.dispatchEvent(new Event("change"));
  const speed = second.elements.get("speedRange");
  speed.value = "1.5";
  speed.dispatchEvent(new Event("input"));
  const write = second.window.localStorage.setItem;
  t.mock.method(second.window.localStorage, "setItem", (key, value) => {
    const volume = first.elements.get("volumeRange");
    volume.value = "40";
    volume.dispatchEvent(new Event("input"));
    volume.dispatchEvent(new Event("change"));
    write(key, value);
  });
  speed.dispatchEvent(new Event("change"));
  const prefs = first.storage.readUi();
  assert.equal(prefs.playbackRate, 1.5);
  assert.equal(prefs.theme, "dark");
  assert.equal(prefs.volume, 0.4);
});

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

test("an open book selector keeps the active choice when the catalog changes", () => {
  const document = { createElement() {
    const element = new Element();
    const active = new Set();
    element.classList = {
      add: (name) => active.add(name), remove: (name) => active.delete(name),
      toggle: (name, enabled) => enabled ? active.add(name) : active.delete(name),
      contains: (name) => active.has(name),
    };
    element.getBoundingClientRect = () => ({ top: 0, bottom: 10, height: 10 });
    return element;
  }, querySelector: () => null };
  const controls = createCustomSelects(document, { innerHeight: 600 });
  const select = Object.assign(new Element(), { id: "book" });
  Object.defineProperties(select, {
    options: { get: () => select.children },
    selectedIndex: { get: () => select.children.findIndex((option) => option.selected) },
    value: {
      get: () => select.children.find((option) => option.selected)?.value || "",
      set: (value) => select.children.forEach((option) => { option.selected = option.value === value; }),
    },
  });
  const wrapper = controls.selectWithArrow(select);
  wrapper.insertBefore = (button) => wrapper.children.unshift(button);
  select.closest = () => wrapper;
  const records = (values) => values.map((value) => ({ value }));
  controls.optionsFrom(select, records(["alpha", "beta"]), "alpha", (item) => item.value);
  const { button, menu } = controls.enhanceCustomSelect(select);
  const key = (key) => button.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key }));
  key("ArrowDown");
  assert.equal(button.getAttribute("aria-activedescendant"), "book-option-1");

  controls.optionsFrom(select, records(["gamma", "alpha", "beta"]), "alpha", (item) => item.value);
  assert.equal(button.getAttribute("aria-activedescendant"), "book-option-2");
  assert.equal(menu.children[2].classList.contains("is-active"), true);
  key("Enter");
  assert.equal(select.value, "beta");

  key("ArrowUp");
  controls.optionsFrom(select, records(["beta", "gamma"]), "beta", (item) => item.value);
  assert.equal(menu.hidden, true);
  assert.equal(button.getAttribute("aria-activedescendant"), null);
  key("Enter");
  assert.equal(select.value, "beta");
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

test("late media errors and system Play are inert while reset waits for offline storage", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const offlineReset = deferred();
  t.mock.method(OfflineManager.prototype, "reset", () => offlineReset.promise);
  const handlers = new Map();
  const navigator = { language: "en", onLine: true, mediaSession: { setActionHandler: (action, handler) => handlers.set(action, handler) } };
  const location = Object.assign(new URL("https://example.test/"), { reload: t.mock.fn() });
  const config = { ...book, languages: { en: { sources: { aac: { 96: "high.m4b", 64: "low.m4b" } } } } };
  const { audio, elements } = await openPlayerPage(config, assert.fail, new Map(), { navigator, location });
  const systemPlay = handlers.get("play");
  systemPlay();
  audio.dispatchEvent(new Event("playing"));
  elements.get("resetOk").dispatchEvent(new Event("click"));
  const load = t.mock.method(audio, "load");
  const play = t.mock.method(audio, "play");
  audio.error = { code: 2 };
  audio.dispatchEvent(new Event("error"));
  systemPlay();
  t.mock.timers.tick(20_000);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(play.mock.callCount(), 0);
  assert.equal(handlers.get("play"), null);
  assert.equal(location.reload.mock.callCount(), 0);
  offlineReset.resolve();
  await settle();
  assert.equal(location.reload.mock.callCount(), 1);
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

test("a late chapter response from an older edition preserves the newer tab's offline chapters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const config = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  const url = "https://example.test/media/sample/chapters.vtt";
  const pending = deferred();
  const visit = (version, fetch) => openPlayerPage({ ...config, cacheVersion: version }, fetch, saved);
  const first = await visit("spring", () => pending.promise);
  const current = chapterText.replace("Introduction", "New edition");
  const second = await visit("autumn", () => new Response(current));
  assert.equal(second.storage.readChapters(book.id, "en", "autumn", url), current);
  pending.resolve(new Response(chapterText));
  await settle();
  assert.equal(first.storage.readChapters(book.id, "en", "autumn", url), current);
  const requests = [];
  const reopened = await visit("autumn", (url) => { requests.push(url); return new Response(null, { status: 503 }); });
  assert.deepEqual(requests, []);
  assert.equal(reopened.elements.get("nextChapterBtn").disabled, false);

  // Opening a legacy copy upgrades its format without pruning editions in other tabs.
  saved.set(first.storage.prefix + "compactPlayer:chapters:sample:en:spring", JSON.stringify({ url, text: chapterText }));
  assert.equal(first.storage.readChapters(book.id, "en", "spring", url), chapterText);
  assert.equal(second.storage.readChapters(book.id, "en", "autumn", url), current);
});

test("a chapter request from another tab cannot refill the cache after reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const config = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  const url = "https://example.test/media/sample/chapters.vtt";
  for (let attempt = 0; attempt < 2; attempt++) {
    const chapter = deferred();
    const old = await openPlayerPage(config, () => chapter.promise, saved);
    const reset = deferred();
    const tab = await openPlayerPage(book, assert.fail, saved, {
      location: Object.assign(new URL("https://example.test/"), { reload: reset.resolve }),
    });
    tab.elements.get("resetOk").dispatchEvent(new Event("click"));
    await reset.promise;
    const fresh = await openPlayerPage({ ...config, cacheVersion: 2 }, () => new Response(chapterText), saved);
    chapter.resolve(new Response(chapterText));
    await settle();
    assert.equal(old.storage.readChapters(book.id, "en", 1, url), "");
    assert.equal(fresh.storage.readChapters(book.id, "en", 2, url), chapterText);
    assert.equal([...saved.keys()].filter((key) => key.includes("chapters:")).length, 1);
  }
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

test("a failed book switch preserves playback, position and the sleep timer with storage blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  const nextConfig = deferred();
  const page = await openPlayerPage(book, assert.fail, null, { fetch: (url) => {
    if (url.endsWith("/library.json")) return Response.json({ books: [{ id: book.id }, { id: "next" }], ui: { onboardingEnabled: false } });
    if (url.endsWith("/next/book.json")) return nextConfig.promise;
    return Response.json(book);
  } });
  queueListeningPosition(page);
  const { elements, audio } = page;
  elements.get("sleepList").children[1].dispatchEvent(new Event("click"));
  const pause = t.mock.method(audio, "pause");
  const source = audio.src;
  const select = elements.get("bookSelect");
  select.value = "next";
  select.dispatchEvent(new Event("change"));
  nextConfig.resolve(Response.json({ id: "next", languages: {} }));
  await settle();
  assert.equal(select.value, book.id);
  assert.equal(pause.mock.callCount(), 0);
  assert.equal(audio.src, source);
  assert.equal(elements.get("playPauseBtn").getAttribute("aria-label"), "Pause");
  assert.equal(elements.get("timeCur").textContent, "0:20");
  assert.match(elements.get("sleepBtn").dataset.tooltip, /5 min/);
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

test("only a playing fallback changes the quality restored on the next visit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const saved = new Map();
  const config = { ...book, languages: { en: { sources: { aac: { 96: "high.m4b", 64: "low.m4b" } } } } };
  const visit = () => openPlayerPage(config, assert.fail, saved);
  const { elements, audio, storage } = await visit();
  const quality = elements.get("qualitySelect");
  quality.value = "aac-64";
  quality.dispatchEvent(new Event("change"));
  const play = elements.get("playPauseBtn");
  play.dispatchEvent(new Event("click"));
  audio.error = { code: 2 };
  audio.dispatchEvent(new Event("error"));
  assert.match(audio.src, /high\.m4b$/);
  assert.equal(storage.readBook(book.id).quality, "aac-64");
  audio.dispatchEvent(new Event("error"));
  play.dispatchEvent(new Event("click"));
  audio.dispatchEvent(new Event("playing"));
  const reopened = await visit();
  reopened.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.match(reopened.audio.src, /low\.m4b$/);
  reopened.audio.error = { code: 2 };
  reopened.audio.dispatchEvent(new Event("error"));
  reopened.audio.dispatchEvent(new Event("playing"));
  const afterFallback = await visit();
  afterFallback.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.match(afterFallback.audio.src, /high\.m4b$/);
});

test("a new chapter edition revalidates a still-fresh HTTP response before saving WebVTT", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = new Map();
  const url = "https://example.test/media/sample/chapters.vtt";
  const config = { ...book, languages: { en: { ...book.languages.en, chapters: "chapters.vtt" } } };
  let httpCopy;
  const requests = [];
  const visit = (cacheVersion) => openPlayerPage({ ...config, cacheVersion }, (path, options) => {
    assert.equal(path, url);
    requests.push(options.cache);
    if (!httpCopy || options.cache === "no-cache") httpCopy = chapterText.replace("Introduction", cacheVersion);
    return new Response(httpCopy, { headers: { "cache-control": "public, max-age=3600" } });
  }, saved);
  await visit("spring");
  const autumn = await visit("autumn");
  assert.equal(autumn.storage.readChapters(book.id, "en", "autumn", url), chapterText.replace("Introduction", "autumn"));
  const reopened = await visit("autumn");
  assert.equal(reopened.elements.get("chaptersList").children[0].children[0].textContent, "autumn");
  assert.equal(requests.length, 2);
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

test("a book switch clears the old system position until the new duration is known", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const positions = [];
  const next = deferred();
  const navigator = { language: "en", onLine: true, mediaSession: {
    setPositionState(...args) { positions.push(args); }, setActionHandler() {},
  } };
  const page = await openPlayerPage(book, assert.fail, new Map(), { navigator, fetch: (url) => {
    if (url.endsWith("/library.json")) return Response.json({ books: [{ id: book.id }, { id: "next" }], ui: { onboardingEnabled: false } });
    return url.endsWith("/next/book.json") ? next.promise : Response.json({ ...book, duration: 600 });
  } });
  queueListeningPosition(page);
  const select = page.elements.get("bookSelect");
  select.value = "next";
  select.dispatchEvent(new Event("change"));
  assert.deepEqual(positions.at(-1), [{ duration: 600, position: 20, playbackRate: 1 }]);
  next.resolve(Response.json({ ...book, id: "next" }));
  await settle();
  assert.deepEqual(positions.at(-1), []);
  assert.ok(!page.audio.src);
  page.audio.duration = NaN;
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  page.audio.duration = 30;
  page.audio.dispatchEvent(new Event("loadedmetadata"));
  assert.deepEqual(positions.at(-1), [{ duration: 30, position: 0, playbackRate: 1 }]);
  select.value = book.id;
  select.dispatchEvent(new Event("change"));
  await settle();
  assert.deepEqual(positions.at(-1), [{ duration: 600, position: 20, playbackRate: 1 }]);
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

test("Options can open another catalog book while the failed startup book is retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const retry = deferred();
  let brokenRequests = 0;
  let healthyRequests = 0;
  const { ready, elements, audio } = await openPlayerPage(book, assert.fail, new Map(), {
    fetch: (url) => {
      if (url.endsWith("/library.json")) return Response.json({ books: [{ id: "broken" }, { id: book.id }], ui: { onboardingEnabled: false } });
      if (url.endsWith("/broken/book.json")) return ++brokenRequests === 1 ? new Response(null, { status: 422 }) : retry.promise;
      assert.ok(url.endsWith("/sample/book.json"));
      healthyRequests++;
      return Response.json(book);
    },
  });
  await ready;
  assert.equal(healthyRequests, 0);
  elements.get("optionsBtn").dispatchEvent(new Event("click"));
  await settle();
  assert.equal(brokenRequests, 2);
  const select = elements.get("bookSelect");
  assert.equal(elements.get("bookRow").hidden, false);
  assert.equal(elements.get("player").getAttribute("aria-busy"), "false");
  assert.equal(elements.get("playPauseBtn").disabled, true);
  assert.equal(select.disabled, false);
  assert.deepEqual(select.children.map((option) => option.value), ["broken", book.id]);
  assert.equal(select.children[1].textContent, book.title.en);
  assert.equal(healthyRequests, 1);
  select.value = book.id;
  select.dispatchEvent(new Event("change"));
  await settle();
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  retry.resolve(Response.json({ ...book, id: "broken", title: { en: "Late default" } }));
  await settle();
  assert.equal(elements.get("bookTitle").textContent, book.title.en);
  assert.equal(healthyRequests, 1);
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(audio.src, "https://example.test/media/sample/sample.m4b");
});

test("a catalog recovered during startup redirects the pending selection to the moved book", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = deferred();
  const navigator = { onLine: false, language: "en" };
  const requests = [];
  const page = await openPlayerPage(book, assert.fail, new Map(), {
    navigator, location: new URL("https://example.test/?book=sample"),
    fetch: async (url) => {
      requests.push(url);
      if (url.endsWith("/library.json")) return navigator.onLine
        ? Response.json({ books: [{ id: book.id, folder: "updated" }], ui: { onboardingEnabled: false } })
        : new Response(null, { status: 404 });
      if (url.endsWith("/sample/book.json")) return old.promise;
      assert.ok(url.endsWith("/updated/book.json"), url);
      return Response.json({ ...book, title: { en: "Moved book" } });
    },
  });
  assert.ok(requests.some((url) => url.endsWith("/sample/book.json")));
  navigator.onLine = true;
  page.window.dispatchEvent(new Event("online"));
  await settle();
  assert.equal(page.elements.get("bookTitle").textContent, "Moved book");
  old.resolve(Response.json(book));
  await page.ready;
  await settle();
  page.elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  assert.equal(page.elements.get("bookTitle").textContent, "Moved book");
  assert.ok(page.audio.src.endsWith("/updated/sample.m4b"));
  assert.equal(requests.filter((url) => url.endsWith("/updated/book.json")).length, 1);
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

test("Previous follows the displayed chapter after an overlapping cue ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const vtt = "WEBVTT\n\n00:00.000 --> 00:30.000\nOpening\n\n00:05.000 --> 00:10.000\nNote\n\n00:40.000 --> 00:50.000\nFinale";
  const { elements, audio } = await openPlayerPage({ ...book, duration: 60,
    languages: { en: { ...book.languages.en, chapters: "en.vtt" } } }, () => new Response(vtt));
  elements.get("playPauseBtn").dispatchEvent(new Event("click"));
  audio.duration = 60;
  audio.dispatchEvent(new Event("loadedmetadata"));
  for (const [position, title, target] of [[12, "Opening", 0], [9, "Note", 5], [7, "Note", 0], [51, "", 40]]) {
    audio.currentTime = position;
    audio.dispatchEvent(new Event("timeupdate"));
    assert.equal(elements.get("bookMeta").textContent, ["en", "Low quality", title].filter(Boolean).join(" • "));
    elements.get("prevChapterBtn").dispatchEvent(new Event("click"));
    await settle();
    assert.equal(audio.currentTime, target, "Previous at " + position);
  }
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
