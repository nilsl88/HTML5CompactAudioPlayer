const SCHEMA_VERSION = 2;
const MAX_CHAPTER_CACHE_LENGTH = 512 * 1024;
export const STORAGE_KEYS = {
  ui: "compactPlayer:ui",
  // Keep the persisted key so a terminology change does not reset book selection.
  lastBook: "compactPlayer:lastEpisode",
  onboarding: "compactAudioPlayer.onboardingShown.v1",
};

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function chapterCacheKey(bookId, language, cacheVersion) {
  return `compactPlayer:chapters:${encodeURIComponent(String(bookId))}:${encodeURIComponent(String(language))}:${encodeURIComponent(String(cacheVersion))}`;
}

function chapterDataKey(bookId, language, cacheVersion, sourceKey) {
  return `${chapterCacheKey(bookId, language, cacheVersion)}:${encodeURIComponent(String(sourceKey || ""))}`;
}

export class PlayerStorage {
  constructor(storage) { this.storage = storage || null; }

  readJson(key) {
    try { return objectOrEmpty(JSON.parse(this.storage?.getItem(key) || "{}")); }
    catch { return {}; }
  }

  writeJson(key, value) {
    try { this.storage?.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  readBook(id) {
    const raw = this.readJson(`compactPlayer:${id}`);
    const progressByLang = {};
    for (const [language, value] of Object.entries(objectOrEmpty(raw.progressByLang))) {
      const progress = safeNumber(value, -1, 0, Number.MAX_SAFE_INTEGER);
      if (progress >= 0) progressByLang[language] = progress;
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      language: String(raw.language || raw.lang || ""),
      quality: String(raw.quality || ""),
      progressByLang,
      lastTime: safeNumber(raw.lastTime, 0, 0, Number.MAX_SAFE_INTEGER),
    };
  }

  writeBook(id, prefs) {
    return this.writeJson(`compactPlayer:${id}`, { ...this.readBook(id), ...prefs, schemaVersion: SCHEMA_VERSION });
  }

  readUi() {
    const raw = this.readJson(STORAGE_KEYS.ui);
    return {
      schemaVersion: SCHEMA_VERSION,
      theme: ["system", "light", "dark"].includes(raw.theme) ? raw.theme : "system",
      fontSize: ["s", "m", "l"].includes(raw.fontSize) ? raw.fontSize : "m",
      uiLanguage: String(raw.uiLanguage || raw.uiLang || "en"),
      playbackRate: safeNumber(raw.playbackRate, 1, .5, 2),
      volume: safeNumber(raw.volume, 1, 0, 1),
      skipSeconds: [5, 10, 15, 30, 60].includes(Number(raw.skipSeconds)) ? Number(raw.skipSeconds) : 15,
    };
  }

  writeUi(prefs) { return this.writeJson(STORAGE_KEYS.ui, { ...this.readUi(), ...prefs, schemaVersion: SCHEMA_VERSION }); }
  getProgress(id, language) { const prefs = this.readBook(id); return prefs.progressByLang[language] ?? prefs.lastTime ?? 0; }
  setProgress(id, language, seconds) {
    const prefs = this.readBook(id);
    const value = safeNumber(seconds, 0, 0, Number.MAX_SAFE_INTEGER);
    prefs.progressByLang[language] = value;
    prefs.lastTime = value;
    this.writeBook(id, prefs);
  }
  getLastBook() { try { return String(this.storage?.getItem(STORAGE_KEYS.lastBook) || ""); } catch { return ""; } }
  setLastBook(id) { try { this.storage?.setItem(STORAGE_KEYS.lastBook, String(id)); } catch {} }
  hasSeenOnboarding() { try { return this.storage?.getItem(STORAGE_KEYS.onboarding) === "1"; } catch { return false; } }
  markOnboardingSeen() { try { this.storage?.setItem(STORAGE_KEYS.onboarding, "1"); } catch {} }

  readChapters(bookId, language, cacheVersion, url) {
    const raw = this.readJson(chapterCacheKey(bookId, language, cacheVersion));
    const text = typeof raw.text === "string" ? raw.text : "";
    if (raw.url !== String(url || "") || !text || text.length > MAX_CHAPTER_CACHE_LENGTH) return "";
    return text;
  }

  writeChapters(bookId, language, cacheVersion, url, text) {
    const value = String(text || "");
    if (!value || value.length > MAX_CHAPTER_CACHE_LENGTH) return false;
    const key = chapterCacheKey(bookId, language, cacheVersion);
    const prefix = `compactPlayer:chapters:${encodeURIComponent(String(bookId))}:${encodeURIComponent(String(language))}:`;
    try {
      for (let index = this.storage.length - 1; index >= 0; index -= 1) {
        const storedKey = this.storage.key(index);
        const suffix = storedKey?.startsWith(prefix) ? storedKey.slice(prefix.length) : "";
        if (suffix && !suffix.includes(":") && storedKey !== key) this.storage.removeItem(storedKey);
      }
    } catch {}
    return this.writeJson(key, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), url: String(url || ""), text: value });
  }

