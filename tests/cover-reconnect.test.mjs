import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { deferred, Element, openPlayerPage } from "./player-page.mjs";
import { createCoverView } from "../js/cover.js?v=25";

test("a cover started online retries if reconnect arrives before its failed response", async (t) => {
  const image = new Element();
  const button = new Element();
  const previous = deferred();
  const cover = "https://example.test/cover.jpg";
  let online = true;
  let requests = 0;
  const failures = [];
  const view = createCoverView(image, button, {
    isOnline: () => online,
    getFileCoverUrl: () => null,
    onShown() {},
    onFailure: (error) => failures.push(error),
    fetchImpl(url) {
      assert.equal(url, cover);
      return ++requests === 1 ? previous.promise : new Response("fixture", { headers: { "content-type": "image/jpeg" } });
    },
  });
  t.after(view.clearCover);
  view.applyCover({ id: "book", coverSource: "file", cover }, "en");
  online = false;
  await settle();
  online = true;
  view.retryCover();
  previous.resolve(new Response(null, { status: 404 }));
  await settle();
  assert.equal(requests, 2);
  assert.equal(failures.length, 0);
  assert.match(image.src, /^blob:/);
  image.onload();
  view.retryCover();
  assert.equal(requests, 2);
});

test("the page cancels an oversized cover body after the worker image route fails", async (t) => {
  const image = new Element();
  const button = new Element();
  const failed = deferred();
  const coverUrl = "https://example.test/cover.jpg";
  let reads = 0;
  const canceled = t.mock.fn();
  const view = createCoverView(image, button, {
    getFileCoverUrl: () => "https://example.test/offline-cover",
    onShown: assert.fail,
    onFailure: failed.resolve,
    fetchImpl(url) {
      assert.equal(url, coverUrl);
      return new Response(new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(9 * 1024 ** 2));
        },
        cancel: canceled,
      }, { highWaterMark: 0 }), { headers: { "content-type": "image/jpeg" } });
    },
  });
  t.after(view.clearCover);
  view.applyCover({ id: "book", coverSource: "file", cover: coverUrl }, "en");
  image.onerror();
  assert.match((await failed.promise).message, /exceeds 16 MiB/);
  assert.equal(reads, 2);
  assert.equal(canceled.mock.callCount(), 1);
  assert.equal(button.hidden, true);
});

test("the cover fallback rejects another book's response even when the current download matches", async () => {
  const { versionHeader, versionHeaderValue, bookHeader, bookHeaderValue } = globalThis.CompactPlayerOfflineManifest;
  const image = new Element();
  const failed = deferred();
  const view = createCoverView(image, new Element(), {
    getBookId: () => "selected",
    getFileCoverUrl: () => null,
    canUseCachedCover: async () => true,
    onShown: assert.fail,
    onFailure: failed.resolve,
    fetchImpl: async () => new Response("an older cached image", { headers: {
      [versionHeader]: versionHeaderValue(1), [bookHeader]: bookHeaderValue("previous", "previous-edition"),
    } }),
  });
  try {
    view.applyCover({ id: "edition", cacheVersion: 1, coverSource: "file", cover: "https://example.test/shared.jpg" }, "en");
    await settle();
    assert.equal(image.src, undefined);
    assert.match((await failed.promise).message, /different book/);
  } finally { view.clearCover(); }
});

test("offline cover failures retry on reconnect without duplicating pending or successful loads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const book = { id: "sample", title: { en: "Cover fixture" }, defaultLanguage: "en",
    coverSource: "file", cover: "cover.jpg", languages: { en: { sources: { mp3: { 64: "book.mp3" } } } } };
  const jpeg = () => new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), { headers: { "content-type": "image/jpeg" } });

  for (const [scenario, reconnectWhilePending, firstSucceeds] of [
    ["failure before reconnect", false, false],
    ["failure after reconnect", true, false],
    ["success after reconnect", true, true],
  ]) {
    const navigator = { language: "en", onLine: false };
    const first = deferred();
    const retry = deferred();
    let requests = 0;
    const { window, audio, elements, ready } = await openPlayerPage(book, (url) => {
      assert.equal(url, "https://example.test/media/sample/cover.jpg");
      return ++requests === 1 ? first.promise : retry.promise;
    }, new Map(), { navigator });
    const image = elements.get("coverImg");
    const button = elements.get("coverButton");
    t.after(() => { if (image.src) URL.revokeObjectURL(image.src); });
    await ready;
    assert.equal(requests, 1, scenario);
    assert.equal(button.hidden, true, scenario);

    async function reconnect() {
      navigator.onLine = true;
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      await settle();
    }
    if (reconnectWhilePending) {
      await reconnect();
      assert.equal(requests, 1, scenario);
    }
    first.resolve(firstSucceeds ? jpeg() : new Response(null, { status: 404 }));
    await settle();
    if (!reconnectWhilePending) await reconnect();
    assert.equal(requests, firstSucceeds ? 1 : 2, scenario);
    assert.equal(button.hidden, true, scenario);

    if (!firstSucceeds) {
      retry.resolve(jpeg());
      await settle();
    }
    const coverUrl = image.src;
    assert.match(coverUrl, /^blob:/, scenario);
    image.onload();
    assert.equal(button.hidden, false, scenario);
    assert.equal(image.alt, "Cover fixture", scenario);

    await reconnect();
    assert.equal(requests, firstSucceeds ? 1 : 2, scenario);
    assert.equal(image.src, coverUrl, scenario);
    assert.ok(!audio.src, scenario);
  }
});

test("a queued cover retry uses the latest quality chosen after reconnecting", async () => {
  const coverUrl = "https://example.test/cover.jpg";
  const oldSource = { url: "https://example.test/old.m4b" };
  const currentSource = { url: "https://example.test/current.m4b" };
  const initialCover = deferred();
  const requests = [];
  let online = false;
  const view = createCoverView(new Element(), new Element(), {
    isOnline: () => online, getFileCoverUrl: () => null, onFailure() {}, onShown: assert.fail,
    fetchImpl(url) {
      requests.push(url);
      return requests.length === 1 ? initialCover.promise : new Response(null, { status: 404 });
    },
  });
  const book = { id: "book", coverSource: "auto", cover: coverUrl, bookBaseUrl: "https://example.test/" };
  view.applyCover(book, "en", oldSource);
  online = true;
  view.retryCover(oldSource);
  view.applyCover(book, "en", currentSource);
  initialCover.resolve(new Response(null, { status: 404 }));
  await settle();

  assert.deepEqual(requests, [coverUrl, currentSource.url, coverUrl, currentSource.url]);
});
