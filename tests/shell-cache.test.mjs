import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { webcrypto } from "node:crypto";
import { isPlayerServiceWorker } from "../js/utils.js?v=25";

const run = promisify(execFile);
const sourceWorker = new URL("../sw.js", import.meta.url);
const version = Number(readFileSync(sourceWorker, "utf8").match(/const SHELL_VERSION = "v(\d+)"/)[1]);
const previousVersion = version - 1;
const nextVersion = version + 1;
const page = (version) => `<link rel="stylesheet" href="./player.css?v=${version}"><script type="module" src="./player.js?v=${version}"></script>`;

function createWorker({ pageVersion = version, workerUrl = sourceWorker, fetchAsset, stores = new Map() } = {}) {
  const scope = "https://example.test/player/";
  const handlers = new Map();
  const requests = [];
  const lifecycle = { skipWaiting: 0, claimed: 0 };
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const items = stores.get(name);
      return {
        async addAll(entries) {
          for (const entry of entries) {
            requests.push(entry);
            if (fetchAsset) {
              const response = await fetchAsset(entry);
              if (!response.ok) throw new Error(`Could not cache ${entry.url}`);
              items.set(entry.url, response);
              continue;
            }
            const url = new URL(entry.url);
            const body = url.pathname.endsWith("/") || url.pathname.endsWith("index.html")
              ? pageVersion === "commented" ? `<!-- ${page(version)} -->${page(previousVersion)}` : page(pageVersion)
              : `asset ${url.search}`;
            items.set(entry.url, new Response(body));
          }
        },
        async match(entry) { return items.get(typeof entry === "string" ? entry : entry.url)?.clone(); },
        async keys() { return [...items.keys()].map((key) => new Request(key)); },
        async put(entry, response) { items.set(typeof entry === "string" ? entry : entry.url, response.clone()); },
      };
    },
    async match(url, { cacheName }) { return stores.get(cacheName)?.get(url)?.clone(); },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    registration: { scope },
    location: { origin: new URL(scope).origin },
    addEventListener(type, handler) { handlers.set(type, handler); },
    async skipWaiting() { lifecycle.skipWaiting += 1; },
    clients: { async claim() { lifecycle.claimed += 1; } },
  };
  const context = vm.createContext({ self, URL, Request, Response, Headers, TextDecoder, DOMException, AbortSignal, AbortController, TransformStream,
    setTimeout, clearTimeout, caches: cacheStorage, crypto: webcrypto,
    fetch: fetchAsset && ((input, options) => fetchAsset(new Request(input, options))) });
  context.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(readFileSync(new URL(path, workerUrl), "utf8"), context);
  };
  vm.runInContext(readFileSync(workerUrl, "utf8"), context);
  return { scope, handlers, requests, stores, context, lifecycle };
}

async function dispatch(handlers, type) {
  let completion;
  handlers.get(type)({ waitUntil(promise) { completion = promise; } });
  await completion;
}

function dispatchFetch(handlers, request) {
  let response;
  let completion;
  handlers.get("fetch")({ request, respondWith(promise) { response = promise; },
    waitUntil(promise) { completion = promise; } });
  return { response, completion };
}

function predecessorEntries(scope, marker, id, { missing } = {}) {
  const base = `./releases/${id}/`;
  const modules = ["player.js", "js/config.js"];
  const integrity = Object.fromEntries(modules.map((path) => [base + path, "sha256-example"]));
  const html = `<script type="importmap">${JSON.stringify({ integrity })}</script><title>older player</title>`;
  const entries = new Map([[marker, new Response(id)], [scope + `release-${id}.html`, new Response(html)]]);
  for (const path of [...modules, "player.css"]) {
    if (path !== missing) entries.set(new URL(base + path, scope).href, new Response("asset"));
  }
  return entries;
}

test("both old and versioned player workers are recognized only in their own installation", () => {
  const base = "https://example.test/player/";
  for (const scriptURL of [base + "sw.js", base + "sw.js?v=25"]) {
    assert.equal(isPlayerServiceWorker({ scriptURL }, base), true);
  }
  for (const scriptURL of ["https://other.test/player/sw.js?v=25", "https://example.test/other/sw.js?v=25", "invalid"]) {
    assert.equal(isPlayerServiceWorker({ scriptURL }, base), false);
  }
  assert.equal(isPlayerServiceWorker(null, base), false);
});

test("install caches the versioned page and refuses to substitute another module version", async () => {
  const { scope, handlers, requests, context } = createWorker();
  await dispatch(handlers, "install");
  assert.ok(requests.some((request) => request.url === `${scope}index.html?v=${version}`));
  assert.ok(requests.some((request) => request.url === `${scope}?v=${version}`));
  assert.ok(requests.every((request) => new URL(request.url).search === `?v=${version}`));

  const navigation = new Request(`${scope}?book=book-a`);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  assert.equal(await (await context.cachedShell(navigation)).text(), page(version));
  assert.equal(await (await context.cachedShell(new Request(`${scope}js/config.js?v=${version}`))).text(), `asset ?v=${version}`);
  assert.equal(await context.cachedShell(new Request(`${scope}js/config.js?v=${previousVersion}`)), undefined);
  assert.equal(await context.cachedShell(new Request(`${scope}js/config.js`)), undefined);
});

