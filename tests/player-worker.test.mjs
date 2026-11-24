import assert from "node:assert/strict";
import test from "node:test";
import { PlayerWorker } from "../js/player-worker.js?v=22";

const baseUrl = "https://example.test/listen/";
const sourceUrl = baseUrl + "media/book/recording.m4b";
const download = { downloadId: "one", episodeId: "book", configBookId: "book", cacheVersion: 3,
  sourceUrl, totalSize: 4096, mime: "audio/mp4" };
const legacyHeaders = {
  "x-compact-player-offline-version": encodeURIComponent(JSON.stringify("3")),
  "content-length": "4096",
  "content-type": "audio/mp4",
};
const capabilityType = "compact-player-worker-capabilities";

test("a v17 controller uses the verified offline URL until a compatible worker takes over", async () => {
  const workers = new EventTarget();
  workers.controller = { scriptURL: baseUrl + "sw.js" };
  const navigatorObject = { serviceWorker: workers, onLine: false };
  const requests = [];
  const scriptName = `sw-${"a".repeat(64)}.js`;
  const worker = new PlayerWorker({
    baseUrl, navigatorObject, scriptName, releaseSequence: 10,
    async fetchImpl(url, options) {
      requests.push(url);
      assert.equal(options.method, "HEAD");
      assert.equal(options.cache, "no-store");
      return url === sourceUrl ? new Response(null, { headers: legacyHeaders }) : new Response(null, { status: 404 });
    },
  });
  worker.listen(assert.fail);
  const route = baseUrl + "__compact_player_offline__/audio.json?download=one";
  const registrations = [];
  workers.register = async (url) => { registrations.push(url.href); };
  workers.ready = Promise.resolve({ active: workers.controller });
  await worker.register();
  assert.deepEqual(registrations, [baseUrl + scriptName]);
  await worker.prepare(download);
  assert.deepEqual(requests, [route, sourceUrl]);
  assert.deepEqual(worker.savedAudio(download), { kind: "saved", url: sourceUrl });
  assert.equal(worker.savedAudio({ ...download, downloadId: "new-edition" }), null);
  assert.equal(worker.allowNetworkSource(), false);

  navigatorObject.onLine = true;
  assert.equal(worker.savedAudio(download), null);
  assert.equal(worker.allowNetworkSource(), true);
  navigatorObject.onLine = false;
  workers.controller = {
    scriptURL: baseUrl + `sw-${"b".repeat(64)}.js`,
    postMessage({ type }, [reply]) {
      assert.equal(type, capabilityType);
      reply.postMessage({ type, scope: baseUrl, audio: true, cover: true, sequence: 20 });
      reply.close();
    },
  };
  workers.dispatchEvent(new Event("controllerchange"));
  assert.equal(worker.savedAudio(download), null);
  await worker.prepare(download);
  assert.deepEqual(worker.savedAudio(download), { kind: "saved", url: route });
  assert.equal(worker.allowNetworkSource(), true);
  assert.deepEqual(requests, [route, sourceUrl]);
  await worker.register();
  assert.deepEqual(registrations, [baseUrl + scriptName], "the older page cannot downgrade a newer installation");
});

test("an unversioned compatible controller proves its audio route with a saved response", async () => {
  const controller = { scriptURL: baseUrl + "sw.js" };
  const navigatorObject = { serviceWorker: { controller }, onLine: false };
  const route = baseUrl + "__compact_player_offline__/audio.json?download=one";
  const requests = [];
  let valid = true;
  const worker = new PlayerWorker({ baseUrl, navigatorObject, async fetchImpl(url) {
    requests.push(url);
    return new Response(null, { headers: valid ? legacyHeaders : { "content-type": "text/html" } });
  } });
  await worker.prepare(download);
  assert.deepEqual(worker.savedAudio(download), { kind: "saved", url: route });
  assert.deepEqual(requests, [route]);

  valid = false;
  const replacement = { ...download, downloadId: "other" };
  await worker.prepare(replacement);
  assert.equal(worker.savedAudio(replacement), null);
  assert.equal(worker.allowNetworkSource(), false);
  await worker.prepare(null);
});

test("a failed legacy audio probe retries once and expires without changing controller or connectivity", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const controller = { scriptURL: baseUrl + "sw.js" };
  const navigatorObject = { serviceWorker: { controller }, onLine: false };
  const routes = [];
  let available = false;
  const worker = new PlayerWorker({ baseUrl, navigatorObject, async fetchImpl(url) {
    routes.push(url);
    return available && url !== sourceUrl
      ? new Response(null, { headers: legacyHeaders })
      : new Response(null, { status: 503 });
  } });
  const route = baseUrl + "__compact_player_offline__/audio.json?download=one";
  const first = worker.prepare(download);
  assert.equal(worker.prepare(download), first);
  await first;
  assert.deepEqual(routes, [route, sourceUrl]);
  assert.equal(worker.savedAudio(download), null);

  available = true;
  t.mock.timers.tick(999);
  await new Promise(setImmediate);
  assert.equal(routes.length, 2);
  t.mock.timers.tick(1);
  await new Promise(setImmediate);
  assert.deepEqual(routes, [route, sourceUrl, route]);
  assert.deepEqual(worker.savedAudio(download), { kind: "saved", url: route });
  t.mock.timers.tick(5000);
  await worker.prepare(download);
  assert.equal(routes.length, 3, "a positive probe stays cached");

  const replacement = { ...download, downloadId: "other" };
  available = false;
  await worker.prepare(replacement);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(routes.length, 7);
  available = true;
  t.mock.timers.tick(4999);
  await worker.prepare(replacement);
  assert.equal(routes.length, 7, "a repeated failure is cached during the backoff");
  t.mock.timers.tick(1);
  await worker.prepare(replacement);
  assert.equal(routes.length, 8);
  assert.match(worker.savedAudio(replacement)?.url, /download=other$/);
});

