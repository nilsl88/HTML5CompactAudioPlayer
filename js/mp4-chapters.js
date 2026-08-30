import { createAbortError, fetchWithRetry } from "./utils.js";

export const MP4_METADATA_CHUNK_BYTES = 256 * 1024;
export const MP4_METADATA_LIMIT_BYTES = 16 * 1024 * 1024;
export const MP4_COVER_LIMIT_BYTES = 10 * 1024 * 1024;

const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl", "stsd", "edts", "dinf", "udta", "tref", "ilst", "meta"]);

function uint32(view, offset) { return view.getUint32(offset, false); }

function uint64(view, offset) {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = high * 4294967296 + low;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function atomType(bytes, offset) {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + 4));
}

function parseBoxes(buffer, absoluteStart = 0, { skipPrefix = 0 } = {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const atoms = [];
  let offset = skipPrefix;
  while (offset + 8 <= bytes.byteLength) {
    const start = offset;
    let size = uint32(view, offset);
    const type = atomType(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) break;
      size = uint64(view, offset + 8);
      headerSize = 16;
    } else if (size === 0) size = bytes.byteLength - offset;
    if (!Number.isSafeInteger(size) || size < headerSize) break;
    if (offset + size > bytes.byteLength) {
      atoms.push({ type, start: absoluteStart + start, size, headerSize, payloadStart: start + headerSize, payloadEnd: bytes.byteLength, buffer, truncated: true });
      break;
    }
    atoms.push({ type, start: absoluteStart + start, size, headerSize, payloadStart: start + headerSize, payloadEnd: start + size, buffer });
    offset += size;
  }
  return atoms;
}

function payload(atom) { return atom.buffer.slice(atom.payloadStart, atom.payloadEnd); }

function findAtoms(buffer, type, options) {
  const found = [];
  const visit = (atoms, depth = 0) => {
    if (depth > 12) return;
    for (const atom of atoms) {
      if (atom.type === type) found.push(atom);
      if (CONTAINER_TYPES.has(atom.type)) {
        const prefix = atom.type === "meta" ? 4 : 0;
        visit(parseBoxes(payload(atom), atom.start + atom.headerSize, { skipPrefix: prefix }), depth + 1);
      }
    }
  };
  visit(parseBoxes(buffer, options?.absoluteStart || 0));
  return found;
}

function parseContentRange(value) {
  const match = String(value || "").match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match || match[3] === "*") return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && Number.isSafeInteger(total) && end >= start && total > end
    ? { start, end, total }
    : null;
}

class RangeReader {
  constructor(url, { fetchImpl = globalThis.fetch, signal, timeoutMs = 20000 } = {}) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.total = 0;
  }

  async read(start, end) {
    if (this.signal?.aborted) throw createAbortError();
    if (end <= start || end - start > MP4_METADATA_LIMIT_BYTES) throw new Error("MP4 metadata range is invalid or too large.");
    const response = await fetchWithRetry(this.url, {
      fetchImpl: this.fetchImpl,
      cache: "default",
      credentials: "same-origin",
      headers: { Range: `bytes=${start}-${end - 1}` },
      signal: this.signal,
      timeoutMs: this.timeoutMs,
      retries: 2,
    });
    if (response.status !== 206) throw new Error("The audio server does not support metadata byte ranges.");
    const range = parseContentRange(response.headers?.get?.("Content-Range"));
    if (!range) throw new Error("The audio server returned an invalid metadata range.");
    const expectedEnd = Math.min(end, range.total) - 1;
    if (range.start !== start || range.end !== expectedEnd) throw new Error("The audio server returned an invalid metadata range.");
    this.total = range.total;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== range.end - start + 1) throw new Error("The audio metadata range was truncated.");
    return bytes;
  }
}

function decodeTitle(bytes) {
  if (!bytes.length) return "";
  let value = bytes;
  if (value.length >= 2) {
    const declared = (value[0] << 8) | value[1];
    if (declared === value.length - 2) value = value.subarray(2);
  }
  let text;
  if (value.length >= 2 && ((value[0] === 0xfe && value[1] === 0xff) || (value[0] === 0xff && value[1] === 0xfe))) {
    text = new TextDecoder("utf-16").decode(value);
  } else if (value.length >= 2 && value[0] === 0 && value[1] !== 0) {
    const swapped = new Uint8Array(value.length);
    for (let index = 0; index + 1 < value.length; index += 2) { swapped[index] = value[index + 1]; swapped[index + 1] = value[index]; }
    text = new TextDecoder("utf-16").decode(swapped);
  } else text = new TextDecoder("utf-8", { fatal: false }).decode(value);
  return text.replace(/\0/g, "").replace(/\s+/g, " ").trim();
}