test("worker installation rejects outdated or commented-out shell entries", async () => {
  for (const pageVersion of [previousVersion, "commented"]) {
    const { handlers, stores } = createWorker({ pageVersion });
    await assert.rejects(dispatch(handlers, "install"), /version does not match/);
    assert.equal(stores.size, 0, "failed installation removes its staging cache");
  }
});

test("navigation falls back from stale HTML but accepts a newer consistent shell", async () => {
  const { scope, handlers, context } = createWorker();
  await dispatch(handlers, "install");
  const navigation = new Request(`${scope}?book=book-a`);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  context.fetch = async () => new Response(page(previousVersion));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(version));
  context.fetch = async () => new Response(page(nextVersion));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(nextVersion));
  context.fetch = async () => new Response(page(nextVersion).replace(`player.css?v=${nextVersion}`, `player.css?v=${version}`));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(version));
});

test("worker activation retains downloaded books", async () => {
  const { handlers, stores, context } = createWorker();
  await dispatch(handlers, "install");
  const prefix = vm.runInContext("SHELL_CACHE_PREFIX", context);
  stores.set(`${prefix}v${previousVersion}`, new Map());
  stores.set("saved-offline-audiobook", new Map([["audio", "saved"]]));
  await dispatch(handlers, "activate");
  assert.equal(stores.has(`${prefix}v${previousVersion}`), false);
  assert.equal(stores.get("saved-offline-audiobook").get("audio"), "saved");
});

async function generateRelease(t) {
  const directory = await mkdtemp(join(tmpdir(), "compact-player-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tool = new URL("../tools/prepare-release.mjs", import.meta.url);
  const { stdout } = await run(process.execPath, [fileURLToPath(tool), directory]);
  return { directory, ...JSON.parse(stdout) };
}

test("packaged asset verification stops reading overlong responses before writing to Cache Storage", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const assetPath = `releases/${id}/i18n.js`;
  const expected = await readFile(join(directory, assetPath));
  let pulls = 0;
  let cancellations = 0;
  const overlong = () => {
    const chunks = [expected, Uint8Array.of(1), new Uint8Array(1024 * 1024)];
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 });
    return new Response(body);
  };
  const fetchAsset = async (request) => {
    const path = new URL(request.url).pathname.slice("/player/".length);
    return path === assetPath ? overlong() : new Response(await readFile(join(directory, path)));
  };
  const { scope, handlers, context, stores } = createWorker({ workerUrl, fetchAsset });
  const url = scope + assetPath;
  context.caches.delete = async () => false;
  const mismatch = /Release asset does not match its manifest: .*\/i18n\.js/;
  await assert.rejects(dispatch(handlers, "install"), mismatch);
  assert.equal(pulls, 2);
  assert.equal(cancellations, 1);
  const installed = stores.get(vm.runInContext("SHELL_CACHE", context));
  assert.equal(installed.has(url), false);

  await assert.rejects(context.networkFirst(new Request(url)), mismatch);
  assert.equal(pulls, 4);
  assert.equal(cancellations, 2);
  assert.equal(installed.has(url), false);
});

test("the shell bounds network time through the end of the body and the size of ordinary HTML", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const assetPath = `releases/${id}/js/config.js`;
  const bytes = await readFile(join(directory, assetPath));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scope, context } = createWorker({ workerUrl: pathToFileURL(join(directory, workerPath)) });
  const asset = new Request(scope + assetPath);
  const navigation = new Request(scope);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  let cancelled = 0;
  let inputSignal;
  let rejection;
  for (const response of [
    () => new Promise(() => {}),
    () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes); },
      cancel() { cancelled += 1; },
    })),
  ]) {
    context.fetch = async (url, options) => { inputSignal = options.signal; return response(); };
    context.networkFirst(asset).catch((error) => { rejection = error; });
    await new Promise(setImmediate);
    assert.equal(inputSignal.aborted, false);
    t.mock.timers.tick(15000);
    await new Promise(setImmediate);
    assert.equal(rejection?.name, "TimeoutError");
    assert.equal(inputSignal.aborted, true);
    rejection = null;
  }
  assert.equal(cancelled, 1);

  let pulls = 0;
  context.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls === 4) controller.close();
      else controller.enqueue(new Uint8Array(256 * 1024));
    },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }));
  await assert.rejects(context.networkFirst(navigation), /Player shell version does not match/);
  assert.equal(pulls, 2);
  assert.equal(cancelled, 2);
});

test("the release page authenticates every module before first startup", async (t) => {
  const { directory, id, page: alias } = await generateRelease(t);
  const manifest = JSON.parse(await readFile(join(directory, "releases", id, "manifest.json"), "utf8"));
  const expected = Object.fromEntries(Object.entries(manifest.assets)
    .filter(([path]) => path.endsWith(".js"))
    .map(([path, asset]) => [`./${path}`, `sha256-${Buffer.from(asset.sha256, "hex").toString("base64")}`]));
  assert.ok(expected[`./releases/${id}/js/config.js`]);
  for (const [path, asset] of Object.entries(manifest.assets)) {
    assert.equal(asset.bytes, (await readFile(join(directory, path))).byteLength, path);
  }

  for (const file of ["index.html", alias]) {
    const html = await readFile(join(directory, file), "utf8");
    const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    assert.ok(map, `${file} is missing module integrity metadata`);
    assert.ok(map.index < html.indexOf('<script type="module"'));
    assert.deepEqual(JSON.parse(map[1]).integrity, expected);
  }
});

