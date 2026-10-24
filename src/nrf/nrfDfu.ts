/**
 * nrfDfu.ts — Nordic's HCI/serial DFU protocol, in TypeScript.
 *
 * This is the transport MeshCore's flasher uses (adafruit-nrfutil style) and
 * it is a different protocol from the UF2 route in ./uf2Transport.ts. Three
 * layers stack up:
 *
 *   1. DFU opcodes. A packet starts with a little-endian uint32: 1 INIT,
 *      3 START, 4 DATA, 5 STOP, 6 ERASE_PAGE. The INIT packet is followed by
 *      the "init packet" binary (the .dat file), which lists every flash page
 *      the image occupies, little-endian uint32s.
 *   2. HCI framing. The DFU payload becomes an HCI packet: a 4-byte header
 *      (sequence | type | length | one's-complement checksum) then the data.
 *   3. SLIP. The HCI packet is wrapped in 0xC0 delimiters with 0xC0 -> DB DC
 *      and 0xDB -> DB DD escaping, because those two bytes would otherwise
 *      look like a frame boundary.
 *
 * Getting the board into DFU mode does not need a button. nRF52 devices
 * reboot into the bootloader when a serial port is opened at 1200 baud and
 * closed again — the "touch" reset. So the flow over Web Serial is:
 *   forceDfuMode -> open 115200 -> INIT -> START -> DATA* -> STOP
 *
 * Erase is not a separate action here: START already erases every page named
 * in the init packet, and ERASE_PAGE is only needed to wipe a range up front.
 *
 * Reference: flasher.meshcore.io/lib/dfu.js, itself adapted from
 * Adafruit's nrfutil and Nordic's dfu_transport_serial.py.
 */

/* ------------------------------------------------------------------ *
 *  Protocol constants
 * ------------------------------------------------------------------ */

export const DFU_OP_INIT = 1;
export const DFU_OP_START = 3;
export const DFU_OP_DATA = 4;
export const DFU_OP_STOP = 5;
export const DFU_OP_ERASE_PAGE = 6;

/** START command: application-only, no SoftDevice relocation. */
export const DFU_UPDATE_MODE_APP = 4;

export const DFU_PACKET_MAX_SIZE = 512;
export const FLASH_PAGE_SIZE = 4096;
/** nRF52840 worst-case erase time for one page, in seconds. */
export const FLASH_PAGE_ERASE_TIME = 0.0897;
/** nRF52840 worst-case word write time, in seconds. */
export const FLASH_WORD_WRITE_TIME = 0.0001;
export const FLASH_PAGE_WRITE_TIME = (FLASH_PAGE_SIZE / 4) * FLASH_WORD_WRITE_TIME;

/** Opening the port at this rate and closing it reboots an nRF52. */
export const DFU_TOUCH_BAUD = 1200;
export const DFU_BAUD = 115200;
export const SERIAL_PORT_OPEN_WAIT_TIME = 0.1;
export const TOUCH_RESET_WAIT_TIME = 1.5;
/** DTR is held low for this long before being released. */
export const DTR_LOW_MS = 50;
/** Settling time after the DTR edge. */
export const DTR_RESET_WAIT_MS = 100;

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;

/* ------------------------------------------------------------------ *
 *  LE helpers
 * ------------------------------------------------------------------ */

export function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

export function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/* ------------------------------------------------------------------ *
 *  CRC16 (CCITT, Nordic flavour)
 * ------------------------------------------------------------------ */

/**
 * CRC16 as used by Nordic's DFU packets: reflected CCITT with polynomial
 * 0x1021, seed 0xFFFF. Same function Adafruit's nrfutil uses.
 */
export function crc16(data: Uint8Array, seed = 0xffff): number {
  let crc = seed;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc >> 8) & 0x00ff) | ((crc << 8) & 0xff00);
    crc ^= data[i];
    crc ^= (crc & 0x00ff) >> 4;
    crc ^= (crc << 8) << 4;
    crc ^= ((crc & 0x00ff) << 4) << 1;
    crc &= 0xffff;
  }
  return crc & 0xffff;
}

/* ------------------------------------------------------------------ *
 *  SLIP
 * ------------------------------------------------------------------ */

