const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl", "stsd", "edts", "dinf", "udta", "tref", "ilst", "meta"]);
const MAX_METADATA_BOXES = 65_536;
const typeDecoder = new TextDecoder("ascii");

function uint32(view, offset) { return view.getUint32(offset, false); }

export function uint64(view, offset) {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = high * 4294967296 + low;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function atomType(bytes, offset) {
  return typeDecoder.decode(bytes.subarray(offset, offset + 4));
}

export function* parseBoxes(data, absoluteStart = 0, { skipPrefix = 0, budget = { remaining: MAX_METADATA_BOXES } } = {}) {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = skipPrefix;
  while (offset + 8 <= bytes.byteLength) {
    if (budget.remaining-- <= 0) throw new Error("MP4 metadata exceeded the box limit.");
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
    const truncated = offset + size > bytes.byteLength;
    yield { type, start: absoluteStart + start, size, headerSize, truncated, buffer: bytes.buffer,
      payloadStart: bytes.byteOffset + start + headerSize, payloadEnd: bytes.byteOffset + Math.min(start + size, bytes.byteLength) };
    if (truncated) break;
    offset += size;
  }
}

export function payload(atom) { return new Uint8Array(atom.buffer, atom.payloadStart, atom.payloadEnd - atom.payloadStart); }

export function findAtoms(buffer, type, options) {
  const found = [];
  const budget = { remaining: MAX_METADATA_BOXES };
  const visit = (atoms, depth = 0) => {
    if (depth > 12) return;
    for (const atom of atoms) {
      if (atom.type === type) found.push(atom);
      if (CONTAINER_TYPES.has(atom.type)) {
        const prefix = atom.type === "meta" ? 4 : 0;
        visit(parseBoxes(payload(atom), atom.start + atom.headerSize, { skipPrefix: prefix, budget }), depth + 1);
      }
    }
  };
  visit(parseBoxes(buffer, options?.absoluteStart || 0, { budget }));
  return found;
}

export async function findTopLevelAtom(reader, expectedType) {
  let start = 0;
  for (let count = 0; count < 1000 && start + 8 <= reader.total; count += 1) {
    const bytes = await reader.read(start, Math.min(reader.total, start + 16));
    if (bytes.byteLength < 8) break;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = uint32(view, 0);
    const type = atomType(bytes, 4);
    let headerSize = 8;
    if (size === 1) {
      if (bytes.byteLength < 16) break;
      size = uint64(view, 8);
      headerSize = 16;
    } else if (size === 0) size = reader.total - start;
    if (!Number.isSafeInteger(size) || size < headerSize || start + size > reader.total) break;
    if (type === expectedType) return { type, start, size, headerSize };
    start += size;
  }
  return null;
}
