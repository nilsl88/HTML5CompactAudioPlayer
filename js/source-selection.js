import { CODECS, extensionFromPath, mimeCandidatesFor } from "./codecs.js";
import { resolveLanguageAsset } from "./config.js";
export { AAC_MIME_TYPES, extensionFromPath, mimeFor, mimeCandidatesFor } from "./codecs.js";

export const CODEC_PREFERENCE = [...CODECS];

function supportScore(audioElement, mime) {
  const evidence = String(audioElement?.canPlayType?.(mime) || "");
  return evidence === "probably" ? 2 : evidence === "maybe" ? 1 : 0;
}

export function buildSources(language, audioElement) {
  const sources = [];
  for (const codec of CODEC_PREFERENCE) {
    for (const [bitrateValue, path] of Object.entries(language?.sources?.[codec] || {})) {
      const bitrate = Number.parseInt(bitrateValue, 10);
      const extension = extensionFromPath(path);
      const mimeCandidates = mimeCandidatesFor(codec, extension);
      const supportedCandidates = mimeCandidates.map((mime) => ({ mime, support: supportScore(audioElement, mime) }));
      const selected = supportedCandidates.reduce((best, candidate) => candidate.support > best.support ? candidate : best, { mime: "", support: 0 });
      sources.push({
        id: `${codec}-${bitrate}`,
        codec,
        bitrate,
        extension,
        mime: selected.mime || mimeCandidates.at(-1),
        url: resolveLanguageAsset(language, path),
        support: selected.support,
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
  const alternatives = candidates.filter((source) => source.id !== selected.id);
  alternatives.sort((a, b) =>
    Number(a.availability === "missing") - Number(b.availability === "missing")
    || codecOrder.indexOf(a.codec) - codecOrder.indexOf(b.codec)
    || Math.abs(a.bitrate - selected.bitrate) - Math.abs(b.bitrate - selected.bitrate)
    || a.bitrate - b.bitrate);
  const ordered = [selected, ...alternatives];
  return ordered.filter((source, index, list) => list.findIndex((item) => item.url === source.url) === index);
}

export class SourceFallback {
  constructor(sources = [], selectedId) {
    this.sources = sources;
    this.selectedId = selectedId;
    this.restart();
  }

  restart() {
    this.failedUrls = new Set();
    this.rejectedCodecs = new Set();
    this.exhausted = false;
    this.current = buildFallbackQueue(this.sources, this.selectedId)[0] || null;
    return this.current;
  }

  afterFailure(rejectCodec) {
    this.failedUrls.add(this.current.url);
    if (rejectCodec) this.rejectedCodecs.add(this.current.codec);
    // A probe can finish while the previous source is playing.
    const next = buildFallbackQueue(this.sources, this.selectedId).find((source) =>
      !this.failedUrls.has(source.url) && !this.rejectedCodecs.has(source.codec));
    if (next) this.current = next;
    else this.exhausted = true;
    return next;
  }
}
