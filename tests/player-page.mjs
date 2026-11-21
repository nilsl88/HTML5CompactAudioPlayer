import { setImmediate as settle } from "node:timers/promises";

let pageNumber = 0;

class Element extends EventTarget {
  children = [];
  dataset = {};
  classList = { add() {}, remove() {}, toggle() {} };
  hidden = true;
  setAttribute() {}
  removeAttribute(name) { delete this[name]; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  replaceChildren() { this.children = []; }
  remove() {}
  closest() { return null; }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
}

export async function openPlayerPage(t, book, fetchAsset, saved = new Map(), browserGlobals = {}) {
  const elements = new Map();
  const document = Object.assign(new Element(), {
    body: new Element(), documentElement: new Element(),
    createElement: () => new Element(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
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
  const globals = {
    document, window, navigator, location: new URL("https://example.test/"),
    requestAnimationFrame: (callback) => callback(),
    get localStorage() {
      if (saved === null) throw new DOMException("Local storage is blocked.", "SecurityError");
      return storage;
    },
    fetch: async (url, options) => {
      if (url.endsWith("/library.json")) return Response.json({ books: [{ id: book.id }], ui: { onboardingEnabled: false } });
      if (url.endsWith("/book.json")) return Response.json(book);
      return fetchAsset(url, options);
    },
  };
  Object.defineProperties(globals, Object.getOwnPropertyDescriptors(browserGlobals));
  for (const name of Object.keys(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, Object.getOwnPropertyDescriptor(globals, name));
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  await import(`../player.js?page=${++pageNumber}`);
  await settle();
  return { audio, document, elements, navigator: globals.navigator, window: globals.window };
}