export function slipEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [SLIP_END];
  for (const byte of data) {
    if (byte === SLIP_END) out.push(SLIP_ESC, SLIP_ESC_END);
    else if (byte === SLIP_ESC) out.push(SLIP_ESC, SLIP_ESC_ESC);
    else out.push(byte);
  }
  out.push(SLIP_END);
  return Uint8Array.from(out);
}

export function slipDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === SLIP_ESC) {
      i++;
      if (i >= data.length) throw new Error('SLIP escape sequence truncated');
      if (data[i] === SLIP_ESC_END) out.push(SLIP_END);
      else if (data[i] === SLIP_ESC_ESC) out.push(SLIP_ESC);
      else throw new Error(`SLIP escape followed by 0x${data[i].toString(16)}`);
    } else if (data[i] === SLIP_END) {
      // delimiter, ignore
    } else {
      out.push(data[i]);
    }
    i++;
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ *
 *  HCI framing
 * ------------------------------------------------------------------ */

/** Sequence numbers cycle 1..7 then back to 0; a static keeps them shared
 *  across packets.
 *
 *  The numbering starts at 1, not 0: Nordic's own reference implementation
 *  increments before use (HciPacket.sequence_number = (n + 1) % 8), and
 *  the bootloader computes the expected ACK from the same rule. Starting at
 *  0 makes every ACK mismatch by one.
 */
export class HciSequence {
  private static value = 0;
  static reset(): void {
    HciSequence.value = 0;
  }
  static next(): number {
    HciSequence.value = (HciSequence.value + 1) % 8;
    return HciSequence.value;
  }
}

/**
 * Wrap a DFU payload in an HCI packet.
 *
 * Header layout (all one byte):
 *   seq | ((seq+1) % 8) << 3 | dip << 6 | reliable << 7
 *   type | (length & 0x0f) << 4
 *   (length & 0x0ff0) >> 4
 *   ~(sum of the three above) & 0xff
 */
export function buildHciPacket(payload: Uint8Array, type = 14): Uint8Array {
  const seq = HciSequence.next();
  const length = payload.length;
  const b0 = seq | (((seq + 1) % 8) << 3);
  const b1 = type | ((length & 0x000f) << 4);
  const b2 = (length & 0x0ff0) >> 4;
  const b3 = (~(b0 + b1 + b2) + 1) & 0xff;

  const frame = new Uint8Array(4 + length);
  frame[0] = b0;
  frame[1] = b1;
  frame[2] = b2;
  frame[3] = b3;
  frame.set(payload, 4);

  // CRC goes after the payload, little-endian.
  const crc = crc16(frame);
  return Uint8Array.from([...frame, crc & 0xff, (crc >> 8) & 0xff]);
}

/* ------------------------------------------------------------------ *
 *  Init packet (the .dat file)
 * ------------------------------------------------------------------ */

/**
 * Build the DFU init packet.
 *
 * The init packet is the "firmware.dat" that ships inside a DFU package: a
 * fixed set of fields describing the image, not a page list.
 *
 *   u16 device_type
 *   u16 device_revision
 *   u32 application_version
 *   u16 count, then count * u16 softdevice_req
 *   u16 firmware_crc16
 *
 * A 14-byte packet with one SoftDevice requirement is what Adafruit's
 * nrfutil produces for the W13: 52 00 af ad ff ff ff ff 01 00 23 01 69 ea.
 *
 * The bootloader reads the device type, revision, SoftDevice requirement and
 * CRC from it and refuses the write when the board does not match. The CRC
 * is over the *image*, and the SoftDevice requirement says which SoftDevice
 * must already be flashed.
 *
 * When a package carries its own .dat, that file is authoritative and is
 * used verbatim. This function is the fallback for a bare image, where the
 * caller has to supply the device identity and the CRC.
 */
export function buildInitPacket(opts: {
  deviceType: number;
  deviceRevision: number;
  applicationVersion?: number;
  softdeviceReq?: number[];
  firmwareCrc16: number;
}): Uint8Array {
  const req = opts.softdeviceReq ?? [];
  const out = new Uint8Array(12 + req.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, opts.deviceType & 0xffff, true);
  view.setUint16(2, opts.deviceRevision & 0xffff, true);
  view.setUint32(4, (opts.applicationVersion ?? 0xffffffff) >>> 0, true);
  view.setUint16(8, req.length, true);
  req.forEach((id, i) => view.setUint16(10 + i * 2, id & 0xffff, true));
  // The CRC sits in the last two bytes, little-endian.
  view.setUint16(10 + req.length * 2, opts.firmwareCrc16 & 0xffff, true);
  return out;
}