test("a rejected player module shows a reload action without losing the page URL", async (t) => {
  const { directory, id } = await generateRelease(t);
  const html = await readFile(join(directory, "index.html"), "utf8");
  const feedback = html.match(/<script src="([^\"]+\/startup-error\.js)" integrity="(sha256-[^\"]+)"><\/script>/);
  assert.ok(feedback, "a separate startup script is protected by its own integrity hash");
  assert.equal(feedback[1], `./releases/${id}/js/startup-error.js`);
  assert.ok(feedback.index < html.indexOf('<script type="module"'));
  assert.match(html, /<script type="module"[^>]+id="playerEntry"/);
  assert.match(html, /<button id="startupReload"[^>]+hidden>/);

  const startupScript = await readFile(join(directory, feedback[1]), "utf8");
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(startupScript));
  assert.equal(feedback[2], `sha256-${Buffer.from(digest).toString("base64")}`);

  const retry = Object.assign(new EventTarget(), { hidden: true });
  const meta = { textContent: "Loading…", classList: new Set() };
  const announcer = { textContent: "" };
  const bodyClasses = new Set(["is-loading"]);
  const playerClasses = new Set(["is-loading"]);
  let content;
  const attributes = new Map([["aria-busy", "true"]]);
  const player = {
    classList: { remove: (name) => playerClasses.delete(name) },
    contains: () => false,
    setAttribute: (name, value) => attributes.set(name, value),
    replaceChildren: (...children) => { content = children; },
  };
  const elements = new Map([["startupReload", retry], ["bookMeta", meta], ["statusAnnouncer", announcer], ["player", player]]);
  const pageUrl = "https://example.test/books/?book=north&mode=compact#player";
  const reloads = [];
  let onError;
  vm.runInNewContext(startupScript, {
    document: {
      body: { classList: { remove: (name) => bodyClasses.delete(name) } },
      getElementById: (id) => elements.get(id),
      addEventListener(type, callback, capture) {
        assert.equal(type, "error");
        assert.equal(capture, true);
        onError = callback;
      },
    },
    location: { href: pageUrl, reload() { reloads.push(this.href); } },
  });

  onError({ target: { id: "coverImg" } });
  assert.equal(retry.hidden, true);
  assert.equal(meta.textContent, "Loading…");

  onError({ target: { id: "playerEntry" } });
  assert.equal(attributes.get("aria-busy"), "false");
  assert.equal(bodyClasses.has("is-loading"), false);
  assert.equal(playerClasses.has("is-loading"), false);
  assert.match(meta.textContent, /could not load/i);
  assert.equal(announcer.textContent, meta.textContent);
  assert.deepEqual(content, [retry]);
  assert.equal(retry.hidden, false);
  retry.dispatchEvent(new Event("click"));
  assert.deepEqual(reloads, [pageUrl]);
});