test("the bridge worker for the same release keeps offline access without a new registration", async () => {
  const releaseId = "a".repeat(64);
  const controller = {
    scriptURL: baseUrl + "sw.js",
    postMessage({ type }, [reply]) {
      reply.postMessage({ type, scope: baseUrl, releaseId, sequence: 10, audio: true, cover: true });
      reply.close();
    },
  };
  const navigatorObject = { onLine: false, serviceWorker: { controller, register: assert.fail } };
  const worker = new PlayerWorker({ baseUrl, navigatorObject, scriptName: `sw-${releaseId}.js`, releaseSequence: 10, fetchImpl: assert.fail });
  await worker.register();
  await worker.prepare(download);
  assert.match(worker.savedAudio(download)?.url, /audio\.json\?download=one$/);
});

test("a capability timeout is retried and restores offline writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const workers = new EventTarget();
  workers.controller = {
    scriptURL: baseUrl + "sw.js",
    postMessage({ type }, [reply]) {
      calls++;
      if (calls > 1) reply.postMessage({ type, scope: baseUrl, audio: true, offlineJournal: 1 });
      reply.close();
    },
  };
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers }, fetchImpl: assert.fail });
  let recovered = 0;
  worker.listen(assert.fail, () => { recovered++; });
  const first = worker.supportsOfflineWrites();
  t.mock.timers.tick(750);
  assert.equal(await first, false);
  t.mock.timers.tick(5000);
  await worker.connection.hello;
  assert.equal(await worker.supportsOfflineWrites(), true);
  assert.equal(recovered, 1);
  assert.equal(calls, 2);
});

test("an unknown hashed controller is not replaced by an older release", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workers = {
    controller: { scriptURL: baseUrl + `sw-${"b".repeat(64)}.js`, postMessage(_, [reply]) { reply.close(); } },
    register: t.mock.fn(),
  };
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: `sw-${"a".repeat(64)}.js`, releaseSequence: 1 });
  const registration = worker.register();
  t.mock.timers.tick(750);
  await registration;
  assert.equal(workers.register.mock.callCount(), 0);
});

test("opening offline controls can recover after repeated capability timeouts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const workers = new EventTarget();
  workers.controller = {
    scriptURL: baseUrl + "sw.js",
    postMessage({ type }, [reply]) {
      attempts++;
      if (attempts >= 3) reply.postMessage({ type, scope: baseUrl, audio: true, offlineJournal: 1 });
      reply.close();
    },
  };
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers } });
  let updates = 0;
  worker.listen(assert.fail, () => updates++);
  const initial = worker.supportsOfflineWrites();
  t.mock.timers.tick(750);
  assert.equal(await initial, false);
  t.mock.timers.tick(5000);
  t.mock.timers.tick(750);
  await worker.connection.hello;
  assert.equal(worker.canWriteOfflineJournal, false);
  assert.equal(await worker.retryCapabilities(), true);
  assert.equal(attempts, 3);
  assert.equal(updates, 1);
});

test("a delayed reply from an older worker resumes registration of the newer release", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const workers = new EventTarget();
  let attempts = 0;
  workers.controller = {
    scriptURL: baseUrl + `sw-${oldId}.js`,
    postMessage({ type }, [reply]) {
      if (++attempts > 1) reply.postMessage({ type, scope: baseUrl, audio: true,
        offlineJournal: 1, sequence: 1, releaseId: oldId });
      reply.close();
    },
  };
  const registrations = [];
  workers.register = async (url) => { registrations.push(url.href); };
  workers.ready = Promise.resolve();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: `sw-${newId}.js`, releaseSequence: 2 });
  worker.listen(assert.fail);
  const initial = worker.register();
  t.mock.timers.tick(750);
  await initial;
  assert.deepEqual(registrations, []);
  t.mock.timers.tick(5000);
  await worker.connection.hello;
  await new Promise(setImmediate);
  assert.deepEqual(registrations, [baseUrl + `sw-${newId}.js`]);
});

