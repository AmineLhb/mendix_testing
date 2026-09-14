/**
 * True if a screenshot PNG is a single flat color from corner to corner —
 * i.e. nothing ever rendered (a connection failure or a timeout before
 * first paint), not a real capture of app state. Decides this by actually
 * decoding the pixels (IHDR + IDAT via zlib, then undoing the per-scanline
 * filter), not by pattern-matching the error message — a screenshot that
 * genuinely shows a mid-render app is never a flat color, so this can't
 * misclassify a real failure just because its error text happens to mention
 * "connection" or "timeout".
 *
 * Only handles the 8-bit, non-interlaced, non-palette PNGs Chromium's own
 * screenshots always use (colorType 0/2/4/6) — anything else, or anything
 * that fails to decode, returns false so an unrecognized format is kept
 * rather than silently dropped.
 */
import zlib from "node:zlib";

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function isBlankScreenshot(buffer) {
  try {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;

    let offset = 8;
    let width, height, bitDepth, colorType, interlace;
    const idatChunks = [];
    while (offset < buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      if (type === "IHDR") {
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
        bitDepth = buffer.readUInt8(dataStart + 8);
        colorType = buffer.readUInt8(dataStart + 9);
        interlace = buffer.readUInt8(dataStart + 12);
      } else if (type === "IDAT") {
        idatChunks.push(buffer.subarray(dataStart, dataStart + length));
      } else if (type === "IEND") {
        break;
      }
      offset = dataStart + length + 4; // skip CRC
    }

    if (bitDepth !== 8 || interlace !== 0 || !(colorType in CHANNELS_BY_COLOR_TYPE)) return false;
    const bpp = CHANNELS_BY_COLOR_TYPE[colorType];
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const stride = width * bpp;
    const pixels = Buffer.alloc(height * stride);

    let rawOffset = 0;
    for (let y = 0; y < height; y++) {
      const filterType = raw[rawOffset++];
      const rowStart = y * stride;
      for (let x = 0; x < stride; x++) {
        const filt = raw[rawOffset++];
        const a = x >= bpp ? pixels[rowStart + x - bpp] : 0;
        const b = y > 0 ? pixels[rowStart - stride + x] : 0;
        const c = y > 0 && x >= bpp ? pixels[rowStart - stride + x - bpp] : 0;
        let value;
        switch (filterType) {
          case 0: value = filt; break;
          case 1: value = (filt + a) & 0xff; break;
          case 2: value = (filt + b) & 0xff; break;
          case 3: value = (filt + Math.floor((a + b) / 2)) & 0xff; break;
          case 4: value = (filt + paeth(a, b, c)) & 0xff; break;
          default: return false; // unknown filter type — bail rather than guess
        }
        pixels[rowStart + x] = value;
      }
    }

    const first = pixels.subarray(0, bpp);
    for (let i = bpp; i < pixels.length; i += bpp) {
      for (let c = 0; c < bpp; c++) {
        if (pixels[i + c] !== first[c]) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
