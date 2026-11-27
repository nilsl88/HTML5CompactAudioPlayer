import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { BookSession } from "../js/book-session.js?v=25";

test("a new book invalidates the earlier load without clearing the new controller", () => {
  const session = new BookSession();
  const first = session.begin();
  const second = session.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(session.isCurrent(first.generation), false);
  assert.equal(session.finish(first.generation), false);
  assert.equal(session.isCurrent(second.generation), true);
  assert.equal(session.controller.signal, second.signal);
  assert.equal(session.finish(second.generation), true);
});

test("reset aborts a book load and discards a pending refreshed configuration", () => {
  const session = new BookSession();
  const load = session.begin();
  session.pendingConfig = { book: "old" };
  session.invalidate();
  assert.equal(load.signal.aborted, true);
  assert.equal(session.isCurrent(load.generation), false);
  assert.equal(session.takePending(), null);
});

test("a refreshed configuration waits until playback is stopped and the book is stable", () => {
  const session = new BookSession();
  const book = {};
  const updated = { book: {}, configUrl: "book.json", fromDownload: false };
  session.stageRefresh(updated, book, "book.json");
  assert.equal(session.takePending({ playing: true }), null);
  assert.equal(session.takePending({ online: false }), null);
  const load = session.begin();
  assert.equal(session.takePending(), null);
  session.finish(load.generation);
  assert.equal(session.takePending(), updated);
  assert.equal(session.takePending(), null);
});

test("a late book response is discarded after a newer selection", async () => {
  const session = new BookSession();
  let resolve;
  const configs = { load: () => new Promise((done) => { resolve = done; }) };
  const first = session.begin();
  const result = session.load(configs, "old", first, true);
  session.begin();
  resolve({ book: { id: "old" } });
  assert.equal(await result, null);
});

test("changing books releases an obsolete revalidation and keeps its result out of Play", async () => {
  const book = (id, title) => ({ id, title, defaultLanguage: "en",
    languages: { en: { sources: { mp3: { 64: `${id}.mp3` } } } } });
  let started;
  let finish;
  const checking = new Promise((resolve) => { started = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const loaded = [];
  let reads = 0;
  const session = new BookSession({
    baseUrl: "https://example.test/", isOnline: () => true,
    searchParams: () => new URLSearchParams("book=first"), lastBookId: () => "",
    async fetchImpl(url) {
      if (url.endsWith("library.json")) return Response.json({ books: [{ id: "first" }, { id: "second" }] });
      if (url.endsWith("/second/book.json")) return Response.json(book("second", "Second book"));
      assert.match(url, /\/first\/book\.json$/);
      if (++reads === 1) return Response.json(book("first", "Downloaded first book"),
        { headers: { "x-compact-player-offline-version": "1" } });
      started();
      return waiting;
    },
    view: { onLoaded: ({ id }) => loaded.push(id), onError: assert.fail },
  });
  try {
    await session.start();
    let recovered = false;
    const recovery = session.recover().then(() => { recovered = true; });
    await checking;
    await session.select("second");
    await settle();
    assert.equal(recovered, true);
    finish(Response.json(book("first", "Late first book")));
    await recovery;
    await settle();
    session.applyRefresh(false);
    assert.deepEqual(loaded, ["first", "second"]);
    assert.equal(session.current.id, "second");
  } finally {
    session.invalidate();
    finish(Response.json(book("first", "Late first book")));
  }
});
