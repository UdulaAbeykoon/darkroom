/** Bounded, range-based TIFF/NEF preview extraction. Never reads sensor pixels. */
export interface RawPreview {
  blob: Blob;
  width: number;
  height: number;
}

// Untrusted offsets/counts must not turn a preview into a whole-card read.
const MAX_DIRECTORY_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORIES = 32;

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return { height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
    }
    offset += length;
  }
}

/** Add authoritative TIFF orientation without recompressing any JPEG pixels. */
export function orientedJpeg(jpeg: Blob, orientation: number): Blob {
  const exif = new Uint8Array([
    0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0,
    73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
    18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
  ]);
  return new Blob([jpeg.slice(0, 2), exif, jpeg.slice(2)], { type: "image/jpeg" });
}

/** Unsupported layouts and malformed previews fall back to LibRaw at the caller. */
export async function extractRawPreview(file: Blob): Promise<RawPreview | undefined> {
  try {
    const read = async (offset: number, size: number) => {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) ||
          offset < 0 || size < 0 || offset + size > file.size) {
        throw new Error("Invalid TIFF range");
      }
      return new DataView(await file.slice(offset, offset + size).arrayBuffer());
    };
    const header = await read(0, 8);
    const order = header.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return;
    const little = order === 0x4949;
    if (header.getUint16(2, little) !== 42) return;
    const queue = [header.getUint32(4, little)];
    const visited = new Set<number>();
    const candidates: Array<{ offset: number; length: number }> = [];
    let orientation = 1;
    let width = 0;
    let height = 0;
    while (queue.length && visited.size < MAX_DIRECTORIES) {
      const offset = queue.shift()!;
      if (!offset || visited.has(offset)) continue;
      visited.add(offset);
      const count = (await read(offset, 2)).getUint16(0, little);
      if (count * 12 + 6 > MAX_DIRECTORY_BYTES) return;
      const directory = await read(offset + 2, count * 12 + 4);
      const tags = new Map<number, number[]>();
      for (let index = 0; index < count; index++) {
        const at = index * 12;
        const tag = directory.getUint16(at, little);
        if (![256, 257, 259, 273, 274, 279, 330, 513, 514, 34665, 40962, 40963].includes(tag)) continue;
        const type = directory.getUint16(at + 2, little);
        const size = type === 3 ? 2 : type === 4 ? 4 : 0;
        const items = directory.getUint32(at + 4, little);
        if (!size || !items || items > MAX_DIRECTORIES) continue;
        const values = items * size <= 4
          ? new DataView(directory.buffer, at + 8, 4)
          : await read(directory.getUint32(at + 8, little), items * size);
        tags.set(tag, Array.from({ length: items }, (_, i) => size === 2
          ? values.getUint16(i * size, little) : values.getUint32(i * size, little)));
      }
      const value = (tag: number) => tags.get(tag)?.[0] ?? 0;
      if (visited.size === 1 && value(274) >= 1 && value(274) <= 8) orientation = value(274);
      const w = value(40962) || value(256);
      const h = value(40963) || value(257);
      if (w > 0 && h > 0 && w * h > width * height) { width = w; height = h; }
      let start = value(513);
      let length = value(514);
      // Some TIFF RAWs store a JPEG as a single compressed strip.
      if (!start && value(259) === 6 && tags.get(273)?.length === 1 && tags.get(279)?.length === 1) {
        start = value(273); length = value(279);
      }
      if (start && length > 4 && length <= MAX_PREVIEW_BYTES && start + length <= file.size) {
        candidates.push({ offset: start, length });
      }
      queue.push(...(tags.get(330) ?? []), value(34665), directory.getUint32(count * 12, little));
    }
    // Only read JPEG headers to choose the largest preview, then slice its data.
    let best: { blob: Blob; width: number; height: number } | undefined;
    for (const candidate of candidates) {
      const bytes = new Uint8Array((await read(candidate.offset, Math.min(candidate.length, 128 * 1024))).buffer);
      const dimensions = jpegDimensions(bytes);
      if (!dimensions || dimensions.width * dimensions.height < 256 * 256) continue;
      if (!best || dimensions.width * dimensions.height > best.width * best.height) {
        best = { ...dimensions, blob: file.slice(candidate.offset, candidate.offset + candidate.length, "image/jpeg") };
      }
    }
    if (!best) return;
    if (!width || !height) { width = best.width; height = best.height; }
    return {
      blob: orientedJpeg(best.blob, orientation),
      width: orientation >= 5 ? height : width,
      height: orientation >= 5 ? width : height,
    };
  } catch {
    return undefined;
  }
}
