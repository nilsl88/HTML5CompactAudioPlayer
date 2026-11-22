const MAX_CHAPTER_CACHE_LENGTH = 512 * 1024;
const textEncoder = new TextEncoder();

function withinCacheLimit(text) {
  return text.length <= MAX_CHAPTER_CACHE_LENGTH && textEncoder.encode(text).byteLength <= MAX_CHAPTER_CACHE_LENGTH;
}

function chapterCacheKey(bookId, language, cacheVersion) {
  return `compactPlayer:chapters:${encodeURIComponent(String(bookId))}:${encodeURIComponent(String(language))}:${encodeURIComponent(String(cacheVersion))}`;
}

export function openChapterCache(records, bookId, language, cacheVersion, sourceKey, vttUrl, resetId = records.resetId()) {
  const scope = resetId ? `chapter-reset:${resetId}:` : "";
  const versionKey = chapterCacheKey(bookId, language, cacheVersion);
  let cleanup;
  const beginWrite = () => { cleanup ??= chapterCleanup(); };

  function readChapter(vttUrl = sourceKey) {
    if (resetId !== records.resetId()) return null;
    const migrateVtt = (data) => {
      const cleanup = chapterCleanup(true);
      if (saveChapterEntry(vttUrl, data)) cleanup("vtt");
    };
    const read = (key) => {
      if (!resetId) return records.readJson(key);
      const scoped = records.readJson(`chapter-reset:${resetId}:${key}`);
      if (Object.keys(scoped).length) return scoped;
      const legacy = records.readJson(key);
      return Object.hasOwn(legacy, "resetId") ? {} : legacy;
    };
    if (vttUrl) {
      const raw = read(versionKey);
      if (raw.url === vttUrl && typeof raw.text === "string" && raw.text && withinCacheLimit(raw.text)) {
        const data = { kind: "vtt", text: raw.text };
        if (!raw.kind) migrateVtt(data);
        return data;
      }
    }
    const raw = read(versionKey + ":" + encodeURIComponent(String(sourceKey || "")));
    if (raw.sourceKey !== String(sourceKey || "") || !["vtt", "embedded"].includes(raw.kind)) return null;
    if (raw.kind === "vtt" && typeof raw.text === "string" && raw.text && withinCacheLimit(raw.text)) {
      const data = { kind: "vtt", text: raw.text };
      if (vttUrl) migrateVtt(data);
      return data;
    }
    if (raw.kind === "embedded" && Array.isArray(raw.cues) && raw.cues.length <= 10000
      && withinCacheLimit(JSON.stringify(raw.cues))) {
      let previousStart = 0;
      for (const cue of raw.cues) {
        if (!cue || !Number.isFinite(cue.start) || cue.start < previousStart
          || (cue.end != null && (!Number.isFinite(cue.end) || cue.end < cue.start))
          || typeof cue.title !== "string" || !cue.title.trim()) return null;
        // Older players decoded a big-endian BOM as U+FFFE and saved the garbled title.
        if (cue.title.startsWith("\uFFFE")) return null;
        previousStart = cue.start;
      }
      return { kind: raw.kind, cues: raw.cues };
    }
    return null;
  }

  function saveChapterEntry(vttUrl, data) {
    if (!data || !["vtt", "embedded"].includes(data.kind)) return false;
    const key = data.kind === "vtt" ? versionKey : versionKey + ":" + encodeURIComponent(String(sourceKey || ""));
    const value = data.kind === "vtt"
      ? { kind: data.kind, url: vttUrl, text: String(data.text || "") }
      : { kind: data.kind, sourceKey, cues: Array.isArray(data.cues) ? data.cues : [] };
    if (data.kind === "vtt" && (!value.text || !withinCacheLimit(value.text))) return false;
    if (data.kind === "embedded" && (value.cues.length > 10000 || !withinCacheLimit(JSON.stringify(value.cues)))) return false;
    return records.writeJson(scope + key, { schemaVersion: records.schemaVersion, timestamp: Date.now(), resetId, ...value });
  }

  function chapterCleanup(copiesOnly = false) {
    const family = chapterCacheKey(bookId, language, "");
    const obsolete = [];
    try {
      for (const item of records.keys()) {
        const legacy = resetId && item.startsWith(family);
        if (!legacy && !item.startsWith(scope + family)) continue;
        const relative = legacy ? item : item.slice(scope.length);
        if (relative === versionKey && !legacy) continue;
        const sameVersion = relative === versionKey || relative.startsWith(versionKey + ":");
        if (copiesOnly && !sameVersion) continue;
        if (sameVersion && relative !== versionKey && records.readJson(item).kind !== "vtt") continue;
        obsolete.push({ item, value: records.value(item), sameVersion });
      }
    } catch (error) { console.warn("[CompactAudioPlayer] Could not list old chapter data.", error); }
    return (kind) => {
      try {
        for (const { item, value, sameVersion } of obsolete) {
          if ((!sameVersion || kind === "vtt") && records.value(item) === value) records.remove(item);
        }
      } catch (error) { console.warn("[CompactAudioPlayer] Could not remove old chapter data.", error); }
    };
  }

  return {
    read: () => readChapter(vttUrl),
    readSource: () => readChapter(""),
    beginWrite,
    write: (data) => {
      if (resetId !== records.resetId()) return false;
      beginWrite();
      if (!saveChapterEntry(vttUrl, data)) return false;
      cleanup(data.kind);
      return true;
    },
  };
}
