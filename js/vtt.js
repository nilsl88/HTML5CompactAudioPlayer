function parseTimestamp(value) {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value.trim());
  if (!match) return Number.NaN;
  const [, hours = "0", minutes, seconds, millis] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(millis) / 1000;
}

function cleanCueText(lines) {
  return lines.join(" ").replace(/<[^>]*>/g, "").replace(/&(?:lt|gt|amp|nbsp);/g, (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&nbsp;": " " })[entity]).replace(/\s+/g, " ").trim();
}

export function parseWebVtt(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const cues = [];
  let index = lines[0]?.trim().startsWith("WEBVTT") ? 1 : 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1;
    if (index >= lines.length) break;
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[index].trim())) {
      while (index < lines.length && lines[index].trim()) index += 1;
      continue;
    }
    if (!lines[index].includes("-->") && lines[index + 1]?.includes("-->")) index += 1;
    if (!lines[index]?.includes("-->")) { index += 1; continue; }
    const [startValue, endAndSettings] = lines[index].split("-->");
    const start = parseTimestamp(startValue);
    const end = parseTimestamp(String(endAndSettings || "").trim().split(/\s+/)[0]);
    index += 1;
    const cueLines = [];
    while (index < lines.length && lines[index].trim()) { cueLines.push(lines[index].trim()); index += 1; }
    const title = cleanCueText(cueLines);
    if (Number.isFinite(end) && end > start && title) cues.push({ start, end, title });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.filter((cue, position) => position === 0 || cue.start !== cues[position - 1].start || cue.title !== cues[position - 1].title);
}