function parseNeroChapters(atom) {
  const bytes = new Uint8Array(payload(atom));
  if (bytes.length < 9) return [];
  for (const countOffset of [8, 4]) {
    const count = bytes[countOffset];
    if (!count || count > 10000) continue;
    let offset = countOffset + 1;
    const chapters = [];
    for (let index = 0; index < count; index += 1) {
      if (offset + 9 > bytes.length) { chapters.length = 0; break; }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const startTicks = uint64(view, offset);
      const titleLength = bytes[offset + 8];
      offset += 9;
      if (!Number.isSafeInteger(startTicks) || offset + titleLength > bytes.length) { chapters.length = 0; break; }
      const title = decodeTitle(bytes.subarray(offset, offset + titleLength)) || `Chapter ${index + 1}`;
      chapters.push({ start: startTicks / 10000000, end: null, title });
      offset += titleLength;
    }
    if (chapters.length === count) return chapters;
  }
  return [];
}

function parseTrackId(trak) {
  const atom = findAtoms(payload(trak), "tkhd", { absoluteStart: trak.start + trak.headerSize })[0];
  if (!atom) return 0;
  const bytes = new Uint8Array(payload(atom));
  const version = bytes[0];
  const offset = version === 1 ? 20 : 12;
  return bytes.length >= offset + 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false) : 0;
}

function chapterReferences(trak) {
  const atom = findAtoms(payload(trak), "chap", { absoluteStart: trak.start + trak.headerSize })[0];
  if (!atom) return [];
  const bytes = new Uint8Array(payload(atom));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) values.push(view.getUint32(offset, false));
  return values;
}

function tableEntries(atom, entryWidth, mapper) {
  if (!atom) return [];
  const bytes = new Uint8Array(payload(atom));
  if (bytes.length < 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, false);
  const entries = [];
  let offset = 8;
  for (let index = 0; index < count && offset + entryWidth <= bytes.length; index += 1, offset += entryWidth) entries.push(mapper(view, offset));
  return entries;
}

