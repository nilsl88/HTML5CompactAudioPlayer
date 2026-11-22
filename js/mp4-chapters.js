import { uint64, findAtoms, payload, parseBoxes } from "./mp4-atoms.js";
import { loadMp4Metadata, RangeReader, MP4_METADATA_CHUNK_BYTES, MP4_METADATA_LIMIT_BYTES } from "./mp4-metadata.js";
export { MP4_METADATA_CHUNK_BYTES, MP4_METADATA_LIMIT_BYTES } from "./mp4-metadata.js";
export const MP4_COVER_LIMIT_BYTES = 10 * 1024 * 1024;
const MAX_QUICKTIME_SAMPLES = 10_000;
const MAX_SAMPLE_GAP_BYTES = 4096;

export function decodeMp4ChapterTitle(bytes) {
  if (!bytes.length) return "";
  let value = bytes;
  if (value.length >= 2) {
    const declared = (value[0] << 8) | value[1];
    if (declared > 0 && declared <= value.length - 2) value = value.subarray(2, declared + 2);
  }
  let encoding = "utf-8";
  if ((value[0] === 0xfe && value[1] === 0xff) || (value.length >= 2 && value[0] === 0 && value[1] !== 0)) {
    encoding = "utf-16be";
  } else if (value[0] === 0xff && value[1] === 0xfe) encoding = "utf-16le";
  const text = new TextDecoder(encoding).decode(value);
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
      const title = decodeMp4ChapterTitle(bytes.subarray(offset, offset + titleLength)) || `Chapter ${index + 1}`;
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
  if (atom.truncated || bytes.length % 4 !== 0) throw new Error("The QuickTime chapter track reference is incomplete.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4) values.push(view.getUint32(offset, false));
  return values;
}

function tableEntries(atom, entryWidth, limit, mapper) {
  const view = new DataView(atom.buffer, atom.payloadStart, atom.payloadEnd - atom.payloadStart);
  if (view.byteLength < 8) return [];
  const count = view.getUint32(4, false);
  if (8 + count * entryWidth > view.byteLength) return [];
  const entries = [];
  const end = Math.min(count, limit);
  for (let index = 0; index < end; index += 1) entries.push(mapper(view, 8 + index * entryWidth));
  return entries;
}

function parseChapterTrack(trak) {
  const invalidMapping = () => new Error("The QuickTime chapter tables or chunk mapping are incomplete or invalid.");
  const mdhd = findAtoms(payload(trak), "mdhd", { absoluteStart: trak.start + trak.headerSize })[0];
  const stbl = findAtoms(payload(trak), "stbl", { absoluteStart: trak.start + trak.headerSize })[0];
  if (!mdhd || !stbl) throw invalidMapping();
  const mdhdBytes = new Uint8Array(payload(mdhd));
  const mdhdView = new DataView(mdhdBytes.buffer, mdhdBytes.byteOffset, mdhdBytes.byteLength);
  const mdhdVersion = mdhdBytes[0];
  const timescaleOffset = mdhdVersion === 1 ? 20 : 12;
  const timescale = mdhdBytes.length >= timescaleOffset + 4 ? mdhdView.getUint32(timescaleOffset, false) : 0;
  if (!timescale) throw invalidMapping();
  const stts = findAtoms(payload(stbl), "stts", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stsc = findAtoms(payload(stbl), "stsc", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stsz = findAtoms(payload(stbl), "stsz", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const stco = findAtoms(payload(stbl), "stco", { absoluteStart: stbl.start + stbl.headerSize })[0];
  const co64 = findAtoms(payload(stbl), "co64", { absoluteStart: stbl.start + stbl.headerSize })[0];
  if (!stts || !stsc || !stsz || (!stco && !co64)) throw invalidMapping();
  const sizeView = new DataView(stsz.buffer, stsz.payloadStart, stsz.payloadEnd - stsz.payloadStart);
  if (sizeView.byteLength < 12) throw invalidMapping();
  const fixedSize = sizeView.getUint32(4, false);
  const declaredCount = sizeView.getUint32(8, false);
  if (!fixedSize && 12 + declaredCount * 4 > sizeView.byteLength) throw invalidMapping();
  const sampleCount = Math.min(declaredCount, MAX_QUICKTIME_SAMPLES);
  const durations = [];
  for (const entry of tableEntries(stts, 8, sampleCount, (view, offset) => ({ count: view.getUint32(offset, false), delta: view.getUint32(offset + 4, false) }))) {
    for (let index = 0; index < entry.count && durations.length < sampleCount; index += 1) durations.push(entry.delta);
  }
  if (durations.length !== sampleCount) throw invalidMapping();
  const offsets = tableEntries(co64 || stco, co64 ? 8 : 4, sampleCount, (view, offset) => co64 ? uint64(view, offset) : view.getUint32(offset, false));
  const chunks = tableEntries(stsc, 12, sampleCount, (view, offset) => ({ firstChunk: view.getUint32(offset, false), samplesPerChunk: view.getUint32(offset + 4, false) }));
  if (sampleCount && (!chunks.length || chunks[0].firstChunk !== 1
    || chunks.some((entry, index) => !entry.samplesPerChunk
      || (index > 0 && entry.firstChunk <= chunks[index - 1].firstChunk)))) throw invalidMapping();
  const samples = [];
  let timestamp = 0;
  let sampleIndex = 0;
  let mapping = 0;
  for (let chunkIndex = 0; chunkIndex < offsets.length && sampleIndex < sampleCount; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    while (mapping + 1 < chunks.length && chunks[mapping + 1].firstChunk <= chunkNumber) mapping += 1;
    const entry = chunks[mapping];
    if (!entry || entry.firstChunk > chunkNumber) throw invalidMapping();
    let offset = offsets[chunkIndex];
    for (let count = 0; count < entry.samplesPerChunk && sampleIndex < sampleCount; count += 1) {
      const size = fixedSize || sizeView.getUint32(12 + sampleIndex * 4, false);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(offset + size)
        || size <= 0 || size > MP4_METADATA_LIMIT_BYTES) throw invalidMapping();
      samples.push({ offset, size, start: timestamp / timescale });
      timestamp += durations[sampleIndex];
      offset += size;
      sampleIndex += 1;
    }
  }
  if (sampleIndex !== sampleCount) throw invalidMapping();
  return samples;
}

function normalizeChapters(chapters) {
  const sorted = chapters.filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0 && chapter.title).sort((a, b) => a.start - b.start);
  const unique = sorted.filter((chapter, index) => index === 0 || chapter.start !== sorted[index - 1].start || chapter.title !== sorted[index - 1].title);
  return unique.map((chapter, index) => ({ start: chapter.start, end: Number.isFinite(chapter.end) && chapter.end >= chapter.start ? chapter.end : (unique[index + 1]?.start ?? null), title: chapter.title }));
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
  const metadata = await loadMp4Metadata(url, options);
  const { moovBuffer } = metadata;
  const nero = findAtoms(moovBuffer, "chpl");
  const neroChapters = nero.flatMap(parseNeroChapters);
  if (neroChapters.length) return normalizeChapters(neroChapters);

  const tracks = findAtoms(moovBuffer, "trak");
  let references;
  try { references = new Set(tracks.flatMap(chapterReferences)); }
  catch (error) {
    metadata.discard();
    throw error;
  }
  if (!references.size) return [];
  const chapterTrack = tracks.find((track) => references.has(parseTrackId(track)));
  if (!chapterTrack) {
    metadata.discard();
    throw new Error("The referenced QuickTime chapter track was not found.");
  }
  let samples;
  try { samples = parseChapterTrack(chapterTrack); }
  catch (error) {
    metadata.discard();
    throw error;
  }
  if (!samples?.length) return [];
  const reader = new RangeReader(url, options, metadata);
  const chapters = [];
  for (let i = 0; i < samples.length;) {
    const start = samples[i].offset;
    let end = start + samples[i].size;
    let next = i + 1;
    while (next < samples.length) {
      const { offset, size } = samples[next];
      if (offset < end || offset - end > MAX_SAMPLE_GAP_BYTES || offset + size - start > MP4_METADATA_CHUNK_BYTES) break;
      end = offset + size;
      next++;
    }
    let bytes;
    try { bytes = await reader.read(start, end); }
    catch (error) {
      metadata.discard();
      throw error;
    }
    for (; i < next; i++) {
      const sample = samples[i];
      const offset = sample.offset - start;
      const title = decodeMp4ChapterTitle(bytes.subarray(offset, offset + sample.size));
      chapters.push({ start: sample.start, end: null, title });
    }
  }
  return normalizeChapters(chapters);
}
