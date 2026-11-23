import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { isPlayerServiceWorker } from "../js/utils.js?v=19";

const page = (version) => `<link rel="stylesheet" href="./player.css?v=${version}"><script type="module" src="./player.js?v=${version}"></script>`;

function createWorker({ pageVersion = 19 } = {}) {
  const scope = "https://example.test/player/";
  const handlers = new Map();
  const stores = new Map();
  const requests = [];
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const items = stores.get(name);
      return {
        async addAll(entries) {
          for (const entry of entries) {
            requests.push(entry);
            const url = new URL(entry.url);
            const body = url.pathname.endsWith("/") || url.pathname.endsWith("index.html")
              ? pageVersion === "commented" ? `<!-- ${page(19)} -->${page(18)}` : page(pageVersion)
              : `asset ${url.search}`;
            items.set(entry.url, new Response(body));
          }
        },
        async match(entry) { return items.get(typeof entry === "string" ? entry : entry.url)?.clone(); },
        async keys() { return [...items.keys()].map((key) => new Request(key)); },
        async put(entry, response) { items.set(typeof entry === "string" ? entry : entry.url, response.clone()); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const workerUrl = new URL("../sw.js", import.meta.url);
  const self = {
    registration: { scope },
    addEventListener(type, handler) { handlers.set(type, handler); },
    async skipWaiting() {},
    clients: { async claim() {} },
  };
  const context = vm.createContext({ self, URL, Request, Response, AbortSignal, AbortController,
    setTimeout, clearTimeout, caches: cacheStorage });
  context.importScripts = (...paths) => {
    for (const path of paths) vm.runInContext(readFileSync(new URL(path, workerUrl), "utf8"), context);
  };
  vm.runInContext(readFileSync(workerUrl, "utf8"), context);
  return { scope, handlers, requests, stores, context };
}

async function dispatch(handlers, type) {
  let completion;
  handlers.get(type)({ waitUntil(promise) { completion = promise; } });
  await completion;
}

test("both old and versioned player workers are recognized only in their own installation", () => {
  const base = "https://example.test/player/";
  for (const scriptURL of [base + "sw.js", base + "sw.js?v=19"]) {
    assert.equal(isPlayerServiceWorker({ scriptURL }, base), true);
  }
  for (const scriptURL of ["https://other.test/player/sw.js?v=19", "https://example.test/other/sw.js?v=19", "invalid"]) {
    assert.equal(isPlayerServiceWorker({ scriptURL }, base), false);
  }
  assert.equal(isPlayerServiceWorker(null, base), false);
});

test("install caches the versioned page and refuses to substitute another module version", async () => {
  const { scope, handlers, requests, context } = createWorker();
  await dispatch(handlers, "install");
  assert.ok(requests.some((request) => request.url === `${scope}index.html?v=19`));
  assert.ok(requests.some((request) => request.url === `${scope}?v=19`));
  assert.ok(requests.every((request) => new URL(request.url).search === "?v=19"));

  const navigation = new Request(`${scope}?book=book-a`);
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  assert.equal(await (await context.cachedShell(navigation)).text(), page(19));
  assert.equal(await (await context.cachedShell(new Request(`${scope}js/config.js?v=19`))).text(), "asset ?v=19");
  assert.equal(await context.cachedShell(new Request(`${scope}js/config.js?v=18`)), undefined);
  assert.equal(await context.cachedShell(new Request(`${scope}js/config.js`)), undefined);
});

test("worker installation rejects outdated or commented-out shell entries", async () => {
  for (const pageVersion of [18, "commented"]) {
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
  context.fetch = async () => new Response(page(18));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(19));
  context.fetch = async () => new Response(page(20));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(20));
  context.fetch = async () => new Response(page(20).replace("player.css?v=20", "player.css?v=19"));
  assert.equal(await (await context.networkFirst(navigation)).text(), page(19));
});

test("worker activation retains downloaded books", async () => {
  const { handlers, stores, context } = createWorker();
  await dispatch(handlers, "install");
  const prefix = vm.runInContext("SHELL_CACHE_PREFIX", context);
  stores.set(`${prefix}v18`, new Map());
  stores.set("saved-offline-audiobook", new Map([["audio", "saved"]]));
  await dispatch(handlers, "activate");
  assert.equal(stores.has(`${prefix}v18`), false);
  assert.equal(stores.get("saved-offline-audiobook").get("audio"), "saved");
});
