import { normalizeLanguageTag, safeUrl } from "./utils.js";

export const CODECS = ["opus", "aac", "mp3"];

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

export function normalizeBook(raw, { bookBaseUrl, documentBaseUrl }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Book configuration must be an object.");
  const id = String(raw.id || "").trim();
  const defaultLanguage = normalizeLanguageTag(raw.defaultLanguage);
  if (!id) throw new Error("Book configuration is missing id.");
  if (!defaultLanguage) throw new Error("Book configuration is missing defaultLanguage.");
  if (!raw.languages || typeof raw.languages !== "object" || Array.isArray(raw.languages)) throw new Error("Book configuration is missing languages.");

  const languages = {};
  for (const [rawCode, value] of Object.entries(raw.languages)) {
    if (!value || typeof value !== "object") continue;
    const code = normalizeLanguageTag(rawCode);
    if (!code) continue;
    const sources = {};
    for (const codec of CODECS) {
      const configured = value.sources?.[codec];
      if (!configured || typeof configured !== "object") continue;
      const byBitrate = {};
      for (const [bitrate, path] of Object.entries(configured)) {
        const parsedBitrate = Number.parseInt(bitrate, 10);
        if (!Number.isFinite(parsedBitrate) || parsedBitrate <= 0 || !String(path || "").trim()) continue;
        byBitrate[String(parsedBitrate)] = String(path).trim();
      }
      if (Object.keys(byBitrate).length) sources[codec] = byBitrate;
    }
    if (!Object.keys(sources).length) continue;
    const baseUrl = value.basePath
      ? safeUrl(value.basePath, documentBaseUrl)
      : bookBaseUrl;
    if (!baseUrl) continue;
    languages[code] = {
      code,
      label: String(value.label || rawCode),
      baseUrl: baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
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
    defaultLanguage: languages[defaultLanguage] ? defaultLanguage : Object.keys(languages)[0],
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
  const normalized = normalizeLanguageTag(locale);
  return String(values[locale] || values[normalized] || values.en || Object.values(values)[0] || fallback);
}
