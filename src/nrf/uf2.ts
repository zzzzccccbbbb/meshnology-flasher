/**
 * uf2.ts — Intel HEX parsing and UF2 packaging for Nordic nRF boards.
 *
 * Why this exists: the W13 (nRF52840) ships a UF2 bootloader. When the board
 * is in bootloader mode it enumerates as a USB mass-storage drive, and
 * flashing is just "copy a .uf2 file onto it". The browser can do that over
 * WebUSB, so this module only has to turn a firmware image into a valid UF2
 * file — no Nordic DFU protocol state machine, no CRC-per-packet.
 *
 * UF2 block layout (512 bytes, little-endian):
 *   0  u32 magicStart0   = 0x0A324655 ("UF2\n")
 *   4  u32 magicStart1   = 0x9E5D5157
 *   8  u32 flags         bit0 = not main flash, bit1 = file container,
 *                            bit2 = familyID present, bit31 = MD5 checksum present
 *  12  u32 targetAddr    flash address this block carries
 *  16  u32 payloadSize   bytes used in payload (always 256)
 *  20  u32 blockNo       0-based index
 *  24  u32 numBlocks     total blocks in the file
 *  28  u32 fileSize      or familyID when flag bit2 is set
 *  32  u8[476] data      256 payload bytes then 220 bytes of magic padding
 * 508  u32 magicEnd      = 0x0AB16F30
 *
 * Only 476 of the 512 bytes carry information; the rest is the end marker so
 * a device can detect truncation. The payload is always 256 bytes and the
 * address always advances by 256, even when the source image has gaps —
 * gaps are filled with 0xFF, which is what a flash erase leaves behind.
 *
 * Reference: https://github.com/microsoft/uf2 (spec in UF2Formatter.md)
 */

/** Family ID for the nRF52840 bootloader (`-f 0xADA52840` in uf2conv). */
export const NRF52840_FAMILY_ID = 0xada52840;

const MAGIC_START0 = 0x0a324655;
const MAGIC_START1 = 0x9e5d5157;
const MAGIC_END = 0x0ab16f30;

const UF2_BLOCK_SIZE = 512;
const UF2_PAYLOAD_SIZE = 256;
const UF2_DATA_OFFSET = 32;
const UF2_MAGIC_END_OFFSET = 508;

/** Erased flash byte. */
const ERASED = 0xff;

const FLAG_NOT_MAIN_FLASH = 1 << 0;
const FLAG_FILE_CONTAINER = 1 << 1;
const FLAG_FAMILY_ID_PRESENT = 1 << 2;

export interface HexSegment {
  /** Flash address of the first byte. */
  address: number;
  data: Uint8Array;
}

export class HexParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
    this.name = 'HexParseError';
  }
}

/* ------------------------------------------------------------------ *
 *  Intel HEX
 * ------------------------------------------------------------------ */

/**
 * Parse an Intel HEX file into address-ordered segments.
 *
 * Record types handled: 00 (data), 01 (EOF), 02 (extended segment address),
 * 04 (extended linear address). Type 03/05 (start address records) are parsed
 * for record-length validation but carry no flash data.
 *
 * Data is returned in file order, not address order — callers that need
 * address order should sort. Overlapping records are kept as-is so the caller
 * can decide; uf2conv takes the later record too, matching Intel HEX
 * convention where later writes win.
 */
export function parseIntelHex(text: string): HexSegment[] {
  const segments: HexSegment[] = [];
  // Upper 16 bits of the address, set by type 04 records.
  let addressBase = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    if (raw[0] !== ':') {
      throw new HexParseError(`line ${i + 1}: record does not start with ':'`, i + 1);
    }

    const bytes = parseHexRecord(raw, i + 1);
    const count = bytes[0];
    const address = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const payload = bytes.subarray(4, 4 + count);

    // Verify the trailing checksum: sum of all bytes including the checksum
    // itself must be 0 mod 256.
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    if (sum !== 0) {
      throw new HexParseError(`line ${i + 1}: checksum mismatch`, i + 1);
    }

    switch (recordType) {
      case 0x00:
        segments.push({ address: addressBase + address, data: Uint8Array.from(payload) });
        break;
      case 0x01:
        // End of file. Anything after this is ignored by convention.
        return segments;
      case 0x02:
        if (count !== 2) throw new HexParseError(`line ${i + 1}: type 02 needs 2 bytes`, i + 1);
        // Segment address << 4 gives the base.
        addressBase = ((payload[0] << 8) | payload[1]) << 4;
        break;
      case 0x04:
        if (count !== 2) throw new HexParseError(`line ${i + 1}: type 04 needs 2 bytes`, i + 1);
        addressBase = (((payload[0] << 8) | payload[1]) << 16) >>> 0;
        break;
      case 0x03:
      case 0x05:
        // Start address records: no flash content.
        break;
      default:
        throw new HexParseError(`line ${i + 1}: unknown record type 0x${recordType.toString(16)}`, i + 1);
    }
  }

  if (segments.length === 0) {
    throw new HexParseError('no data records found');
  }
  return segments;
}

