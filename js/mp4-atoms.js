const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl", "stsd", "edts", "dinf", "udta", "tref", "ilst", "meta"]);

function uint32(view, offset) { return view.getUint32(offset, false); }

export function uint64(view, offset) {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  const value = high * 4294967296 + low;
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function atomType(bytes, offset) {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + 4));
}

export function parseBoxes(buffer, absoluteStart = 0, { skipPrefix = 0 } = {}) {
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

export function payload(atom) { return atom.buffer.slice(atom.payloadStart, atom.payloadEnd); }

export function findAtoms(buffer, type, options) {
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
