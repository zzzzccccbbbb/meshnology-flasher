import { describe, it, expect } from 'vitest';
import {
  parseIntelHex,
  toSparseImage,
  trimTrailingErased,
  packUf2,
  hexToUf2,
  readUf2,
  NRF52840_FAMILY_ID,
  HexParseError,
} from './uf2';

/** Build a valid Intel HEX record: :LLAAAATT<data><checksum> */
function rec(addr: number, type: number, data: number[] = []): string {
  const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
  const sum = bytes.reduce((a, b) => (a + b) & 0xff, 0);
  const check = (0x100 - sum) & 0xff;
  return ':' + [...bytes, check].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('parseIntelHex', () => {
  it('parses a simple data record', () => {
    const segs = parseIntelHex([rec(0x1000, 0, [1, 2, 3, 4]), rec(0, 1)].join('\n'));
    expect(segs).toHaveLength(1);
    expect(segs[0].address).toBe(0x1000);
    expect([...segs[0].data]).toEqual([1, 2, 3, 4]);
  });

  it('applies extended linear address (type 04)', () => {
    const segs = parseIntelHex([
      rec(0, 4, [0x00, 0x27]),          // upper 16 bits -> base 0x270000
      rec(0x0000, 0, [0xaa, 0xbb]),    // -> 0x270000
      rec(0, 1),
    ].join('\n'));
    expect(segs[0].address).toBe(0x270000);
  });

  it('applies extended segment address (type 02)', () => {
    const segs = parseIntelHex([
      rec(0, 2, [0x12, 0x34]),          // base = 0x1234 << 4 = 0x12340
      rec(0, 0, [0x11]),
      rec(0, 1),
    ].join('\n'));
    expect(segs[0].address).toBe(0x12340);
  });

  it('ignores start-address records (03/05)', () => {
    const segs = parseIntelHex([
      rec(0, 3, [0, 0, 0, 0]),
      rec(0x100, 0, [0xde, 0xad]),
      rec(0, 5, [0, 0, 0, 0]),
      rec(0, 1),
    ].join('\n'));
    expect(segs).toHaveLength(1);
    expect([...segs[0].data]).toEqual([0xde, 0xad]);
  });

  it('stops at the EOF record', () => {
    const segs = parseIntelHex([
      rec(0, 0, [1]),
      rec(0, 1),
      rec(0, 0, [2]),   // should be ignored
    ].join('\n'));
    expect(segs).toHaveLength(1);
  });

  it('rejects a bad checksum', () => {
    expect(() => parseIntelHex(':0100000001FF00')).toThrow(HexParseError);
  });

  it('rejects a non-hex character', () => {
    expect(() => parseIntelHex(':0100000001ZZ')).toThrow(/invalid hex digit/);
  });

  it('rejects a record without a leading colon', () => {
    expect(() => parseIntelHex('0100000001FF')).toThrow(/does not start with/);
  });

  it('rejects an odd digit count', () => {
    expect(() => parseIntelHex(':0100000001F')).toThrow(/odd number/);
  });

  it('rejects an unknown record type', () => {
    expect(() => parseIntelHex(rec(0, 9, [1]) + '\n' + rec(0, 1))).toThrow(/unknown record type/);
  });

  it('rejects an empty file', () => {
    expect(() => parseIntelHex('\n\n')).toThrow(/no data records/);
  });

  it('tolerates CRLF and blank lines', () => {
    const segs = parseIntelHex('\r\n' + rec(0x200, 0, [7]) + '\r\n\r\n' + rec(0, 1) + '\r\n');
    expect(segs).toHaveLength(1);
    expect(segs[0].address).toBe(0x200);
  });
});

describe('toSparseImage', () => {
  it('fills gaps between segments with 0xFF', () => {
    const segs = parseIntelHex([
      rec(0, 0, [0x11, 0x22]),
      rec(4, 0, [0x33]),
      rec(0, 1),
    ].join('\n'));
    const img = toSparseImage(segs);
    expect(img.start).toBe(0);
    expect(img.end).toBe(5);
    expect([...img.bytes]).toEqual([0x11, 0x22, 0xff, 0xff, 0x33]);
  });

  it('honours the address base when computing start', () => {
    const segs = parseIntelHex([rec(0, 4, [0x00, 0x27]), rec(0x100, 0, [1]), rec(0, 1)].join('\n'));
    const img = toSparseImage(segs);
    // Type 04 sets the upper 16 bits: 0x0027 << 16 = 0x270000.
    // The data record then sits at +0x100 within that page.
    expect(img.start).toBe(0x270100);
    expect(img.end).toBe(0x270101);
  });

  it('rejects an all-empty segment list', () => {
    expect(() => toSparseImage([])).toThrow(/no segments/);
  });
});

describe('trimTrailingErased', () => {
  it('drops whole trailing 0xFF blocks', () => {
    const bytes = new Uint8Array(256 * 3);
    bytes.fill(0xff);
    bytes.set([1, 2, 3], 0);
    const trimmed = trimTrailingErased({ start: 0, end: 768, bytes });
    expect(trimmed.end).toBe(256);
    expect(trimmed.bytes).toHaveLength(256);
  });

  it('rounds up to a full payload block', () => {
    const bytes = new Uint8Array(256);
    bytes.fill(0xff);
    bytes.set([9], 10);           // last written byte at 0x0a
    const trimmed = trimTrailingErased({ start: 0, end: 256, bytes });
    expect(trimmed.end).toBe(256); // whole block kept, block has real data
  });

  it('rejects an entirely erased image', () => {
    const bytes = new Uint8Array(512).fill(0xff);
    expect(() => trimTrailingErased({ start: 0, end: 512, bytes })).toThrow(/entirely 0xFF/);
  });
});

describe('packUf2', () => {
  const makeImage = (len: number, fill = 0xaa) => ({
    start: 0x27000,
    end: 0x27000 + len,
    bytes: new Uint8Array(len).fill(fill),
  });

  it('emits ceil(len/256) blocks of 512 bytes', () => {
    expect(packUf2(makeImage(256)).length).toBe(512);
    expect(packUf2(makeImage(257)).length).toBe(1024);
    expect(packUf2(makeImage(512)).length).toBe(1024);
    expect(packUf2(makeImage(513)).length).toBe(1536);
  });

  it('writes the three magics and the family id', () => {
    const uf2 = packUf2(makeImage(256));
    const v = new DataView(uf2.buffer);
    expect(v.getUint32(0, true)).toBe(0x0a324655);
    expect(v.getUint32(4, true)).toBe(0x9e5d5157);
    expect(v.getUint32(508, true)).toBe(0x0ab16f30);
    expect(v.getUint32(8, true) & (1 << 2)).toBeTruthy();   // familyID present
    expect(v.getUint32(28, true)).toBe(NRF52840_FAMILY_ID);
  });

  it('advances targetAddr by 256 per block', () => {
    const uf2 = packUf2(makeImage(512));
    const v = new DataView(uf2.buffer);
    expect(v.getUint32(12, true)).toBe(0x27000);
    expect(v.getUint32(512 + 12, true)).toBe(0x27100);
  });

  it('numbers blocks from 0 and reports the total', () => {
    const uf2 = packUf2(makeImage(512));
    const v = new DataView(uf2.buffer);
    expect(v.getUint32(20, true)).toBe(0);
    expect(v.getUint32(24, true)).toBe(2);
    expect(v.getUint32(512 + 20, true)).toBe(1);
  });

  it('pads the final partial payload with 0xFF', () => {
    const uf2 = packUf2(makeImage(300));
    // bytes 268..299 are real, 300..511 in the payload must be 0xFF
    const tail = uf2.subarray(32 + 300, 32 + 256);
    expect(tail.every(b => b === 0xff)).toBe(true);
  });

  it('round-trips through readUf2', () => {
    const img = makeImage(512, 0x5a);
    const info = readUf2(packUf2(img));
    expect(info.blocks).toHaveLength(2);
    expect(info.familyId).toBe(NRF52840_FAMILY_ID);
    expect(info.blocks[0].targetAddr).toBe(0x27000);
    expect(info.blocks[1].targetAddr).toBe(0x27100);
    expect([...info.blocks[0].payload]).toEqual([...img.bytes.subarray(0, 256)]);
    expect([...info.blocks[1].payload]).toEqual([...img.bytes.subarray(256, 512)]);
  });

  it('rejects a corrupt magic when read back', () => {
    const uf2 = packUf2(makeImage(256));
    uf2[0] ^= 0xff;
    expect(() => readUf2(uf2)).toThrow(/bad UF2 magic/);
  });

  it('rejects a truncated file', () => {
    expect(() => readUf2(new Uint8Array(100))).toThrow(/multiple of 512/);
  });

  it('rejects a wrong payload size', () => {
    const uf2 = packUf2(makeImage(256));
    new DataView(uf2.buffer).setUint32(16, 128, true);
    expect(() => readUf2(uf2)).toThrow(/payload size/);
  });
});

describe('hexToUf2', () => {
  it('parses, packs and reads back in one call', () => {
    const hex = [
      rec(0, 4, [0x00, 0x27]),           // upper 16 bits -> base 0x270000
      rec(0, 0, Array.from({ length: 16 }, (_, i) => i)),
      rec(0x10, 0, [0xff]),
      rec(0, 1),
    ].join('\n');
    const info = readUf2(hexToUf2(hex));
    expect(info.familyId).toBe(NRF52840_FAMILY_ID);
    expect(info.blocks).toHaveLength(1);
    expect(info.blocks[0].targetAddr).toBe(0x270000);
    expect([...info.blocks[0].payload.subarray(0, 16)])
      .toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
});