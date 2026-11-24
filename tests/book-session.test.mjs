import test from "node:test";
import assert from "node:assert/strict";
import { BookSession } from "../js/book-session.js?v=22";

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