/* ------------------------------------------------------------------ *
 *  DFU packet builders
 * ------------------------------------------------------------------ */

export function initPacket(init: Uint8Array): Uint8Array {
  return buildHciPacket(Uint8Array.from([...u32le(DFU_OP_INIT), ...init, ...u16le(0)]));
}

export function startPacket(
  mode: number,
  softdeviceSize = 0,
  bootloaderSize = 0,
  appSize = 0,
): Uint8Array {
  return buildHciPacket(
    Uint8Array.from([
      ...u32le(DFU_OP_START),
      ...u32le(mode),
      ...u32le(softdeviceSize),
      ...u32le(bootloaderSize),
      ...u32le(appSize),
    ]),
  );
}

export function dataPacket(chunk: Uint8Array): Uint8Array {
  return buildHciPacket(Uint8Array.from([...u32le(DFU_OP_DATA), ...chunk]));
}

export function stopPacket(): Uint8Array {
  return buildHciPacket(Uint8Array.from(u32le(DFU_OP_STOP)));
}

export function erasePagePacket(pageAddress: number): Uint8Array {
  return buildHciPacket(
    Uint8Array.from([...u32le(DFU_OP_ERASE_PAGE), ...u32le(pageAddress)]),
  );
}

/** How long to wait after START for the pages it erases to finish. */
export function eraseWaitSeconds(totalBytes: number): number {
  return Math.max(0.5, ((totalBytes / FLASH_PAGE_SIZE) + 1) * FLASH_PAGE_ERASE_TIME);
}

/* ------------------------------------------------------------------ *
 *  Packets
 * ------------------------------------------------------------------ */

export interface DfuPackets {
  init: Uint8Array;
  start: Uint8Array;
  data: Uint8Array[];
  stop: Uint8Array;
  erase: Uint8Array[];
}

/**
 * Build the whole packet sequence for one image.
 *
 * `initPacket` is the raw firmware.dat content — device type, revision,
 * application version, SoftDevice requirement and the image CRC. It comes
 * from the DFU package when there is one; see buildInitPacket for the
 * fallback shape.
 *
 * With `erase` false the packets start erasing nothing extra: START already
 * erases exactly the pages named in the init packet. `erase` adds explicit
 * ERASE_PAGE packets first, which is what MeshCore's "Erase flash" does when
 * the user asks for a clean slate.
 *
 * The order the packets are *sent* in is not the order they appear here:
 * START goes first, then INIT, then the DATA run, then STOP. See
 * flashNrfDfu in dfuTransport.ts.
 */
export function buildDfuPackets(
  image: Uint8Array,
  initData: Uint8Array,
  startAddress: number,
  options: { erase?: boolean; mode?: number } = {},
): DfuPackets {
  const mode = options.mode ?? DFU_UPDATE_MODE_APP;

  const data: Uint8Array[] = [];
  for (let i = 0; i < image.length; i += DFU_PACKET_MAX_SIZE) {
    data.push(dataPacket(image.subarray(i, i + DFU_PACKET_MAX_SIZE)));
  }

  const erase: Uint8Array[] = [];
  if (options.erase) {
    const pageCount = Math.ceil(image.length / FLASH_PAGE_SIZE);
    for (let i = 0; i < pageCount; i++) {
      erase.push(erasePagePacket(startAddress + i * FLASH_PAGE_SIZE));
    }
  }

  return {
    init: initPacket(initData),
    start: startPacket(mode, 0, 0, image.length),
    data,
    stop: stopPacket(),
    erase,
  };
}

/** True when the bytes look like a Nordic bootloader ACK. */
export function parseAck(frame: Uint8Array): number {
  const decoded = slipDecode(frame);
  if (decoded.length < 2) throw new Error('ACK frame too short');
  // Strip the trailing CRC before looking at the sequence nibble.
  const header = decoded[0];
  return (header >> 3) & 0x07;
}