  readChapterData(bookId, language, cacheVersion, sourceKey) {
    const raw = this.readJson(chapterDataKey(bookId, language, cacheVersion, sourceKey));
    if (raw.sourceKey !== String(sourceKey || "") || !["vtt", "embedded"].includes(raw.kind)) return null;
    if (raw.kind === "vtt" && typeof raw.text === "string" && raw.text && raw.text.length <= MAX_CHAPTER_CACHE_LENGTH) return { kind: raw.kind, text: raw.text };
    if (raw.kind === "embedded" && Array.isArray(raw.cues) && raw.cues.length <= 10000) {
      const cues = raw.cues.filter((cue) => cue && Number.isFinite(cue.start) && cue.start >= 0 && (cue.end == null || (Number.isFinite(cue.end) && cue.end >= cue.start)) && typeof cue.title === "string" && cue.title.trim());
      if (cues.length === raw.cues.length) return { kind: raw.kind, cues };
    }
    return null;
  }

  writeChapterData(bookId, language, cacheVersion, sourceKey, data) {
    const key = chapterDataKey(bookId, language, cacheVersion, sourceKey);
    if (!data || !["vtt", "embedded"].includes(data.kind)) return false;
    const value = data.kind === "vtt"
      ? { kind: data.kind, text: String(data.text || "") }
      : { kind: data.kind, cues: Array.isArray(data.cues) ? data.cues : [] };
    if (data.kind === "vtt" && (!value.text || value.text.length > MAX_CHAPTER_CACHE_LENGTH)) return false;
    if (data.kind === "embedded" && (value.cues.length > 10000 || JSON.stringify(value.cues).length > MAX_CHAPTER_CACHE_LENGTH)) return false;
    return this.writeJson(key, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), sourceKey: String(sourceKey || ""), ...value });
  }

  readAvailability(bookId, cacheVersion, ttlMs = 7 * 86400000) {
    const key = `compactPlayer:availability:${bookId}:${cacheVersion}`;
    let raw = this.readJson(key);
    if (!raw.timestamp) raw = this.readJson(`cap_avail_${bookId}_v${cacheVersion}`);
    if (!raw.timestamp && raw.ts) raw = { timestamp: raw.ts, byLanguage: raw.existsByLang };
    if (!raw.timestamp || Date.now() - raw.timestamp > ttlMs) return {};
    return objectOrEmpty(raw.byLanguage);
  }

  writeAvailability(bookId, cacheVersion, byLanguage) {
    return this.writeJson(`compactPlayer:availability:${bookId}:${cacheVersion}`, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), byLanguage });
  }

  clearAvailability(bookId, cacheVersion) {
    try {
      this.storage?.removeItem(`compactPlayer:availability:${bookId}:${cacheVersion}`);
      this.storage?.removeItem(`cap_avail_${bookId}_v${cacheVersion}`);
    } catch {}
  }

  reset() {
    try {
      for (let index = this.storage.length - 1; index >= 0; index -= 1) {
        const key = this.storage.key(index);
        if (key && ["compactPlayer:", "compactAudioPlayer.", "cap_avail_"].some((prefix) => key.startsWith(prefix))) this.storage.removeItem(key);
      }
    } catch {}
  }
}