test("a delayed newer controller does not downgrade to the current page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const workers = new EventTarget();
  let attempts = 0;
  workers.controller = {
    scriptURL: baseUrl + `sw-${newId}.js`,
    postMessage({ type }, [reply]) {
      if (++attempts > 1) reply.postMessage({ type, scope: baseUrl, audio: true,
        offlineJournal: 1, sequence: 2, releaseId: newId });
      reply.close();
    },
  };
  workers.register = t.mock.fn();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: `sw-${oldId}.js`, releaseSequence: 1 });
  worker.listen(assert.fail);
  const initial = worker.register();
  t.mock.timers.tick(750);
  await initial;
  t.mock.timers.tick(5000);
  await worker.connection.hello;
  await new Promise(setImmediate);
  assert.equal(workers.register.mock.callCount(), 0);
});

test("a controller change resumes a deferred update against the replacement controller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const workers = new EventTarget();
  workers.controller = { scriptURL: baseUrl + `sw-${oldId}.js`, postMessage(_, [reply]) { reply.close(); } };
  const registrations = [];
  workers.register = async (url) => { registrations.push(url.href); };
  workers.ready = Promise.resolve();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers, onLine: true },
    scriptName: `sw-${newId}.js`, releaseSequence: 2 });
  worker.listen(assert.fail);
  const initial = worker.register();
  t.mock.timers.tick(750);
  await initial;
  workers.controller = {
    scriptURL: baseUrl + "sw.js",
    postMessage({ type }, [reply]) {
      reply.postMessage({ type, scope: baseUrl, audio: true, offlineJournal: 1, sequence: 1, releaseId: oldId });
      reply.close();
    },
  };
  workers.dispatchEvent(new Event("controllerchange"));
  await worker.connection.hello;
  await new Promise(setImmediate);
  assert.deepEqual(registrations, [baseUrl + `sw-${newId}.js`]);
});

test("a failed deferred registration can be retried from Options", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  let attempts = 0;
  let registrations = 0;
  const workers = new EventTarget();
  workers.controller = {
    scriptURL: baseUrl + `sw-${oldId}.js`,
    postMessage({ type }, [reply]) {
      if (++attempts > 1) reply.postMessage({ type, scope: baseUrl, audio: true,
        offlineJournal: 1, sequence: 1, releaseId: oldId });
      reply.close();
    },
  };
  workers.register = async () => {
    if (++registrations === 1) throw new TypeError("Temporary registration failure");
  };
  workers.ready = Promise.resolve();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: `sw-${newId}.js`, releaseSequence: 2 });
  worker.listen(assert.fail);
  const initial = worker.register();
  t.mock.timers.tick(750);
  await initial;
  t.mock.timers.tick(5000);
  await worker.connection.hello;
  await new Promise(setImmediate);
  assert.equal(registrations, 1);
  assert.equal(await worker.retryCapabilities(), true);
  assert.equal(registrations, 2);
  assert.equal(worker.connection.registrationDeferred, false);
});

test("a deferred update resumes if the old controller disappears", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const workers = new EventTarget();
  workers.controller = { scriptURL: baseUrl + `sw-${oldId}.js`, postMessage(_, [reply]) { reply.close(); } };
  const registrations = [];
  workers.register = async (url) => { registrations.push(url.href); };
  workers.ready = Promise.resolve();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers, onLine: true },
    scriptName: `sw-${newId}.js`, releaseSequence: 2 });
  worker.listen(assert.fail);
  const initial = worker.register();
  t.mock.timers.tick(750);
  await initial;
  workers.controller = null;
  workers.dispatchEvent(new Event("controllerchange"));
  await new Promise(setImmediate);
  assert.deepEqual(registrations, [baseUrl + `sw-${newId}.js`]);
});

test("a hashed controller without a release sequence is rechecked before an update", async () => {
  const oldId = "a".repeat(64);
  const newId = "b".repeat(64);
  const workers = new EventTarget();
  let sequence;
  workers.controller = {
    scriptURL: baseUrl + `sw-${newId}.js`,
    postMessage({ type }, [reply]) {
      reply.postMessage({ type, scope: baseUrl, audio: true, offlineJournal: 1, sequence, releaseId: newId });
      reply.close();
    },
  };
  let registrations = 0;
  workers.register = async () => { registrations++; };
  workers.ready = Promise.resolve();
  const worker = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: `sw-${oldId}.js`, releaseSequence: 1 });
  worker.listen(assert.fail);
  await worker.register();
  assert.equal(registrations, 0);
  assert.equal(worker.connection.registrationDeferred, true);
  sequence = 2;
  await worker.retryCapabilities();
  assert.equal(registrations, 0);
  assert.equal(worker.connection.registrationDeferred, false);
});

test("a silent bridge updates its own registration instead of installing an old page's worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = { scriptURL: baseUrl + "sw.js", postMessage(_, [reply]) { reply.close(); } };
  const update = t.mock.fn(async () => {});
  const workers = {
    controller, register: assert.fail,
    getRegistration: async () => ({ active: controller, update }),
  };
  const client = new PlayerWorker({ baseUrl, navigatorObject: { serviceWorker: workers },
    scriptName: "sw-" + "a".repeat(64) + ".js", releaseSequence: 1 });
  const registration = client.register();
  t.mock.timers.tick(750);
  await registration;
  assert.equal(update.mock.callCount(), 1);
});
