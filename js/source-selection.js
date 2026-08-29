import { CODECS, resolveLanguageAsset } from "./config.js";

export const CODEC_PREFERENCE = [...CODECS];

export function extensionFromPath(path) {
  return String(path || "").toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/)?.[1] || "";
}

export function mimeFor(codec, extension = "") {
  if (codec === "opus") return extension === "ogg" ? 'audio/ogg; codecs="opus"' : 'audio/webm; codecs="opus"';
  if (codec === "aac") return 'audio/mp4; codecs="mp4a.40.2"';
  if (codec === "mp3") return "audio/mpeg";
  return "";
}

export function buildSources(language, audioElement) {
  const sources = [];
  for (const codec of CODEC_PREFERENCE) {
    for (const [bitrateValue, path] of Object.entries(language?.sources?.[codec] || {})) {
      const bitrate = Number.parseInt(bitrateValue, 10);
      const extension = extensionFromPath(path);
      const mime = mimeFor(codec, extension);
      const evidence = String(audioElement?.canPlayType?.(mime) || "");
      sources.push({
        id: `${codec}-${bitrate}`,
        codec,
        bitrate,
        extension,
        mime,
        url: resolveLanguageAsset(language, path),
        support: evidence === "probably" ? 2 : evidence === "maybe" ? 1 : 0,
        availability: "unknown",
      });
    }
  }
  return sources.sort(compareSources);
}

function compareSources(a, b) {
  const codecDifference = CODEC_PREFERENCE.indexOf(a.codec) - CODEC_PREFERENCE.indexOf(b.codec);
  return codecDifference || b.bitrate - a.bitrate || b.support - a.support;
}

export function eligibleSources(sources) {
  return sources.filter((source) => source.url && source.availability !== "missing");
}

export function chooseDefaultSource(sources) {
  const eligible = eligibleSources(sources);
  return eligible.find((source) => source.support > 0) || eligible[0]
    || sources.find((source) => source.url && source.support > 0)
    || sources.find((source) => source.url) || null;
}

export function visibleSources(sources, showAllCodecs = false) {
  const knownOrUnknown = eligibleSources(sources);
  const eligible = knownOrUnknown.length ? knownOrUnknown : sources.filter((source) => source.url);
  if (showAllCodecs) return eligible;
  for (const codec of CODEC_PREFERENCE) {
    const family = eligible.filter((source) => source.codec === codec && source.support > 0);
    if (family.length) return family;
  }
  return eligible.length ? eligible.filter((source) => source.codec === eligible[0].codec) : [];
}

export function buildFallbackQueue(sources, selectedId) {
  const candidates = sources.filter((source) => source.url);
  const selected = candidates.find((source) => source.id === selectedId) || chooseDefaultSource(candidates);
  if (!selected) return [];
  const codecOrder = [selected.codec, ...CODEC_PREFERENCE.filter((codec) => codec !== selected.codec)];
  const ordered = [selected];
  for (const codec of codecOrder) {
    const family = candidates
      .filter((source) => source.id !== selected.id && source.codec === codec)
      .sort((a, b) => {
        if ((a.availability === "missing") !== (b.availability === "missing")) return a.availability === "missing" ? 1 : -1;
        const aDistance = Math.abs(a.bitrate - selected.bitrate);
        const bDistance = Math.abs(b.bitrate - selected.bitrate);
        if (aDistance !== bDistance) return aDistance - bDistance;
        if ((a.bitrate <= selected.bitrate) !== (b.bitrate <= selected.bitrate)) return a.bitrate <= selected.bitrate ? -1 : 1;
        return b.bitrate - a.bitrate;
      });
    ordered.push(...family);
  }
  return ordered.filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index);
}
