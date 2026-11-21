import { skipInterval } from "./preferences.js";

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

function bookKey(id, resetId, part) {
  return `book:${encodeURIComponent(id)}:${encodeURIComponent(resetId)}:${part}`;
}

function positionKey(id, resetId, language = "") {
  return bookKey(id, resetId, "progress") + ":" + encodeURIComponent(language);
}

function chapterCacheKey(bookId, language, cacheVersion) {
  return `compactPlayer:chapters:${encodeURIComponent(String(bookId))}:${encodeURIComponent(String(language))}:${encodeURIComponent(String(cacheVersion))}`;
}

function chapterDataKey(bookId, language, cacheVersion, sourceKey) {
  return `${chapterCacheKey(bookId, language, cacheVersion)}:${encodeURIComponent(String(sourceKey || ""))}`;
}

export class PlayerStorage {
  constructor(storage, baseUrl = "http://localhost/", getStorage = () => storage) {
    this.storage = storage || null;
    this.getStorage = getStorage;
    this.prefix = `compactPlayer@${encodeURIComponent(new URL(".", baseUrl).pathname)}:`;
    this.resetKey = this.prefix + "reset";
  }

  static fromBrowser(browser = globalThis) {
    const getStorage = () => browser.localStorage;
    let storage = null;
    try { storage = getStorage(); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not access local storage.", error); }
    return new PlayerStorage(storage, browser.location?.href, getStorage);
  }

  readItem(key) {
    const value = this.storage?.getItem(this.prefix + key);
    if (value != null || this.storage?.getItem(this.resetKey)) return value;
    // Older releases shared unprefixed records across all installations on the origin.
    return this.storage?.getItem(key);
  }

  readJson(key) {
    try { return objectOrEmpty(JSON.parse(this.readItem(key) || "{}")); }
    catch { return {}; }
  }

  writeJson(key, value) {
    try { this.storage.setItem(this.prefix + key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  resetId() {
    try { return this.storage?.getItem(this.resetKey) || ""; }
    catch { return ""; }
  }

  readBookPart(id, resetId, part) {
    try {
      const value = this.storage?.getItem(this.prefix + bookKey(id, resetId, part)) ?? this.readItem(`compactPlayer:${id}`);
      return objectOrEmpty(JSON.parse(value || "{}"));
    } catch { return {}; }
  }

  savedPosition(key) {
    try {
      const data = JSON.parse(this.storage?.getItem(key) || "null");
      return Number.isFinite(data?.seconds) && data.seconds >= 0 && Number.isFinite(data.updatedAt) ? data : null;
    } catch { return null; }
  }

  positionRecords(id, resetId, selectedLanguage) {
    const prefix = this.prefix + positionKey(id, resetId);
    const records = [];
    try {
      for (let index = 0; index < (this.storage?.length || 0); index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const [encodedLanguage, revision] = key.slice(prefix.length).split(":");
        let language;
        try { language = decodeURIComponent(encodedLanguage); }
        catch { continue; }
        if (selectedLanguage !== undefined && selectedLanguage !== language) continue;
        const position = this.savedPosition(key);
        if (position) records.push({ ...position, key, language, revision,
          activityAt: Number.isFinite(position.activityAt) ? position.activityAt : position.updatedAt });
      }
    } catch (error) { console.warn("[CompactAudioPlayer] Could not read saved listening positions.", error); }
    return records.sort((a, b) => a.activityAt - b.activityAt || a.updatedAt - b.updatedAt || a.key.localeCompare(b.key));
  }

  progressTimestamp(id, resetId, language, records = this.positionRecords(id, resetId, language)) {
    const timestamp = records.at(-1)?.updatedAt ?? this.readBookPart(id, resetId, "progress").progressUpdatedAt?.[language];
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  readProgress(id, resetId) {
    const raw = this.readBookPart(id, resetId, "progress");
    const progressByLang = {};
    for (const [language, value] of Object.entries(objectOrEmpty(raw.progressByLang))) {
      const progress = safeNumber(value, -1, 0, Number.MAX_SAFE_INTEGER);
      if (progress >= 0) progressByLang[language] = progress;
    }
    const progressUpdatedAt = objectOrEmpty(raw.progressUpdatedAt);
    let lastTime = safeNumber(raw.lastTime, 0, 0, Number.MAX_SAFE_INTEGER);
    for (const position of this.positionRecords(id, resetId)) {
      progressByLang[position.language] = position.seconds;
      progressUpdatedAt[position.language] = position.updatedAt;
      lastTime = position.seconds;
    }
    return { progressByLang, progressUpdatedAt, lastTime };
  }

  readBook(id) {
    const resetId = this.resetId();
    const selection = this.readBookPart(id, resetId, "selection");
    return {
      schemaVersion: SCHEMA_VERSION,
      language: String(selection.language || selection.lang || ""),
      quality: String(selection.quality || ""),
      ...this.readProgress(id, resetId),
    };
  }

  setBookSelection(id, language, quality) {
    return this.writeJson(bookKey(id, this.resetId(), "selection"), { schemaVersion: SCHEMA_VERSION, language, quality });
  }

  preserveCollidingBook(id) {
    const legacy = this.readJson(`compactPlayer:${id}`);
    if (!["progressByLang", "lastTime", "language", "lang", "quality"].some((field) => Object.hasOwn(legacy, field))) return true;
    const resetId = this.resetId();
    const copyMissing = (part, value) => {
      const key = bookKey(id, resetId, part);
      return this.storage?.getItem(this.prefix + key) != null || this.writeJson(key, { schemaVersion: SCHEMA_VERSION, ...value });
    };
    try {
      return copyMissing("progress", this.readProgress(id, resetId))
        && copyMissing("selection", { language: legacy.language || legacy.lang || "", quality: legacy.quality || "" });
    } catch { return false; }
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
      skipSeconds: skipInterval(raw.skipSeconds),
    };
  }

  writeUi(prefs) {
    return this.preserveCollidingBook("ui") && this.writeJson(STORAGE_KEYS.ui, { ...this.readUi(), ...prefs, schemaVersion: SCHEMA_VERSION });
  }
  getProgress(id, language) { const prefs = this.readProgress(id, this.resetId()); return prefs.progressByLang[language] ?? prefs.lastTime; }
  setProgress(id, language, seconds, { updatedAt = Date.now(), previousUpdate, resetId = this.resetId() } = {}) {
    if (resetId !== this.resetId()) return;
    const records = this.positionRecords(id, resetId, language);
    const storedAt = this.progressTimestamp(id, resetId, language, records);
    const lastActivity = records.at(-1)?.activityAt ?? storedAt;
    // A different tab may have saved newer activity while this write was waiting.
    if (lastActivity > updatedAt || (lastActivity === updatedAt && previousUpdate !== undefined && storedAt !== previousUpdate)) return;
    const value = safeNumber(seconds, 0, 0, Number.MAX_SAFE_INTEGER);
    const revision = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const key = positionKey(id, resetId, language) + ":" + revision;
    if (!this.writeJson(key, { schemaVersion: SCHEMA_VERSION, seconds: value, activityAt: updatedAt, updatedAt: Math.max(updatedAt, storedAt + 1) })) return;
    // Another tab can publish between our read and write. Only prune immutable revisions from our snapshot.
    try {
      for (const record of records) if (record.revision) this.storage.removeItem(record.key);
    } catch (error) { console.warn("[CompactAudioPlayer] Could not remove superseded listening positions.", error); }
  }
  getLastBook() { try { return String(this.readItem(STORAGE_KEYS.lastBook) || ""); } catch { return ""; } }
  setLastBook(id) {
    if (!this.preserveCollidingBook("lastEpisode")) return;
    try { this.storage?.setItem(this.prefix + STORAGE_KEYS.lastBook, String(id)); } catch {}
  }
  hasSeenOnboarding() { try { return this.readItem(STORAGE_KEYS.onboarding) === "1"; } catch { return false; } }
  markOnboardingSeen() { try { this.storage?.setItem(this.prefix + STORAGE_KEYS.onboarding, "1"); } catch {} }

  readChapters(bookId, language, cacheVersion, url) {
    const data = this.readChapterData(bookId, language, cacheVersion, url, url);
    return data?.kind === "vtt" ? data.text : "";
  }

  writeChapters(bookId, language, cacheVersion, url, text) {
    return this.writeChapterData(bookId, language, cacheVersion, url, { kind: "vtt", text }, url);
  }

  readChapterData(bookId, language, cacheVersion, sourceKey, vttUrl = sourceKey) {
    if (vttUrl) {
      const raw = this.readJson(chapterCacheKey(bookId, language, cacheVersion));
      if (raw.url === vttUrl && typeof raw.text === "string" && raw.text && raw.text.length <= MAX_CHAPTER_CACHE_LENGTH) {
        const data = { kind: "vtt", text: raw.text };
        if (!raw.kind) this.writeChapterData(bookId, language, cacheVersion, sourceKey, data, vttUrl);
        return data;
      }
    }
    const raw = this.readJson(chapterDataKey(bookId, language, cacheVersion, sourceKey));
    if (raw.sourceKey !== String(sourceKey || "") || !["vtt", "embedded"].includes(raw.kind)) return null;
    if (raw.kind === "vtt" && typeof raw.text === "string" && raw.text && raw.text.length <= MAX_CHAPTER_CACHE_LENGTH) {
      const data = { kind: "vtt", text: raw.text };
      if (vttUrl) this.writeChapterData(bookId, language, cacheVersion, sourceKey, data, vttUrl);
      return data;
    }
    if (raw.kind === "embedded" && Array.isArray(raw.cues) && raw.cues.length <= 10000) {
      let previousStart = 0;
      for (const cue of raw.cues) {
        if (!cue || !Number.isFinite(cue.start) || cue.start < previousStart
          || (cue.end != null && (!Number.isFinite(cue.end) || cue.end < cue.start))
          || typeof cue.title !== "string" || !cue.title.trim()) return null;
        previousStart = cue.start;
      }
      return { kind: raw.kind, cues: raw.cues };
    }
    return null;
  }

  writeChapterData(bookId, language, cacheVersion, sourceKey, data, vttUrl = sourceKey) {
    if (!data || !["vtt", "embedded"].includes(data.kind)) return false;
    const versionKey = chapterCacheKey(bookId, language, cacheVersion);
    const key = data.kind === "vtt" ? versionKey : chapterDataKey(bookId, language, cacheVersion, sourceKey);
    const value = data.kind === "vtt"
      ? { kind: data.kind, url: vttUrl, text: String(data.text || "") }
      : { kind: data.kind, sourceKey, cues: Array.isArray(data.cues) ? data.cues : [] };
    if (data.kind === "vtt" && (!value.text || value.text.length > MAX_CHAPTER_CACHE_LENGTH)) return false;
    if (data.kind === "embedded" && (value.cues.length > 10000 || JSON.stringify(value.cues).length > MAX_CHAPTER_CACHE_LENGTH)) return false;
    if (!this.writeJson(key, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), ...value })) return false;
    const prefix = this.prefix + chapterCacheKey(bookId, language, "");
    const current = this.prefix + versionKey;
    try {
      for (let i = this.storage.length - 1; i >= 0; i--) {
        const item = this.storage.key(i);
        if (!item?.startsWith(prefix) || item === current) continue;
        const oldVersion = !item.startsWith(current + ":");
        if (oldVersion || (data.kind === "vtt" && this.readJson(item.slice(this.prefix.length)).kind === "vtt")) this.storage.removeItem(item);
      }
    } catch (error) { console.warn("[CompactAudioPlayer] Could not remove old chapter data.", error); }
    return true;
  }

  readAvailabilityCache(bookId, cacheVersion, ttlMs = 7 * 86400000) {
    const key = `compactPlayer:availability:${bookId}:${cacheVersion}`;
    let raw = this.readJson(key);
    if (!raw.timestamp) raw = this.readJson(`cap_avail_${bookId}_v${cacheVersion}`);
    if (!raw.timestamp && raw.ts) raw = { timestamp: raw.ts, byLanguage: raw.existsByLang };
    if (!raw.timestamp || Date.now() - raw.timestamp > ttlMs) raw = {};
    return {
      byLanguage: objectOrEmpty(raw.byLanguage),
      playedUrls: Array.isArray(raw.playedUrls) ? raw.playedUrls.filter((url) => typeof url === "string") : [],
    };
  }

  readAvailability(bookId, cacheVersion, ttlMs) {
    return this.readAvailabilityCache(bookId, cacheVersion, ttlMs).byLanguage;
  }

  writeAvailability(bookId, cacheVersion, byLanguage, playedUrls = []) {
    return this.writeJson(`compactPlayer:availability:${bookId}:${cacheVersion}`, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), byLanguage, playedUrls });
  }

  clearAvailability(bookId, cacheVersion) {
    this.writeAvailability(bookId, cacheVersion, {});
  }

  reset() {
    try {
      this.storage ??= this.getStorage();
      if (!this.storage) return true;
      const resetId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      for (let index = this.storage.length - 1; index >= 0; index -= 1) {
        const key = this.storage.key(index);
        if (key?.startsWith(this.prefix) && key !== this.resetKey) this.storage.removeItem(key);
      }
      this.storage.setItem(this.resetKey, resetId);
      return true;
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not reset saved player data.", error);
      return false;
    }
  }
}