function parseChapterTrack(trak) {
  const mdhd = findAtoms(payload(trak), "mdhd", { absoluteStart: trak.start + trak.headerSize })[0];
  const stbl = findAtoms(payload(trak), "stbl", { absoluteStart: trak.start + trak.headerSize })[0];
  if (!mdhd || !stbl) return null;
  const mdhdBytes = new Uint8Array(payload(mdhd));
  const mdhdView = new DataView(mdhdBytes.buffer, mdhdBytes.byteOffset, mdhdBytes.byteLength);
  const mdhdVersion = mdhdBytes[0];
  const timescaleOffset = mdhdVersion === 1 ? 20 : 12;
  const timescale = mdhdBytes.length >= timescaleOffset + 4 ? mdhdView.getUint32(timescaleOffset, false) : 0;
  if (!timescale) return null;
  const stts = findAtoms(payload(stbl), "stts", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stsc = findAtoms(payload(stbl), "stsc", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stsz = findAtoms(payload(stbl), "stsz", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stco = findAtoms(payload(stbl), "stco", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const co64 = findAtoms(payload(stbl), "co64", { absoluteStart: stbl.start + stbl.headerSize })[0];
  if (!stts || !stsc || !stsz || (!stco && !co64)) return null;
  const durations = [];
  for (const entry of tableEntries(stts, 8, (view, offset) => ({ count: view.getUint32(offset, false), delta: view.getUint32(offset + 4, false) }))) {
    for (let index = 0; index < entry.count && durations.length < 10000; index += 1) durations.push(entry.delta);
  }
  const sizeBytes = new Uint8Array(payload(stsz));
  const sizeView = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, sizeBytes.byteLength);
  const fixedSize = sizeView.getUint32(4, false);
  const sampleCount = sizeView.getUint32(8, false);
  const sizes = fixedSize ? Array(sampleCount).fill(fixedSize) : Array.from({ length: Math.min(sampleCount, 10000) }, (_, index) => sizeView.getUint32(12 + index * 4, false));
  const offsets = tableEntries(co64 || stco, co64 ? 8 : 4, (view, offset) => co64 ? uint64(view, offset) : view.getUint32(offset, false));
  const chunks = tableEntries(stsc, 12, (view, offset) => ({ firstChunk: view.getUint32(offset, false), samplesPerChunk: view.getUint32(offset + 4, false) }));
  const sampleOffsets = [];
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < offsets.length && sampleIndex < sizes.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    const entry = [...chunks].reverse().find((item) => item.firstChunk <= chunkNumber);
    if (!entry) continue;
    let offset = offsets[chunkIndex];
    for (let count = 0; count < entry.samplesPerChunk && sampleIndex < sizes.length; count += 1) {
      sampleOffsets.push({ offset, size: sizes[sampleIndex] });
      offset += sizes[sampleIndex]; sampleIndex += 1;
    }
  }
  const starts = [];
  let timestamp = 0;
  for (let index = 0; index < sampleOffsets.length; index += 1) { starts.push(timestamp / timescale); timestamp += durations[index] || 0; }
  return sampleOffsets.map((sample, index) => ({ ...sample, start: starts[index] })).filter((sample) => Number.isSafeInteger(sample.offset) && sample.size > 0 && sample.size <= MP4_METADATA_LIMIT_BYTES);
}

function normalizeChapters(chapters) {
  const sorted = chapters.filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0 && chapter.title).sort((a, b) => a.start - b.start);
  const unique = sorted.filter((chapter, index) => index === 0 || chapter.start !== sorted[index - 1].start || chapter.title !== sorted[index - 1].title);
  return unique.map((chapter, index) => ({ start: chapter.start, end: Number.isFinite(chapter.end) && chapter.end >= chapter.start ? chapter.end : (unique[index + 1]?.start ?? null), title: chapter.title }));
}

async function loadMp4Metadata(url, options = {}) {
  const reader = new RangeReader(url, options);
  const firstEnd = Math.min(MP4_METADATA_CHUNK_BYTES, MP4_METADATA_LIMIT_BYTES);
  const first = await reader.read(0, firstEnd);
  let top = parseBoxes(first.buffer);
  let moov = top.find((atom) => atom.type === "moov");
  if (!moov) {
    if (!reader.total) throw new Error("The MP4 file size is unknown.");
    for (let windowSize = MP4_METADATA_CHUNK_BYTES; windowSize <= MP4_METADATA_LIMIT_BYTES && !moov; windowSize *= 2) {
      const tailStart = Math.max(0, reader.total - windowSize);
      const tail = await reader.read(tailStart, reader.total);
      top = parseBoxes(tail.buffer, tailStart);
      moov = top.find((atom) => atom.type === "moov");
      if (tailStart === 0) break;
    }
  }
  if (!moov) throw new Error("The MP4 metadata box was not found.");
  let moovBytes;
  if (moov.start === 0 && moov.size <= first.byteLength) moovBytes = first.subarray(moov.start, moov.start + moov.size);
  else moovBytes = await reader.read(moov.start, moov.start + moov.size);
  const moovBuffer = moovBytes.buffer.slice(moovBytes.byteOffset, moovBytes.byteOffset + moovBytes.byteLength);
  return { reader, moovBuffer };
}

function embeddedCoverMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  return "";
}

export async function loadEmbeddedMp4Cover(url, options = {}) {
  const { moovBuffer } = await loadMp4Metadata(url, options);
  for (const cover of findAtoms(moovBuffer, "covr")) {
    const dataAtoms = parseBoxes(payload(cover)).filter((atom) => atom.type === "data" && !atom.truncated);
    for (const dataAtom of dataAtoms) {
      const bytes = new Uint8Array(payload(dataAtom));
      if (bytes.length <= 8 || bytes.length - 8 > MP4_COVER_LIMIT_BYTES) continue;
      const image = bytes.subarray(8);
      const mime = embeddedCoverMime(image);
      if (mime) return { data: image.slice(), mime };
    }
  }
  return null;
}

export async function loadEmbeddedMp4Chapters(url, options = {}) {
  const { reader, moovBuffer } = await loadMp4Metadata(url, options);
  const nero = findAtoms(moovBuffer, "chpl");
  const neroChapters = nero.flatMap(parseNeroChapters);
  if (neroChapters.length) return normalizeChapters(neroChapters);

  const tracks = findAtoms(moovBuffer, "trak");
  const references = new Set(tracks.flatMap(chapterReferences));
  const chapterTrack = tracks.find((track) => references.has(parseTrackId(track)));
  if (!chapterTrack) return [];
  const samples = parseChapterTrack(chapterTrack);
  if (!samples?.length) return [];
  const chapters = [];
  for (const sample of samples) {
    const bytes = await reader.read(sample.offset, sample.offset + sample.size);
    chapters.push({ start: sample.start, end: null, title: decodeTitle(bytes) });
  }
  return normalizeChapters(chapters);
}