function parseHexRecord(line: string, lineNo: number): Uint8Array {
  const body = line.slice(1);
  if (body.length % 2 !== 0) {
    throw new HexParseError(`line ${lineNo}: odd number of hex digits`, lineNo);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexDigit(body[i * 2], lineNo);
    const lo = hexDigit(body[i * 2 + 1], lineNo);
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexDigit(ch: string, lineNo: number): number {
  const v = parseInt(ch, 16);
  if (Number.isNaN(v) || !/^[0-9a-fA-F]$/.test(ch)) {
    throw new HexParseError(`line ${lineNo}: invalid hex digit '${ch}'`, lineNo);
  }
  return v;
}

/* ------------------------------------------------------------------ *
 *  Sparse flash image
 * ------------------------------------------------------------------ */

/**
 * A sparse view of flash: a set of written ranges over an implied background
 * of 0xFF. Building this before packing means gaps in the HEX (which are
 * normal — linker scripts leave holes) become explicit 0xFF blocks instead
 * of silently shortening the image.
 */
export interface SparseImage {
  /** Inclusive start address. */
  start: number;
  /** Exclusive end address. */
  end: number;
  /** `end - start` bytes, reads as 0xFF outside the written ranges. */
  bytes: Uint8Array;
}

export function toSparseImage(segments: HexSegment[]): SparseImage {
  if (segments.length === 0) throw new HexParseError('no segments to pack');

  let start = Infinity;
  let end = 0;
  for (const s of segments) {
    if (s.data.length === 0) continue;
    start = Math.min(start, s.address);
    end = Math.max(end, s.address + s.data.length);
  }
  if (!Number.isFinite(start)) throw new HexParseError('all segments are empty');

  const size = end - start;
  // A whole-chip image is 1 MB; anything much larger is a bad HEX.
  if (size > 64 * 1024 * 1024) {
    throw new HexParseError(`image spans ${size} bytes, which is implausible`);
  }

  const bytes = new Uint8Array(size).fill(ERASED);
  for (const s of segments) {
    bytes.set(s.data, s.address - start);
  }
  return { start, end, bytes };
}

/**
 * Trim trailing 0xFF blocks. Nordic's bootloader happily accepts a UF2 full
 * of erased blocks, but dropping them shortens the transfer and the progress
 * bar stops climbing during a long flash of nothing.
 *
 * Only the final run is trimmed, and only in whole 256-byte payload units, so
 * no written data is ever discarded.
 */
export function trimTrailingErased(image: SparseImage): SparseImage {
  let end = image.end;
  const alignedEnd = image.start + Math.ceil((end - image.start) / UF2_PAYLOAD_SIZE) * UF2_PAYLOAD_SIZE;
  while (end > image.start && image.bytes[end - image.start - 1] === ERASED) {
    end--;
  }
  if (end === image.start) {
    throw new HexParseError('image is entirely 0xFF (erased)');
  }
  end = image.start + Math.ceil((end - image.start) / UF2_PAYLOAD_SIZE) * UF2_PAYLOAD_SIZE;
  // If trimming did not remove a whole block, keep the original extent.
  if (end >= alignedEnd) return image;
  return { start: image.start, end, bytes: image.bytes.subarray(0, end - image.start) };
}

/* ------------------------------------------------------------------ *
 *  UF2 packing
 * ------------------------------------------------------------------ */

export interface Uf2Options {
  /** Family ID written into byte 28. Required for main-flash blocks. */
  familyId?: number;
  /** Override numBlocks; only for tests. */
  numBlocksOverride?: number;
}

/**
 * Pack a sparse image into UF2 blocks.
 *
 * Every block carries exactly 256 payload bytes, so the last block of an
 * image whose length is not a multiple of 256 is padded with 0xFF up to the
 * payload boundary. Blocks never straddle a 256-byte boundary in flash either
 * — the address increments by 256 per block, which is what the bootloader
 * expects.
 */
export function packUf2(image: SparseImage, options: Uf2Options = {}): Uint8Array {
  const familyId = options.familyId ?? NRF52840_FAMILY_ID;
  const span = image.end - image.start;
  const numBlocks = Math.ceil(span / UF2_PAYLOAD_SIZE);

  const out = new Uint8Array(numBlocks * UF2_BLOCK_SIZE);
  const view = new DataView(out.buffer);

  for (let i = 0; i < numBlocks; i++) {
    const blockOffset = i * UF2_BLOCK_SIZE;
    const flashAddr = image.start + i * UF2_PAYLOAD_SIZE;

    view.setUint32(blockOffset + 0, MAGIC_START0, true);
    view.setUint32(blockOffset + 4, MAGIC_START1, true);
    view.setUint32(blockOffset + 8, FLAG_FAMILY_ID_PRESENT, true);
    view.setUint32(blockOffset + 12, flashAddr, true);
    view.setUint32(blockOffset + 16, UF2_PAYLOAD_SIZE, true);
    view.setUint32(blockOffset + 20, i, true);
    view.setUint32(blockOffset + 24, options.numBlocksOverride ?? numBlocks, true);
    view.setUint32(blockOffset + 28, familyId, true);

    // Payload, already 0xFF-filled by toSparseImage / the padding below.
    const srcStart = i * UF2_PAYLOAD_SIZE;
    const srcEnd = Math.min(srcStart + UF2_PAYLOAD_SIZE, span);
    if (srcEnd > srcStart) {
      out.set(image.bytes.subarray(srcStart, srcEnd), blockOffset + UF2_DATA_OFFSET);
    }

    view.setUint32(blockOffset + UF2_MAGIC_END_OFFSET, MAGIC_END, true);
  }

  return out;
}

/** Convenience: parse HEX text straight to a UF2 file. */
export function hexToUf2(text: string, options: Uf2Options = {}): Uint8Array {
  const image = trimTrailingErased(toSparseImage(parseIntelHex(text)));
  return packUf2(image, options);
}

/* ------------------------------------------------------------------ *
 *  UF2 reading (for the bootloader side / tests)
 * ------------------------------------------------------------------ */

export interface Uf2Block {
  targetAddr: number;
  blockNo: number;
  numBlocks: number;
  payload: Uint8Array;
}

export interface Uf2Info {
  blocks: Uf2Block[];
  familyId: number | null;
  fileSize: number;
}

/** Read a UF2 file back. Used by tests and by the verification page. */
export function readUf2(bytes: Uint8Array): Uf2Info {
  if (bytes.length % UF2_BLOCK_SIZE !== 0) {
    throw new Error(`UF2 length ${bytes.length} is not a multiple of ${UF2_BLOCK_SIZE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: Uf2Block[] = [];
  let familyId: number | null = null;
  let fileSize = 0;

  for (let off = 0; off < bytes.length; off += UF2_BLOCK_SIZE) {
    const m0 = view.getUint32(off + 0, true);
    const m1 = view.getUint32(off + 4, true);
    const mEnd = view.getUint32(off + UF2_MAGIC_END_OFFSET, true);
    if (m0 !== MAGIC_START0 || m1 !== MAGIC_START1 || mEnd !== MAGIC_END) {
      throw new Error(`block ${off / UF2_BLOCK_SIZE}: bad UF2 magic`);
    }
    const flags = view.getUint32(off + 8, true);
    const targetAddr = view.getUint32(off + 12, true);
    const payloadSize = view.getUint32(off + 16, true);
    const blockNo = view.getUint32(off + 20, true);
    const numBlocks = view.getUint32(off + 24, true);
    if (payloadSize !== UF2_PAYLOAD_SIZE) {
      throw new Error(`block ${blockNo}: payload size ${payloadSize}, expected ${UF2_PAYLOAD_SIZE}`);
    }
    if (flags & FLAG_FAMILY_ID_PRESENT) {
      const fid = view.getUint32(off + 28, true);
      familyId = familyId === null ? fid : familyId;
      fileSize = Math.max(fileSize, fid);
    }
    blocks.push({
      targetAddr,
      blockNo,
      numBlocks,
      payload: bytes.subarray(off + UF2_DATA_OFFSET, off + UF2_DATA_OFFSET + UF2_PAYLOAD_SIZE),
    });
  }

  return { blocks, familyId, fileSize };
}