test("a release worker rejects stale module bytes even when HTML is current", async (t) => {
  const { directory, id, page: releasePage, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const index = await readFile(join(directory, "index.html"), "utf8");
  const manifest = JSON.parse(await readFile(join(directory, "releases", id, "manifest.json"), "utf8"));
  assert.equal(manifest.id, id);
  assert.equal(await readFile(join(directory, "sw.js"), "utf8"), await readFile(workerUrl, "utf8"));
  assert.equal(await readFile(join(directory, releasePage), "utf8"), index);
  const entryPoint = await readFile(join(directory, "releases", id, "player.js"), "utf8");
  assert.match(entryPoint, /from "\.\/js\/player-app\.js"/);

  let staleConfig = true;
  const fetchAsset = async (entry) => {
    const url = new URL(typeof entry === "string" ? entry : entry.url);
    if (staleConfig && url.pathname.endsWith("/js/config.js")) return new Response("export const oldConfiguration = true;");
    return new Response(await readFile(new URL(url.pathname.slice("/player/".length), workerUrl)));
  };
  const { handlers, stores, scope, context, lifecycle } = createWorker({ workerUrl, fetchAsset });
  await assert.rejects(dispatch(handlers, "install"), /Release asset does not match its manifest: .*\/js\/config\.js/);
  assert.equal(lifecycle.skipWaiting, 0);
  assert.equal(stores.size, 0);

  staleConfig = false;
  await dispatch(handlers, "install");
  assert.equal(lifecycle.skipWaiting, 1);
  const installedUrl = `releases/${id}/js/config.js`;
  assert.ok(manifest.assets[installedUrl]);
  staleConfig = true;
  const installed = await context.networkFirst(new Request(scope + installedUrl));
  assert.match(await installed.text(), /export function parseBookConfig\(/);

  const navigate = (path) => {
    const request = new Request(scope + path);
    Object.defineProperty(request, "mode", { value: "navigate" });
    return context.networkFirst(request);
  };
  const staleIndex = index.replaceAll(id, "a".repeat(64)).replace(`content="${manifest.sequence}"`, `content="${manifest.sequence - 1}"`);
  context.fetch = async () => new Response(staleIndex);
  assert.equal(await (await navigate("index.html?book=north")).text(), index);
  const laterIndex = index.replaceAll(id, "b".repeat(64)).replace(`content="${manifest.sequence}"`, `content="${manifest.sequence + 1}"`);
  context.fetch = async () => new Response(laterIndex);
  assert.equal(await (await navigate("index.html?book=north")).text(), laterIndex);
  context.fetch = async () => { throw new TypeError("Offline"); };
  assert.equal(await (await navigate(`${releasePage}?book=north`)).text(), index);
});

test("a release worker verifies network modules when opening or reading the installed cache fails", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
  const { scope, handlers, context } = createWorker({ workerUrl, fetchAsset });
  await dispatch(handlers, "install");

  const request = new Request(`${scope}releases/${id}/js/config.js`);
  const correct = await readFile(join(directory, "releases", id, "js", "config.js"), "utf8");
  for (const operation of ["open", "match"]) {
    const unavailable = async () => { throw new Error(`Cache ${operation} failed`); };
    let writes = 0;
    context.caches.open = operation === "open" ? unavailable : async () => ({
      match: unavailable, async put() { writes += 1; },
    });
    const reads = [];
    context.fetch = async (url, options) => {
      reads.push(url);
      assert.equal(options.redirect, "error");
      return new Response(correct);
    };
    assert.equal(await (await context.networkFirst(request)).text(), correct);
    assert.deepEqual(reads, [request.url]);

    context.fetch = async () => new Response(correct + "\n// wrong release");
    await assert.rejects(context.networkFirst(request), /Release asset does not match its manifest/);
    assert.equal(writes, 0);
  }
});

test("canceling a release asset request discards its delayed cache lookup", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const { context, scope } = createWorker({ workerUrl: pathToFileURL(join(directory, workerPath)) });
  let entered;
  let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const cacheOpen = new Promise((resolve) => { release = resolve; });
  context.caches.open = () => { entered(); return cacheOpen; };
  let matches = 0;
  context.fetch = assert.fail;
  const controller = new AbortController();
  const request = new Request(scope + `releases/${id}/js/config.js`, { signal: controller.signal });
  const result = context.networkFirst(request);
  await started;
  controller.abort();
  release({ match: () => { matches++; return new Response("unused"); } });
  await assert.rejects(result, { name: "AbortError" });
  await new Promise(setImmediate);
  assert.equal(matches, 0);
});

test("verified network bytes repair a cache miss only in an installed release", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
  const { scope, handlers, context, stores } = createWorker({ workerUrl, fetchAsset });
  await dispatch(handlers, "install");
  const shell = stores.get(vm.runInContext("SHELL_CACHE", context));
  const ready = vm.runInContext("RELEASE_READY_URL", context);
  const path = `releases/${id}/js/config.js`;
  const request = new Request(scope + path);
  const correct = await readFile(join(directory, path));
  shell.delete(request.url);

  const wrong = Buffer.from(correct);
  wrong[0] ^= 1;
  context.fetch = async () => new Response(wrong);
  await assert.rejects(context.networkFirst(request), /Release asset does not match its manifest/);
  assert.equal(shell.has(request.url), false);

  context.fetch = async () => new Response(correct, {
    headers: { "Content-Encoding": "gzip", "Content-Length": "20", "Content-Type": "application/javascript" },
  });
  const recovered = await context.networkFirst(request);
  assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), correct);
  assert.equal(recovered.headers.get("Content-Encoding"), null);
  assert.equal(recovered.headers.get("Content-Length"), String(correct.byteLength));
  assert.equal(recovered.headers.get("Content-Type"), "application/javascript");
  const onlineFetch = context.fetch;
  context.fetch = assert.fail;
  assert.deepEqual(Buffer.from(await (await context.networkFirst(request)).arrayBuffer()), correct);

  shell.delete(request.url);
  const marker = shell.get(ready);
  shell.delete(ready);
  context.fetch = onlineFetch;
  assert.deepEqual(Buffer.from(await (await context.networkFirst(request)).arrayBuffer()), correct);
  assert.equal(shell.has(request.url), false);

  shell.set(ready, marker);
  const { open } = context.caches;
  const writeErrors = [new DOMException("Out of space", "QuotaExceededError"), null];
  for (const error of writeErrors) {
    let writing;
    const repair = new Promise((resolve) => { writing = resolve; });
    let attempts = 0;
    context.caches.open = async (name) => ({
      ...await open(name),
      async put() {
        attempts += 1;
        writing();
        if (error) throw error;
        return new Promise(() => {});
      },
    });
    const response = context.networkFirst(request);
    await repair;
    if (!error) t.mock.timers.tick(1000);
    assert.deepEqual(Buffer.from(await (await response).arrayBuffer()), correct);
    assert.equal(attempts, 1);
  }
});

