import { createAbortError, normalizeLanguageTag, safeUrl } from "./utils.js?v=22";
import { CODECS } from "./codecs.js?v=22";

export { CODECS };

const BOOK_CONFIG_MAX_BYTES = 1024 ** 2;

class BookConfigTooLargeError extends Error {
  constructor() {
    super("Book configuration exceeds 1 MiB.");
    this.name = "BookConfigTooLargeError";
    this.code = "config";
  }
}

export async function readBoundedText(response, signal, maxBytes, tooLarge) {
  const body = response.body;
  if (signal?.aborted) {
    void body?.cancel().catch(() => { /* The fetch may already have canceled the stream. */ });
    throw createAbortError();
  }
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let ended = false;
  const cancel = () => {
    if (ended) return;
    ended = true;
    void reader.cancel().catch(() => { /* A failed stream can reject cancellation. */ });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw createAbortError();
      if (done) {
        ended = true;
        return text + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

export function readBookConfigText(response, signal) {
  return readBoundedText(response, signal, BOOK_CONFIG_MAX_BYTES, () => new BookConfigTooLargeError());
}

function audioLanguageTag(value) {
  const tag = String(value || "").trim().replace(/_/g, "-");
  if (!tag) return "";
  try { return Intl.getCanonicalLocales(tag)[0]; }
  catch { return tag.toLowerCase(); }
}

export function matchAudioLanguage(preferences, codes, defaultLanguage) {
  for (const preference of preferences) {
    const tag = audioLanguageTag(preference);
    if (!tag) continue;
    if (codes.includes(tag)) return tag;
    let parent = tag;
    while (parent.includes("-")) {
      parent = parent.slice(0, parent.lastIndexOf("-"));
      if (codes.includes(parent)) return parent;
    }
    const base = normalizeLanguageTag(tag);
    if (codes.includes(base)) return base;
    if (codes.includes(defaultLanguage) && normalizeLanguageTag(defaultLanguage) === base) return defaultLanguage;
    const related = codes.find((code) => normalizeLanguageTag(code) === base);
    if (related) return related;
  }
  return "";
}

export function normalizeLibrary(raw) {
  const library = { defaultId: "", books: [], byId: new Map(), ui: { onboardingEnabled: true } };
  if (!raw || typeof raw !== "object") return library;
  library.ui.onboardingEnabled = raw.ui?.onboardingEnabled !== false;
  const items = Object.hasOwn(raw, "books") ? (Array.isArray(raw.books) ? raw.books : [])
    : Array.isArray(raw.audiofiles) ? raw.audiofiles
      : Array.isArray(raw.episodes) ? raw.episodes
        : Array.isArray(raw.items) ? raw.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || item.episode || item.key || "").trim();
    const folder = String(item.folder ?? item.path ?? id);
    if (!id || !folder.trim() || /(?:^|\/)\.\.(?:\/|$)/.test(folder)) continue;
    const record = {
      id,
      folder,
      title: item.title && typeof item.title === "object" ? { ...item.title } : null,
      label: String(item.label || ""),
    };
    library.books.push(record);
    library.byId.set(id, record);
  }
  const requestedDefault = String(raw.default || raw.defaultId || "").trim();
  library.defaultId = library.byId.has(requestedDefault) ? requestedDefault : (library.books[0]?.id || "");
  return library;
}

export function parseJson(text, fileName) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON in ${fileName}: ${error.message}`); }
}

export function parseBookConfig(text, configUrl, documentBaseUrl) {
  const raw = parseJson(text, configUrl);
  return normalizeBook(raw, { bookBaseUrl: new URL(".", configUrl).href, documentBaseUrl });
}

export function normalizeBook(raw, { bookBaseUrl, documentBaseUrl }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Book configuration must be an object.");
  const id = String(raw.id || "").trim();
  const defaultLanguage = audioLanguageTag(raw.defaultLanguage);
  if (!id) throw new Error("Book configuration is missing id.");
  if (!defaultLanguage) throw new Error("Book configuration is missing defaultLanguage.");
  if (!raw.languages || typeof raw.languages !== "object" || Array.isArray(raw.languages)) throw new Error("Book configuration is missing languages.");

  const languages = Object.create(null);
  for (const [rawCode, value] of Object.entries(raw.languages)) {
    if (!value || typeof value !== "object") continue;
    const code = audioLanguageTag(rawCode);
    if (!code) continue;
    const baseUrl = value.basePath
      ? safeUrl(value.basePath, documentBaseUrl)
      : bookBaseUrl;
    if (!baseUrl) continue;
    const directory = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const sources = {};
    for (const codec of CODECS) {
      const configured = value.sources?.[codec];
      if (!configured || typeof configured !== "object") continue;
      const byBitrate = {};
      for (const [bitrate, path] of Object.entries(configured)) {
        const parsedBitrate = Number.parseInt(bitrate, 10);
        if (!Number.isFinite(parsedBitrate) || parsedBitrate <= 0 || !safeUrl(path, directory)) continue;
        byBitrate[String(parsedBitrate)] = String(path).trim();
      }
      if (Object.keys(byBitrate).length) sources[codec] = byBitrate;
    }
    if (!Object.keys(sources).length) continue;
    languages[code] = {
      code,
      label: String(value.label || rawCode),
      baseUrl: directory,
      chapters: String(value.chapters || ""),
      chapterSource: ["vtt", "embedded", "auto", "none"].includes(value.chapterSource)
        ? value.chapterSource
        : (String(value.chapters || "").trim() ? "vtt" : "none"),
      sources,
    };
  }
  if (!Object.keys(languages).length) throw new Error("Book configuration has no usable languages or audio sources.");

  return {
    id,
    defaultLanguage: matchAudioLanguage([defaultLanguage], Object.keys(languages)) || Object.keys(languages)[0],
    title: raw.title && typeof raw.title === "object" ? { ...raw.title } : {},
    cover: String(raw.cover || ""),
    coverSource: ["file", "embedded", "auto", "none"].includes(raw.coverSource)
      ? raw.coverSource
      : (String(raw.cover || "").trim() ? "file" : "none"),
    duration: Number.isFinite(raw.duration) && raw.duration > 0 ? raw.duration : 0,
    cacheVersion: raw.cacheVersion == null ? 1 : String(raw.cacheVersion),
    debug: { showAllQualities: Boolean(raw.debug?.showAllQualities) },
    languages,
    bookBaseUrl,
    documentBaseUrl,
  };
}

export function resolveLanguageAsset(language, value) {
  return safeUrl(value, language?.baseUrl || "");
}

export function resolveCover(book) {
  return safeUrl(book?.cover, book?.bookBaseUrl, { allowImageData: true });
}

export function localizedValue(values, locale, fallback = "") {
  if (!values || typeof values !== "object") return fallback;
  const tag = audioLanguageTag(locale);
  const key = Object.hasOwn(values, locale) ? locale : Object.keys(values).find((key) => audioLanguageTag(key) === tag);
  return String((key && values[key]) || values[normalizeLanguageTag(locale)] || values.en || Object.values(values)[0] || fallback);
}
