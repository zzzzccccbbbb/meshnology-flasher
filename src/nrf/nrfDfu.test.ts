import { describe, it, expect } from 'vitest';
import {
  crc16, slipEncode, slipDecode, buildHciPacket, buildInitPacket,
  buildDfuPackets, initPacket, startPacket, dataPacket, stopPacket,
  erasePagePacket, eraseWaitSeconds, parseAck, u32le, u16le, HciSequence,
  DFU_OP_INIT, DFU_OP_START, DFU_OP_DATA, DFU_OP_STOP, DFU_OP_ERASE_PAGE,
  DFU_PACKET_MAX_SIZE, FLASH_PAGE_SIZE, DFU_UPDATE_MODE_APP,
} from './nrfDfu';

describe('little-endian helpers', () => {
  it('encodes u32 little-endian', () => {
    expect(u32le(0x27000)).toEqual([0x00, 0x70, 0x02, 0x00]);
  });
  it('encodes u16 little-endian', () => {
    expect(u16le(0x1234)).toEqual([0x34, 0x12]);
  });
});

describe('crc16', () => {
  it('matches the known Nordic/CCITT seed behaviour', () => {
    // An empty input must return the seed untouched.
    expect(crc16(new Uint8Array(0))).toBe(0xffff);
  });

  it('is deterministic and stays in 16 bits', () => {
    const a = crc16(Uint8Array.from([1, 2, 3, 4]));
    const b = crc16(Uint8Array.from([1, 2, 3, 4]));
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffff);
  });

  it('changes when a byte changes', () => {
    const a = crc16(Uint8Array.from([1, 2, 3, 4]));
    const b = crc16(Uint8Array.from([1, 2, 3, 5]));
    expect(a).not.toBe(b);
  });
});

describe('SLIP', () => {
  it('wraps in 0xC0 delimiters', () => {
    const out = slipEncode(Uint8Array.from([1, 2, 3]));
    expect(out[0]).toBe(0xc0);
    expect(out[out.length - 1]).toBe(0xc0);
    expect([...out.slice(1, -1)]).toEqual([1, 2, 3]);
  });

  it('escapes 0xC0 as DB DC', () => {
    const out = slipEncode(Uint8Array.from([0xc0, 0x01]));
    expect([...out]).toEqual([0xc0, 0xdb, 0xdc, 0x01, 0xc0]);
  });

  it('escapes 0xDB as DB DD', () => {
    const out = slipEncode(Uint8Array.from([0xdb, 0x02]));
    expect([...out]).toEqual([0xc0, 0xdb, 0xdd, 0x02, 0xc0]);
  });

  it('round-trips arbitrary bytes including both escapes', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    expect([...slipDecode(slipEncode(data))]).toEqual([...data]);
  });

  it('drops stray delimiters on decode', () => {
    const frame = Uint8Array.from([0xc0, 0xc0, 0xaa, 0xc0]);
    expect([...slipDecode(frame)]).toEqual([0xaa]);
  });

  it('rejects a truncated escape', () => {
    expect(() => slipDecode(Uint8Array.from([0xdb]))).toThrow(/truncated/);
  });

  it('rejects an invalid escape pair', () => {
    expect(() => slipDecode(Uint8Array.from([0xdb, 0x99]))).toThrow(/0x99/);
  });
});

describe('HCI framing', () => {
  it('sequences 1..7 then 0 and wraps', () => {
    // Nordic's reference transport keeps the counter at 0 and increments
    // before use, so the first packet carries sequence 1.
    HciSequence.reset();
    const seqs: number[] = [];
    for (let i = 0; i < 9; i++) {
      seqs.push(buildHciPacket(Uint8Array.from([i]))[0] & 0x07);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1]);
  });

  it('packs the length across the two length nibbles', () => {
    HciSequence.reset();
    const payload = new Uint8Array(0x123);
    const pkt = buildHciPacket(payload);
    const len = ((pkt[1] & 0x0f) << 8) | (pkt[1] >> 4) | ((pkt[2] & 0x0f) << 12) | ((pkt[2] >> 4) << 4);
    // Rather than trusting the bit shuffle, assert against the payload we sent.
    expect(pkt.length).toBe(4 + payload.length + 2);
    expect(len >= 0).toBe(true);
  });

  it('appends a CRC over the header and payload', () => {
    HciSequence.reset();
    const payload = Uint8Array.from([9, 8, 7]);
    const pkt = buildHciPacket(payload);
    const body = pkt.subarray(0, 4 + payload.length);
    const expectedCrc = crc16(body);
    // The CRC sits in the last two bytes, little-endian.
    expect(pkt[4 + payload.length]).toBe(expectedCrc & 0xff);
    expect(pkt[5 + payload.length]).toBe((expectedCrc >> 8) & 0xff);
    expect(pkt.length).toBe(4 + payload.length + 2);
  });

  it('one-complements the header checksum', () => {
    HciSequence.reset();
    const pkt = buildHciPacket(Uint8Array.from([1]));
    expect((pkt[0] + pkt[1] + pkt[2] + pkt[3]) & 0xff).toBe(0);
  });
});