test("an active worker rebuilds its missing release once and publishes readiness last", async (t) => {
  const { directory, id, workerPath, page: alias } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const { scope, handlers, context, stores } = createWorker({ workerUrl });
  const cacheName = vm.runInContext("SHELL_CACHE", context);
  const marker = vm.runInContext("RELEASE_READY_URL", context);
  const entry = `releases/${id}/player.js`;
  const config = `releases/${id}/js/config.js`;
  const rebuildAsset = `releases/${id}/player.css`;
  const manifest = JSON.parse(await readFile(join(directory, "releases", id, "manifest.json"), "utf8"));
  const onlineFetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const path = url.pathname.slice("/player/".length);
    return new Response(await readFile(join(directory, path || alias)), {
      headers: path ? {} : { "Content-Security-Policy": "default-src 'none'" },
    });
  };
  context.fetch = onlineFetch;
  await dispatch(handlers, "install");
  await context.caches.delete(cacheName);
  stores.set("downloaded-book", new Map([["audio", "saved"]]));

  let unblock;
  let reached;
  const blocking = new Promise((resolve) => { unblock = resolve; });
  const reachedRebuild = new Promise((resolve) => { reached = resolve; });
  let rebuildReads = 0;
  let failRebuild = true;
  context.fetch = async (input) => {
    if (String(input) === scope + rebuildAsset) {
      rebuildReads += 1;
      reached();
      await blocking;
      if (failRebuild) return new Response("corrupt");
    }
    return onlineFetch(input);
  };
  t.after(unblock);
  const root = new Request(`${scope}?book=one`);
  Object.defineProperty(root, "mode", { value: "navigate" });
  const first = dispatchFetch(handlers, root);
  assert.equal((await first.response).ok, true);
  await Promise.race([reachedRebuild, first.completion]);
  assert.equal(rebuildReads, 1);
  const second = dispatchFetch(handlers, new Request(scope + entry));
  const third = dispatchFetch(handlers, new Request(scope + config));
  assert.equal((await second.response).ok, true);
  assert.equal((await third.response).ok, true);
  assert.equal(stores.get(cacheName).has(marker), false);
  const cachedAlias = stores.get(cacheName).get(scope + alias);
  assert.equal(cachedAlias.headers.get("Content-Security-Policy"), null, "cache the alias's own headers");
  unblock();
  await Promise.all([first.completion, second.completion, third.completion]);
  assert.equal(rebuildReads, 1);
  assert.equal(stores.get(cacheName).has(marker), false, "an interrupted rebuild must not publish readiness");

  failRebuild = false;
  const retry = dispatchFetch(handlers, new Request(scope + config));
  assert.equal((await retry.response).ok, true);
  await retry.completion;
  const restored = stores.get(cacheName);
  assert.equal(rebuildReads, 2);
  assert.deepEqual([...restored.keys()].sort(), [...Object.keys(manifest.assets).map((path) => scope + path), marker].sort());
  assert.equal([...restored.keys()].at(-1), marker);
  assert.equal(stores.get("downloaded-book").get("audio"), "saved");

  context.fetch = async () => { throw new TypeError("Offline"); };
  assert.match(await (await dispatchFetch(handlers, root).response).text(), new RegExp(id));
  assert.match(await (await dispatchFetch(handlers, new Request(scope + config)).response).text(), /export function parseBookConfig/);
});

test("an interrupted release cannot displace the last complete offline release", async (t) => {
  const stores = new Map();
  const openRelease = async () => {
    const { directory, id, workerPath, page: alias } = await generateRelease(t);
    const workerUrl = pathToFileURL(join(directory, workerPath));
    const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
    const worker = createWorker({ workerUrl, fetchAsset, stores });
    const cacheName = vm.runInContext("SHELL_CACHE", worker.context);
    return { ...worker, alias, id, cacheName };
  };

  const previous = await openRelease();
  await dispatch(previous.handlers, "install");
  await dispatch(previous.handlers, "activate");

  const interrupted = await openRelease();
  const storage = interrupted.context.caches;
  const { open, delete: remove } = storage;
  const quota = new DOMException("Out of space", "QuotaExceededError");
  let writes = 0;
  storage.open = async (name) => {
    const cache = await open(name);
    if (name !== interrupted.cacheName) return cache;
    return {
      ...cache,
      async put(...args) { if (++writes === 2) throw quota; return cache.put(...args); },
    };
  };
  storage.delete = async (name) => {
    if (name === interrupted.cacheName) throw new Error("Cleanup unavailable during interrupted install");
    return remove(name);
  };
  await assert.rejects(dispatch(interrupted.handlers, "install"), { name: "QuotaExceededError" });
  assert.equal(interrupted.lifecycle.skipWaiting, 0);
  assert.equal(stores.get(interrupted.cacheName).size, 1);

  const current = await openRelease();
  await dispatch(current.handlers, "install");
  await dispatch(current.handlers, "activate");
  assert.ok(stores.has(previous.cacheName));
  assert.ok(!stores.has(interrupted.cacheName));
  current.context.fetch = assert.fail;
  const request = new Request(`${current.scope}${previous.alias}?book=offline`);
  Object.defineProperty(request, "mode", { value: "navigate" });
  assert.match(await (await current.context.networkFirst(request)).text(), new RegExp(previous.id));

  const legacyCacheName = vm.runInContext("RELEASE_CACHE_PREFIX", current.context) + previous.id;
  const legacyEntries = stores.get(previous.cacheName);
  legacyEntries.delete(vm.runInContext("RELEASE_READY_URL", previous.context));
  stores.delete(previous.cacheName);
  stores.set(legacyCacheName, legacyEntries);
  await dispatch(current.handlers, "activate");
  assert.ok(stores.has(legacyCacheName), "an older cache is retained until there is a known complete predecessor");
  assert.match(await (await current.context.networkFirst(request)).text(), new RegExp(previous.id));
});

