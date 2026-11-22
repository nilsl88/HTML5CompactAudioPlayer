// AAC sources may contain AAC-LC, HE-AAC v1, or HE-AAC v2. Keep the
// profile strings separate: codecs is an evidence hint, not a guarantee
// that the downloaded file uses that exact profile.
export const AAC_MIME_TYPES = [
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="mp4a.40.5"',
  'audio/mp4; codecs="mp4a.40.29"',
  "audio/mp4",
];

const qualityLabels = [[256, "qPremium"], [128, "qHigh"], [96, "qLow"], [0, "qUltraLow"]];
const legacyLabels = [[128, "qLegacyFair"], [96, "qLegacyLow"], [0, "qLegacyUltraLow"]];
const oggOpus = ['audio/ogg; codecs="opus"'];
const formats = {
  opus: { mime: ['audio/webm; codecs="opus"'], extensions: { ogg: oggOpus, opus: oggOpus }, labels: qualityLabels },
  aac: { mime: AAC_MIME_TYPES, container: "mp4", labels: qualityLabels },
  mp3: { mime: ["audio/mpeg"], labels: legacyLabels },
};

export const CODECS = Object.keys(formats);

export function extensionFromPath(path) {
  return String(path || "").toLowerCase().match(/\.([a-z0-9]+)(?:[?#]|$)/)?.[1] || "";
}

export function mimeCandidatesFor(codec, extension = "") {
  const format = formats[codec];
  if (format?.extensions && Object.hasOwn(format.extensions, extension)) return [...format.extensions[extension]];
  return [...(format?.mime || [])];
}

export function mimeFor(codec, extension = "") {
  return mimeCandidatesFor(codec, extension)[0] || "";
}

export function isMp4Audio({ codec, mime, extension, url } = {}) {
  return formats[codec]?.container === "mp4" || /^audio\/mp4(?:;|$)/i.test(mime || "")
    || ["m4a", "m4b", "mp4"].includes(extension || extensionFromPath(url));
}

export function qualityLabelKey(codec, bitrate) {
  const labels = formats[codec]?.labels || qualityLabels;
  return labels.find(([minimum]) => bitrate >= minimum)?.[1] || labels.at(-1)[1];
}
