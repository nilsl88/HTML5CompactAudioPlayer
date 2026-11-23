import { setImmediate as settle } from "node:timers/promises";
import { startPlayer } from "../js/player-app.js?v=20";
import { PlayerStorage } from "../js/storage.js?v=20";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class Element extends EventTarget {
  children = [];
  dataset = {};
  classList = { add() {}, remove() {}, toggle() {} };
  hidden = true;
  attributes = new Map();
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); delete this[name]; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren() { this.children = []; }
  remove() {}
  closest() { return null; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
}

export async function openPlayerPage(book, fetchAsset, saved = new Map(), browserGlobals = {}) {
  const elements = new Map();
  const document = Object.assign(new Element(), {
    body: new Element(), documentElement: new Element(),
    createElement: () => Object.assign(new Element(), { ownerDocument: document }),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, this.createElement());
      return elements.get(id);
    },
  });
  const audio = document.getElementById("audio");
  document.getElementById("chaptersTrack").track = { mode: "disabled" };
  Object.assign(audio, { canPlayType: () => "probably", load() {}, pause() {}, async play() {} });
  const window = new EventTarget();
  const navigator = { onLine: true, language: "en" };
  const storage = {
    get length() { return saved.size; },
    key: (index) => [...saved.keys()][index] ?? null,
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: (key) => saved.delete(key),
  };
  document.defaultView = window;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      if (saved === null) throw new DOMException("Local storage is blocked.", "SecurityError");
      return storage;
    },
  });
  Object.assign(window, {
    document, navigator, location: new URL("https://example.test/"),
    requestAnimationFrame: (callback) => callback(),
    fetch: async (url, options) => {
      if (url.endsWith("/library.json")) return Response.json({ books: [{ id: book.id }], ui: { onboardingEnabled: false } });
      if (url.endsWith("/book.json")) return Response.json(book);
      return fetchAsset(url, options);
    },
  });
  Object.defineProperties(window, Object.getOwnPropertyDescriptors(browserGlobals));
  const playerStorage = PlayerStorage.fromBrowser(window);
  const ready = startPlayer({ window, storage: playerStorage, fetchImpl: window.fetch });
  await settle();
  return { audio, document, elements, navigator: window.navigator, window, storage: playerStorage, ready };
}
