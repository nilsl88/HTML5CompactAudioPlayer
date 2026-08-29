function parseTimestamp(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return Number.NaN;
  const seconds = Number.parseFloat(parts.pop());
  const minutes = Number.parseInt(parts.pop(), 10);
  const hours = parts.length ? Number.parseInt(parts.pop(), 10) : 0;
  if (![hours, minutes, seconds].every(Number.isFinite) || minutes < 0 || seconds < 0 || minutes > 59 || seconds >= 60) return Number.NaN;
  return hours * 3600 + minutes * 60 + seconds;
}

function cleanCueText(lines) {
  return lines.join(" ").replace(/<[^>]*>/g, "").replace(/&(?:lt|gt|amp|nbsp);/g, (entity) => ({ "&lt;": "<", "&gt;": ">", "&amp;": "&", "&nbsp;": " " })[entity]).replace(/\s+/g, " ").trim();
}

export function parseWebVtt(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
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
    if (Number.isFinite(start) && start >= 0 && title) cues.push({ start, end: Number.isFinite(end) && end >= start ? end : null, title });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues.filter((cue, position) => position === 0 || cue.start !== cues[position - 1].start || cue.title !== cues[position - 1].title);
}
