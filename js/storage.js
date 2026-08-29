const SCHEMA_VERSION = 2;
export const STORAGE_KEYS = {
  ui: "compactPlayer:ui",
  lastEpisode: "compactPlayer:lastEpisode",
  onboarding: "compactAudioPlayer.onboardingShown.v1",
};

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
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

  readEpisode(id) {
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

  writeEpisode(id, prefs) {
    return this.writeJson(`compactPlayer:${id}`, { ...this.readEpisode(id), ...prefs, schemaVersion: SCHEMA_VERSION });
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
  getProgress(id, language) { const prefs = this.readEpisode(id); return prefs.progressByLang[language] ?? prefs.lastTime ?? 0; }
  setProgress(id, language, seconds) {
    const prefs = this.readEpisode(id);
    const value = safeNumber(seconds, 0, 0, Number.MAX_SAFE_INTEGER);
    prefs.progressByLang[language] = value;
    prefs.lastTime = value;
    this.writeEpisode(id, prefs);
  }
  getLastEpisode() { try { return String(this.storage?.getItem(STORAGE_KEYS.lastEpisode) || ""); } catch { return ""; } }
  setLastEpisode(id) { try { this.storage?.setItem(STORAGE_KEYS.lastEpisode, String(id)); } catch {} }
  hasSeenOnboarding() { try { return this.storage?.getItem(STORAGE_KEYS.onboarding) === "1"; } catch { return false; } }
  markOnboardingSeen() { try { this.storage?.setItem(STORAGE_KEYS.onboarding, "1"); } catch {} }

  readAvailability(episodeId, cacheVersion, ttlMs = 7 * 86400000) {
    const key = `compactPlayer:availability:${episodeId}:${cacheVersion}`;
    let raw = this.readJson(key);
    if (!raw.timestamp) raw = this.readJson(`cap_avail_${episodeId}_v${cacheVersion}`);
    if (!raw.timestamp && raw.ts) raw = { timestamp: raw.ts, byLanguage: raw.existsByLang };
    if (!raw.timestamp || Date.now() - raw.timestamp > ttlMs) return {};
    return objectOrEmpty(raw.byLanguage);
  }

  writeAvailability(episodeId, cacheVersion, byLanguage) {
    return this.writeJson(`compactPlayer:availability:${episodeId}:${cacheVersion}`, { schemaVersion: SCHEMA_VERSION, timestamp: Date.now(), byLanguage });
  }

  clearAvailability(episodeId, cacheVersion) {
    try {
      this.storage?.removeItem(`compactPlayer:availability:${episodeId}:${cacheVersion}`);
      this.storage?.removeItem(`cap_avail_${episodeId}_v${cacheVersion}`);
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
