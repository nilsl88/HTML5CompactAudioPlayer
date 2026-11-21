import { openAvailabilityCache, readAvailabilityCache, clearAvailability } from "./availability-cache.js";
import { openChapterCache } from "./chapter-cache.js";
import { asRecord, normalizeLanguageTag } from "./utils.js";
import { skipInterval } from "./preferences.js";

const SCHEMA_VERSION = 2;
const UI_FIELDS = ["theme", "fontSize", "uiLanguage", "playbackRate", "volume", "skipSeconds"];
export const STORAGE_KEYS = {
  ui: "compactPlayer:ui",
  // Keep the persisted key so a terminology change does not reset book selection.
  lastBook: "compactPlayer:lastEpisode",
  onboarding: "compactAudioPlayer.onboardingShown.v1",
};

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

export class PlayerStorage {
  constructor(storage, baseUrl = "http://localhost/", getStorage = () => storage) {
    this.storage = storage || null;
    this.getStorage = getStorage;
    this.prefix = `compactPlayer@${encodeURIComponent(new URL(".", baseUrl).pathname)}:`;
    this.resetKey = this.prefix + "reset";
    this.cacheRecords = {
      schemaVersion: SCHEMA_VERSION,
      resetId: () => this.resetId(),
      readJson: (key) => this.readJson(key),
      writeJson: (key, value) => this.writeJson(key, value),
      keys: () => this.ownedKeys(),
      value: (key) => this.storage.getItem(this.prefix + key),
      remove: (key) => this.storage.removeItem(this.prefix + key),
    };
  }

  static fromBrowser(browser = globalThis) {
    const getStorage = () => browser.localStorage;
    let storage = null;
    try { storage = getStorage(); }
    catch (error) { console.warn("[CompactAudioPlayer] Could not access local storage.", error); }
    return new PlayerStorage(storage, browser.location?.href, getStorage);
  }

  ownedKeys() {
    const keys = [];
    for (let index = 0; index < (this.storage?.length || 0); index++) {
      const key = this.storage.key(index);
      if (key?.startsWith(this.prefix)) keys.push(key.slice(this.prefix.length));
    }
    return keys;
  }

  readItem(key) {
    const value = this.storage?.getItem(this.prefix + key);
    if (value != null || this.storage?.getItem(this.resetKey)) return value;
    // Older releases shared unprefixed records across all installations on the origin.
    return this.storage?.getItem(key);
  }

  readJson(key) {
    try { return asRecord(JSON.parse(this.readItem(key) || "{}")); }
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
      return asRecord(JSON.parse(value || "{}"));
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
    for (const [language, value] of Object.entries(asRecord(raw.progressByLang))) {
      const progress = safeNumber(value, -1, 0, Number.MAX_SAFE_INTEGER);
      if (progress >= 0) progressByLang[language] = progress;
    }
    const progressUpdatedAt = asRecord(raw.progressUpdatedAt);
    let lastTime = safeNumber(raw.lastTime, 0, 0, Number.MAX_SAFE_INTEGER);
    for (const position of this.positionRecords(id, resetId)) {
      progressByLang[position.language] = position.seconds;
      progressUpdatedAt[position.language] = position.updatedAt;
      lastTime = position.seconds;
    }
    return { progressByLang, progressUpdatedAt, lastTime };
  }

  readBookSelection(id, resetId = this.resetId()) {
    const selection = this.readBookPart(id, resetId, "selection");
    return {
      language: String(selection.language || selection.lang || ""),
      quality: String(selection.quality || ""),
    };
  }

  readBook(id) {
    const resetId = this.resetId();
    return { schemaVersion: SCHEMA_VERSION, ...this.readBookSelection(id, resetId), ...this.readProgress(id, resetId) };
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
    for (const field of UI_FIELDS) {
      const entry = this.readJson("ui:" + field);
      if (Object.hasOwn(entry, "value")) raw[field] = entry.value;
    }
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
    return UI_FIELDS.filter((field) => Object.hasOwn(prefs, field)).every((field) => this.writeUiPreference(field, prefs[field]));
  }
  writeUiPreference(field, value) {
    return UI_FIELDS.includes(field) && this.writeJson("ui:" + field, { value });
  }
  getProgress(id, language) {
    const prefs = this.readProgress(id, this.resetId());
    return prefs.progressByLang[language] ?? prefs.progressByLang[normalizeLanguageTag(language)] ?? prefs.lastTime;
  }
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

  chapterCache(bookId, language, cacheVersion, sourceKey, vttUrl, resetId) {
    return openChapterCache(this.cacheRecords, bookId, language, cacheVersion, sourceKey, vttUrl, resetId);
  }

  readChapterData(bookId, language, cacheVersion, sourceKey, vttUrl = sourceKey, resetId) {
    return this.chapterCache(bookId, language, cacheVersion, sourceKey, vttUrl, resetId).read();
  }

  writeChapterData(bookId, language, cacheVersion, sourceKey, data, vttUrl = sourceKey, resetId) {
    return this.chapterCache(bookId, language, cacheVersion, sourceKey, vttUrl, resetId).write(data);
  }

  availabilityCache(bookId, cacheVersion, ttlMs) {
    return openAvailabilityCache(this.cacheRecords, bookId, cacheVersion, ttlMs);
  }

  readAvailabilityCache(bookId, cacheVersion, ttlMs) {
    return readAvailabilityCache(this.cacheRecords, bookId, cacheVersion, ttlMs);
  }

  readAvailability(bookId, cacheVersion, ttlMs) {
    return this.readAvailabilityCache(bookId, cacheVersion, ttlMs).byLanguage;
  }

  writeAvailability(bookId, cacheVersion, byLanguage, playedUrls = []) {
    const cache = this.availabilityCache(bookId, cacheVersion);
    for (const url of playedUrls) cache.recordPlayback(url);
    for (const [language, sources] of Object.entries(byLanguage)) {
      for (const [id, value] of Object.entries(sources)) if (!cache.recordProbe(language, id, value)) return false;
    }
    return true;
  }

  clearAvailability(bookId, cacheVersion) {
    return clearAvailability(this.cacheRecords, bookId, cacheVersion);
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