test("cache cleanup cannot prevent a new worker from claiming its clients", async (t) => {
  for (const operation of ["keys", "delete"]) {
    const { context, stores, handlers, lifecycle } = createWorker();
    stores.set(vm.runInContext("SHELL_CACHE_PREFIX", context) + "obsolete", new Map());
    let attempts = 0;
    context.caches[operation] = async () => { attempts += 1; throw new Error("Cache cleanup failed"); };
    await dispatch(handlers, "activate");
    assert.equal(attempts, 1);
    assert.equal(lifecycle.claimed, 1);
  }

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { context, handlers, lifecycle } = createWorker();
  let releaseKeys;
  let deletes = 0;
  context.caches.keys = () => new Promise((resolve) => { releaseKeys = resolve; });
  context.caches.delete = async () => { deletes += 1; };
  const activation = dispatch(handlers, "activate");
  assert.equal(lifecycle.claimed, 1);
  t.mock.timers.tick(1000);
  await activation;
  releaseKeys([vm.runInContext("SHELL_CACHE_PREFIX", context) + "obsolete"]);
  await new Promise(setImmediate);
  assert.equal(deletes, 0);
});

test("a stalled release cache lookup falls back to verified network bytes before the cache replies", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scope, context } = createWorker({ workerUrl: pathToFileURL(join(directory, workerPath)) });
  const request = new Request(`${scope}releases/${id}/js/config.js`);
  const correct = await readFile(join(directory, "releases", id, "js", "config.js"), "utf8");
  const pending = () => new Promise(() => {});
  let writes = 0;
  for (const operation of ["open", "match", "previous"]) {
    const url = operation === "previous" ? request.url.replace(id, "a".repeat(64)) : request.url;
    context.caches.open = operation === "open" ? pending : async () => ({
      match: pending, async put() { writes += 1; },
    });
    context.caches.match = pending;
    const reads = [];
    context.fetch = async (input) => {
      reads.push(typeof input === "string" ? input : input.url);
      return new Response(correct);
    };
    const response = context.networkFirst(new Request(url));
    await Promise.resolve();
    assert.deepEqual(reads, []);
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    assert.deepEqual(reads, [url]);
    assert.equal(await (await response).text(), correct);
  }
  assert.equal(writes, 0);

  context.fetch = async () => new Response(correct + "\n// wrong release");
  const rejected = assert.rejects(context.networkFirst(request), /Release asset does not match its manifest/);
  t.mock.timers.tick(1000);
  await rejected;
});

test("a stalled shell or book cache fallback preserves the original network result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { scope, context, handlers } = createWorker();
  const navigation = new Request(`${scope}?book=one`);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  const book = new Request(`${scope}media/one/book.json`);
  const coverUrl = new URL("__compact_player_offline__/cover.json", scope);
  coverUrl.search = new URLSearchParams({ url: scope + "media/one/cover.jpg", version: "1", book: "one", config: "one" });
  const cover = new Request(coverUrl);
  Object.defineProperty(cover, "destination", { value: "image" });
  const networkError = new TypeError("Network unavailable");
  for (const [request, result] of [
    [navigation, new Response("Unavailable", { status: 503 })],
    [book, new Response("Missing", { status: 404 })],
    [book, networkError],
    [cover, new Response("Missing cover", { status: 404 })],
  ]) {
    const waiting = [];
    let reads = 0;
    context.caches.open = context.caches.match = () => new Promise((resolve) => { waiting.push(resolve); });
    context.fetch = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    let settled;
    let fallback;
    handlers.get("fetch")({ request, respondWith(promise) { fallback = promise; } });
    fallback.then((response) => { settled = response; }, (error) => { settled = error; });
    await new Promise(setImmediate);
    const lookups = waiting.length;
    assert.ok(lookups > 0);
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    assert.equal(settled, result);
    for (const resolve of [...waiting]) {
      resolve(request === navigation ? { async match() { reads += 1; } } : undefined);
    }
    await new Promise(setImmediate);
    assert.equal(reads, 0, "an expired lookup should not start new cache work");
    assert.equal(waiting.length, lookups);
  }
});

test("a live navigation cancels the late body of an unused cached page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { context, scope } = createWorker();
  let finishNetwork;
  context.fetch = () => new Promise((resolve) => { finishNetwork = resolve; });
  let finishCache;
  context.caches.open = async () => ({ match: () => new Promise((resolve) => { finishCache = resolve; }) });
  const request = new Request(scope);
  Object.defineProperty(request, "mode", { value: "navigate" });
  const result = context.networkFirst(request);
  t.mock.timers.tick(3000);
  await new Promise(setImmediate);
  finishNetwork(new Response(page(version)));
  assert.equal(await (await result).text(), page(version));
  let canceled = false;
  finishCache(new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await new Promise(setImmediate);
  assert.equal(canceled, true);
});

