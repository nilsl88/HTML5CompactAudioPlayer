import { asRecord } from "./utils.js?v=20";

const AVAILABILITY_TTL = 7 * 86400000;

export function openAvailabilityCache(records, bookId, cacheVersion, ttlMs = AVAILABILITY_TTL) {
  const key = `compactPlayer:availability:${bookId}:${cacheVersion}`;
  let raw = records.readJson(key);
  if (!raw.timestamp) raw = records.readJson(`cap_avail_${bookId}_v${cacheVersion}`);
  if (!raw.timestamp && raw.ts) raw = { timestamp: raw.ts, byLanguage: raw.existsByLang };
  const scope = `availability:${encodeURIComponent(bookId)}:${encodeURIComponent(cacheVersion)}:${records.resetId()}:${raw.clearId || ""}`;
  const probes = records.readJson(scope + ":probes");
  const fresh = (entry) => {
    const timestamp = Number(entry.timestamp);
    return timestamp > 0 && Number.isFinite(timestamp) && Date.now() - timestamp <= ttlMs;
  };
  if (!fresh(raw)) raw = {};
  const legacyPlayed = new Set(Array.isArray(raw.playedUrls) ? raw.playedUrls.filter((url) => typeof url === "string") : []);
  const byLanguage = asRecord(fresh(probes) ? probes.byLanguage : raw.byLanguage);
  const probeKey = (language, id, url) => scope + ":probe:" + encodeURIComponent(language) + ":" + encodeURIComponent(id)
    + (url ? ":" + encodeURIComponent(url) : "");
  const playedKey = (url) => scope + ":played:" + url;
  return {
    scope, legacyPlayed, byLanguage, fresh,
    readProbe: (language, id, url) => {
      const exact = records.readJson(probeKey(language, id, url));
      const record = exact.timestamp != null ? exact : records.readJson(probeKey(language, id));
      if (!url || record.url !== url || !fresh(record)) return "unknown";
      if (record.value === true || record.value === "available") return "available";
      if (record.value === false || record.value === "missing") return "missing";
      return "unknown";
    },
    hasPlayed: (url) => legacyPlayed.has(url) || fresh(records.readJson(playedKey(url))),
    recordPlayback: (url, language, id) => records.writeJson(playedKey(url), { timestamp: Date.now(), language, id }),
    recordProbe: (language, id, value, url) => records.writeJson(probeKey(language, id, url), { timestamp: Date.now(), language, id, value, url }),
  };
}

export function readAvailabilityCache(records, bookId, cacheVersion, ttlMs) {
  const cache = openAvailabilityCache(records, bookId, cacheVersion, ttlMs);
  const prefix = cache.scope + ":";
  const playedPrefix = prefix + "played:";
  const played = new Set(cache.legacyPlayed);
  const observations = [];
  const groups = new Map(Object.entries(cache.byLanguage).map(([language, sources]) =>
    [language, new Map(Object.entries(asRecord(sources)))]));
  const group = (language) => {
    if (!groups.has(language)) groups.set(language, new Map());
    return groups.get(language);
  };
  try {
    for (const key of records.keys()) {
      if (!key?.startsWith(prefix)) continue;
      const record = records.readJson(key);
      const { language, id } = record;
      const identifiable = typeof language === "string" && typeof id === "string";
      if (key.startsWith(playedPrefix) && cache.fresh(record)) {
        const url = key.slice(playedPrefix.length);
        played.add(url);
        if (identifiable) observations.push({ ...record, url, value: "available" });
      } else if (key.startsWith(prefix + "probe:") && identifiable) {
        groups.get(language)?.delete(id);
        const confirmed = record.url && cache.hasPlayed(record.url);
        if (confirmed || cache.fresh(record)) {
          observations.push({ ...record, value: confirmed ? "available" : record.value });
        }
      }
    }
  } catch (error) { console.warn("[CompactAudioPlayer] Could not read confirmed audio sources.", error); }
  // The legacy view has one slot per quality, even when two editions use different URLs.
  observations.sort((a, b) => a.timestamp - b.timestamp || String(a.url || "").localeCompare(String(b.url || "")));
  for (const { language, id, value } of observations) group(language).set(id, value);
  const byLanguage = Object.fromEntries(Array.from(groups, ([language, entries]) => [language, Object.fromEntries(entries)]));
  return { byLanguage, playedUrls: [...played] };
}

export function clearAvailability(records, bookId, cacheVersion) {
  const prefix = openAvailabilityCache(records, bookId, cacheVersion).scope + ":";
  const clearId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  if (!records.writeJson(`compactPlayer:availability:${bookId}:${cacheVersion}`, { timestamp: Date.now(), clearId })) return;
  try {
    for (const key of records.keys()) {
      if (key?.startsWith(prefix)) records.remove(key);
    }
  } catch (error) { console.warn("[CompactAudioPlayer] Could not remove cleared availability records.", error); }
}