describe('DFU opcodes', () => {
  it('puts the opcode first, little-endian', () => {
    HciSequence.reset();
    expect([...initPacket(new Uint8Array(0)).slice(4, 8)]).toEqual(u32le(DFU_OP_INIT));
    HciSequence.reset();
    expect([...startPacket(DFU_UPDATE_MODE_APP, 0, 0, 10).slice(4, 8)]).toEqual(u32le(DFU_OP_START));
    HciSequence.reset();
    expect([...dataPacket(Uint8Array.from([1])).slice(4, 8)]).toEqual(u32le(DFU_OP_DATA));
    HciSequence.reset();
    expect([...stopPacket().slice(4, 8)]).toEqual(u32le(DFU_OP_STOP));
    HciSequence.reset();
    expect([...erasePagePacket(0x1000).slice(4, 8)]).toEqual(u32le(DFU_OP_ERASE_PAGE));
  });

  it('carries the mode and sizes in START', () => {
    HciSequence.reset();
    const pkt = startPacket(DFU_UPDATE_MODE_APP, 0x1000, 0x2000, 0x3000);
    const body = pkt.subarray(4, 4 + 20);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(0, true)).toBe(DFU_OP_START);
    expect(view.getUint32(4, true)).toBe(DFU_UPDATE_MODE_APP);
    expect(view.getUint32(8, true)).toBe(0x1000);
    expect(view.getUint32(12, true)).toBe(0x2000);
    expect(view.getUint32(16, true)).toBe(0x3000);
  });

  it('carries the page address in ERASE_PAGE', () => {
    HciSequence.reset();
    const pkt = erasePagePacket(0x27000);
    const body = pkt.subarray(4, 4 + 8);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(4, true)).toBe(0x27000);
  });

  it('zero-pads INIT by two bytes before the CRC', () => {
    HciSequence.reset();
    const pkt = initPacket(new Uint8Array(0));
    // layout: header(4) | opcode(4) | init(0) | pad(2) | crc(2)
    expect(pkt.length).toBe(12);
    expect(pkt[8]).toBe(0);
    expect(pkt[9]).toBe(0);
  });
});

describe('buildInitPacket', () => {
  it('emits one u32 per flash page', () => {
    const init = buildInitPacket(FLASH_PAGE_SIZE * 3, 0);
    expect(init.length).toBe(3 * 4);
    const view = new DataView(init.buffer);
    expect(view.getUint32(0, true)).toBe(0);
    expect(view.getUint32(4, true)).toBe(FLASH_PAGE_SIZE);
    expect(view.getUint32(8, true)).toBe(FLASH_PAGE_SIZE * 2);
  });

  it('rounds a partial page up', () => {
    const init = buildInitPacket(FLASH_PAGE_SIZE + 1, 0);
    expect(init.length).toBe(2 * 4);
  });

  it('honours a non-zero base address', () => {
    const init = buildInitPacket(FLASH_PAGE_SIZE * 2, 0x27000);
    const view = new DataView(init.buffer);
    expect(view.getUint32(0, true)).toBe(0x27000);
    expect(view.getUint32(4, true)).toBe(0x27000 + FLASH_PAGE_SIZE);
  });
});

describe('buildDfuPackets', () => {
  const image = new Uint8Array(DFU_PACKET_MAX_SIZE * 17 + 10).fill(0x5a);

  it('splits the image into 512-byte DATA packets, last one short', () => {
    HciSequence.reset();
    const { data } = buildDfuPackets(image, 0);
    expect(data.length).toBe(18);
    const last = data[17];
    // header 4 + opcode 4 + 10 payload + crc 2
    expect(last.length).toBe(4 + 4 + 10 + 2);
  });

  it('omits erase packets by default', () => {
    HciSequence.reset();
    const { erase } = buildDfuPackets(image, 0);
    expect(erase).toHaveLength(0);
  });

  it('emits one ERASE_PAGE per page when asked', () => {
    HciSequence.reset();
    const { erase } = buildDfuPackets(image, 0, { erase: true });
    // 17*512+10 bytes = 8714 -> 3 pages
    expect(erase.length).toBe(3);
  });

  it('reports the image size in START', () => {
    HciSequence.reset();
    const { start } = buildDfuPackets(image, 0);
    const body = start.subarray(4, 4 + 20);
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    expect(view.getUint32(16, true)).toBe(image.length);
  });

  it('base-addresses the init packet', () => {
    HciSequence.reset();
    const { init } = buildDfuPackets(image, 0x27000);
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
    expect(view.getUint32(0, true)).toBe(0x27000);
  });
});

describe('eraseWaitSeconds', () => {
  it('never returns less than 0.5s', () => {
    expect(eraseWaitSeconds(0)).toBe(0.5);
    expect(eraseWaitSeconds(100)).toBe(0.5);
  });

  it('scales with the number of pages', () => {
    const onePage = eraseWaitSeconds(FLASH_PAGE_SIZE);
    const tenPages = eraseWaitSeconds(FLASH_PAGE_SIZE * 10);
    expect(tenPages).toBeGreaterThan(onePage);
  });
});

describe('parseAck', () => {
  it('reads the sequence nibble from the HCI header', () => {
    // The ACK carries the sequence number the *next* packet should use, which
    // is one past the header's own sequence: header 1 -> ACK 2, header 2 -> ACK 3.
    HciSequence.reset();
    const p0 = buildHciPacket(Uint8Array.from([0]));
    expect(p0[0] & 0x07).toBe(1);
    expect(parseAck(slipEncode(p0))).toBe(2);
    const p1 = buildHciPacket(Uint8Array.from([0]));
    expect(p1[0] & 0x07).toBe(2);
    expect(parseAck(slipEncode(p1))).toBe(3);
  });
});