test("a stalled cover request falls back to the saved cover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { context, scope } = createWorker();
  const source = scope + "media/book/cover.jpg";
  const url = new URL(scope + "__compact_player_offline__/cover.json");
  url.search = new URLSearchParams({ url: source, version: "3", book: "one", config: "one" });
  context.fetch = () => new Promise(() => {});
  context.activeManifest = async () => ({ episodeId: "one", configBookId: "one", cacheVersion: 3, cacheName: "saved" });
  await (await context.caches.open("saved")).put(source, new Response("saved cover"));
  const response = context.networkFirstCover(new Request(url), url);
  t.mock.timers.tick(3000);
  assert.equal(await (await response).text(), "saved cover");
});

test("the cover route keeps saved artwork when the server returns an HTML success page", async () => {
  const { context, scope } = createWorker();
  const source = scope + "media/book/cover.jpg";
  const url = new URL(scope + "__compact_player_offline__/cover.json");
  url.search = new URLSearchParams({ url: source, version: "3", book: "one", config: "one" });
  context.fetch = () => new Response("<html>Cover unavailable</html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  context.activeManifest = async () => ({ episodeId: "one", configBookId: "one", cacheVersion: 3, cacheName: "saved" });
  await (await context.caches.open("saved")).put(source, new Response("saved cover", { headers: { "content-type": "image/jpeg" } }));
  const response = await context.networkFirstCover(new Request(url), url);
  assert.equal(await response.text(), "saved cover");
  assert.equal(response.headers.get("content-type"), "image/jpeg");
});

test("canceling a cover request stops its pending saved cover fallback", async () => {
  const { context, scope } = createWorker();
  const url = new URL(scope + "__compact_player_offline__/cover.json");
  url.search = new URLSearchParams({ url: scope + "media/book/cover.jpg", version: "3", book: "one", config: "one" });
  context.fetch = () => new Response(null, { status: 503 });
  context.activeManifest = async () => ({ episodeId: "one", configBookId: "one", cacheVersion: 3, cacheName: "saved" });
  let opened;
  let release;
  const readStarted = new Promise((resolve) => { opened = resolve; });
  const cacheOpen = new Promise((resolve) => { release = resolve; });
  let matches = 0;
  context.caches.open = () => { opened(); return cacheOpen; };
  const controller = new AbortController();
  const response = context.networkFirstCover(new Request(url, { signal: controller.signal }), url);
  await readStarted;
  controller.abort();
  release({ match: () => { matches++; return new Response("saved cover"); } });
  await assert.rejects(response, { name: "AbortError" });
  assert.equal(matches, 0);
});

test("the extracted release handler serves the installed source shell", async () => {
  const { context, handlers, scope } = createWorker();
  await dispatch(handlers, "install");
  const pageRequest = new Request(scope);
  Object.defineProperty(pageRequest, "mode", { value: "navigate" });
  assert.equal(await (await context.cachedShell(pageRequest)).text(), page(version));
});

test("a saved book configuration cancels the pending network request on every signal implementation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const AbortSignalImpl of [AbortSignal, {}]) {
    const { context, scope } = createWorker();
    context.AbortSignal = AbortSignalImpl;
    const url = scope + "media/book/book.json";
    context.activeManifest = async () => ({ episodeId: "book", cacheVersion: 1, cacheName: "saved" });
    await (await context.caches.open("saved")).put(url, new Response("saved config"));
    let signal;
    context.fetch = (_request, options) => {
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };
    const response = context.networkFirst(new Request(url));
    t.mock.timers.tick(3000);
    assert.equal(await (await response).text(), "saved config");
    assert.equal(signal.aborted, true);

    const controller = new AbortController();
    const canceled = context.networkFirst(new Request(url, { signal: controller.signal }));
    controller.abort();
    await assert.rejects(canceled, { name: "AbortError" });
    assert.equal(signal.aborted, true);
  }
});

test("offline navigation uses the verified predecessor when the current release page is missing", async (t) => {
  const { directory, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const { scope, context, stores } = createWorker({ workerUrl });
  const prefix = vm.runInContext("VERIFIED_RELEASE_CACHE_PREFIX", context);
  const marker = vm.runInContext("RELEASE_READY_URL", context);
  const predecessor = "0".repeat(64);
  stores.set(prefix + predecessor, predecessorEntries(scope, marker, predecessor));
  const unverified = "1".repeat(64);
  stores.set(prefix + unverified, new Map([
    [scope + "release-" + unverified + ".html", new Response("incomplete release")],
  ]));
  context.fetch = async () => { throw new TypeError("Offline"); };
  const request = new Request(scope + "?book=saved");
  Object.defineProperty(request, "mode", { value: "navigate" });
  assert.match(await (await context.networkFirst(request)).text(), new RegExp(predecessor));
});

test("offline navigation falls back to the previous release when a current module has been evicted", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
  const { context, handlers, scope, stores } = createWorker({ workerUrl, fetchAsset });
  await dispatch(handlers, "install");
  const cacheName = vm.runInContext("SHELL_CACHE", context);
  const prefix = vm.runInContext("VERIFIED_RELEASE_CACHE_PREFIX", context);
  const marker = vm.runInContext("RELEASE_READY_URL", context);
  const previous = "0".repeat(64);
  stores.set(prefix + previous, predecessorEntries(scope, marker, previous));
  context.fetch = async () => { throw new TypeError("Offline"); };
  const pageRequest = new Request(scope + "?book=saved");
  Object.defineProperty(pageRequest, "mode", { value: "navigate" });
  assert.match(await (await context.networkFirst(pageRequest)).text(), new RegExp(id));

  assert.equal(stores.get(cacheName).delete(scope + `releases/${id}/js/config.js`), true);
  assert.match(await (await context.networkFirst(pageRequest)).text(), new RegExp(previous));
});

