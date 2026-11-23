import assert from "node:assert/strict";
import test from "node:test";
import { PlayerWorker } from "../js/player-worker.js?v=20";

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