test("activation retains an intact predecessor when a newer cached release has lost a module", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
  const { context, handlers, scope, stores } = createWorker({ workerUrl, fetchAsset });
  const intact = "0".repeat(64);
  const damaged = "1".repeat(64);
  const prefix = vm.runInContext("VERIFIED_RELEASE_CACHE_PREFIX", context);
  const marker = vm.runInContext("RELEASE_READY_URL", context);
  stores.set(prefix + intact, predecessorEntries(scope, marker, intact));
  stores.set(prefix + damaged, predecessorEntries(scope, marker, damaged, { missing: "js/config.js" }));
  await dispatch(handlers, "install");
  await dispatch(handlers, "activate");
  assert.equal(stores.has(prefix + intact), true);
  assert.equal(stores.has(prefix + damaged), false);

  const cacheName = vm.runInContext("SHELL_CACHE", context);
  stores.get(cacheName).delete(scope + `releases/${id}/js/config.js`);
  context.fetch = async () => { throw new TypeError("Offline"); };
  const pageRequest = new Request(scope + "?book=saved");
  Object.defineProperty(pageRequest, "mode", { value: "navigate" });
  assert.match(await (await context.networkFirst(pageRequest)).text(), new RegExp(intact));
});

test("offline navigation keeps the installed page when enumerating its files fails", async (t) => {
  const { directory, id, workerPath } = await generateRelease(t);
  const workerUrl = pathToFileURL(join(directory, workerPath));
  const fetchAsset = async (request) => new Response(await readFile(new URL(new URL(request.url).pathname.slice("/player/".length), workerUrl)));
  const { context, handlers, scope } = createWorker({ workerUrl, fetchAsset });
  await dispatch(handlers, "install");
  context.fetch = async () => { throw new TypeError("Offline"); };
  const { open } = context.caches;
  context.caches.open = async (name) => ({ ...await open(name), async keys() { throw new Error("Cannot enumerate cache"); } });
  const pageRequest = new Request(scope);
  Object.defineProperty(pageRequest, "mode", { value: "navigate" });
  assert.match(await (await context.networkFirst(pageRequest)).text(), new RegExp(id));
});

test("an unfinished cover body falls back to the saved image after headers have arrived", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { context, scope } = createWorker();
  const source = scope + "media/book/cover.jpg";
  const url = new URL(scope + "__compact_player_offline__/cover.json");
  url.search = new URLSearchParams({ url: source, version: "3", book: "one", config: "one" });
  let canceled = false;
  context.fetch = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }));
  context.activeManifest = async () => ({ episodeId: "one", configBookId: "one", cacheVersion: 3, cacheName: "saved" });
  await (await context.caches.open("saved")).put(source, new Response("saved cover"));
  const response = context.networkFirstCover(new Request(url), url);
  await new Promise(setImmediate);
  t.mock.timers.tick(3000);
  assert.equal(await (await response).text(), "saved cover");
  assert.equal(canceled, true);
});

test("using a saved configuration or cover cancels the unused HTTP error body", async () => {
  for (const file of ["book.json", "cover.jpg"]) {
    const { context, scope } = createWorker();
    const source = scope + "media/book/" + file;
    const coverUrl = new URL(scope + "__compact_player_offline__/cover.json");
    coverUrl.search = new URLSearchParams({ url: source, version: "3", book: "one", config: "one" });
    let canceled = false;
    const body = new ReadableStream({ cancel() { canceled = true; } }, { highWaterMark: 0 });
    context.fetch = async () => new Response(body, { status: 503 });
    context.activeManifest = async () => ({ episodeId: "one", configBookId: "one", cacheVersion: 3, cacheName: "saved" });
    await (await context.caches.open("saved")).put(source, new Response("saved asset"));
    const response = file === "book.json" ? await context.networkFirst(new Request(source))
      : await context.networkFirstCover(new Request(coverUrl), coverUrl);
    assert.equal(await response.text(), "saved asset");
    assert.equal(canceled, true, file);
  }
});

test("a saved book configuration loads when network headers arrive but the body stalls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { context, scope } = createWorker();
  const url = scope + "media/book/book.json";
  context.activeManifest = async () => ({ episodeId: "book", cacheVersion: 1, cacheName: "saved" });
  await (await context.caches.open("saved")).put(url, new Response("saved config"));
  let canceled = false;
  context.fetch = async () => new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const response = context.networkFirst(new Request(url));
  await new Promise(setImmediate);
  t.mock.timers.tick(3000);
  assert.equal(await (await response).text(), "saved config");
  assert.equal(canceled, true);
});
