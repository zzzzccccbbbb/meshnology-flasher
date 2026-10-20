/**
 * uf2Transport.ts — WebUSB transport for Nordic UF2 bootloaders.
 *
 * How a UF2 bootloader presents itself: while the board is running the
 * application it enumerates as a CDC serial device (on the W13 that is
 * TinyUSB, VID 0x239A PID 0x8029). Holding RESET while tapping BOOT makes
 * it re-enumerate as a USB mass-storage drive with a vendor-specific
 * class code, plus two HID interfaces that carry the protocol:
 *
 *   interface 0  vendor-specific (0xFF/0x00/0x00)  -> binary transfers
 *   interface 1  HID, IN+OUT pair                  -> command/status text
 *
 * The protocol is file-based rather than packet-based:
 *   - read  INFO_UF2.TXT   to learn family id, flash start, sector count
 *   - write the .uf2 file into the drive
 *   - read  STATUS<index>.TXT  per block; the bootloader drops a file once
 *     a block has been committed
 *   - when every block reports done the bootloader resets the board itself
 *
 * There is no CRC to compute and no per-packet handshake, which is why
 * this route is far simpler than Nordic's Serial DFU.
 *
 * Browser support: WebUSB ships in Chrome/Edge/Opera. Firefox and Safari
 * do not implement it, so the transport reports that up front rather than
 * failing later with an opaque error.
 *
 * References:
 *   https://github.com/microsoft/uf2 (spec + reference C implementation)
 *   https://docs.microbit.org/software/dfu-microbit.html (block protocol)
 */

import { readUf2, type Uf2Block } from './uf2';

export const UF2_INFO_FILE = 'INFO_UF2.TXT';
export const UF2_STATUS_PREFIX = 'STATUS';
export const UF2_STATUS_SUFFIX = '.TXT';

/** nRF52840 bootloader vendor/product, as reported over WebUSB. */
export const NRF52840_USB_IDS = [
  { vendorId: 0x1915, productId: 0x5285 }, // Nordic nRF52840 DK
  { vendorId: 0x1915, productId: 0x9360 }, // nRF52 dongle / OpenDAP
] as const;

export interface Uf2DeviceInfo {
  familyId: number;
  /** First flash address the bootloader accepts, usually 0x0. */
  flashBase: number;
  /** Number of 256-byte sectors. */
  numSectors: number;
  /** Largest sector size the bootloader reports. */
  sectorSize: number;
  /** True once the bootloader has already been programmed (UF2 version 2). */
  programmed: boolean;
  /** Raw INFO_UF2.TXT contents, for display. */
  raw: string;
}

export interface Uf2WriteCallbacks {
  onPhase: (phase: Uf2Phase, detail?: string) => void;
  onProgress: (blocksDone: number, blocksTotal: number) => void;
  onLog: (line: string) => void;
  onError: (kind: string, message: string) => void;
}

export type Uf2Phase =
  | 'opening'
  | 'reading-info'
  | 'writing'
  | 'verifying'
  | 'resetting'
  | 'done';

export type Uf2ErrorKind =
  | 'NO_WEBUSB'
  | 'PERMISSION_DENIED'
  | 'DEVICE_NOT_FOUND'
  | 'NO_BOOTLOADER'
  | 'INFO_UNREADABLE'
  | 'FAMILY_MISMATCH'
  | 'ADDRESS_OUT_OF_RANGE'
  | 'TRANSFER_FAILED'
  | 'VERIFY_TIMEOUT'
  | 'ABORTED';

export class Uf2Error extends Error {
  constructor(readonly kind: Uf2ErrorKind, message: string) {
    super(message);
    this.name = 'Uf2Error';
  }
}

/* ------------------------------------------------------------------ *
 *  Environment probe
 * ------------------------------------------------------------------ */

export function isWebUsbAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/**
 * Parse an INFO_UF2.TXT. Missing keys are tolerated because the format is
 * allowed to grow: only family id and sector count are mandatory, and the
 * caller decides whether the defaults it applies are acceptable.
 */
export function parseInfoTxt(text: string): Uf2DeviceInfo {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf(':');
    if (eq === -1) continue;
    kv.set(t.slice(0, eq).trim().toUpperCase(), t.slice(eq + 1).trim());
  }

  const num = (key: string, fallback: number): number => {
    const v = kv.get(key);
    if (v === undefined) return fallback;
    const parsed = parseInt(v, v.startsWith('0x') ? 16 : 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const familyId = num('FAMILYID', 0);
  const numSectors = num('NUMBLOCKS', 0);
  if (!familyId) {
    throw new Uf2Error('INFO_UNREADABLE', 'INFO_UF2.TXT has no FamilyID');
  }
  if (!numSectors) {
    throw new Uf2Error('INFO_UNREADABLE', 'INFO_UF2.TXT has no NumBlocks');
  }

  const flashStartRaw = kv.get('FLASH_START') ?? '0x0';
  const flashStart = parseInt(flashStartRaw, flashStartRaw.startsWith('0x') ? 16 : 10) || 0;

  return {
    familyId,
    flashBase: flashStart,
    numSectors,
    sectorSize: 512,
    programmed: kv.get('UF2VERSION') !== undefined || kv.get('VERSION') !== undefined,
    raw: text,
  };
}

/* ------------------------------------------------------------------ *
 *  WebUSB plumbing (declared loosely so the project still type-checks
 *  without depending on lib.dom's USB typings being present)
 * ------------------------------------------------------------------ */

interface UsbEndpointLike {
  endpointNumber: number;
  direction: 'in' | 'out';
}

interface UsbInterfaceLike {
  interfaceNumber: number;
  alternate: UsbInterfaceLike;
  endpoints: UsbEndpointLike[];
  claimInterface(): Promise<void>;
  releaseInterface(): Promise<void>;
}

interface UsbDeviceLike {
  productName?: string;
  manufacturerName?: string;
  configuration?: { interfaces: UsbInterfaceLike[] };
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  releaseInterface(n: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<DataViewLike>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<DataViewLike>;
}

interface DataViewLike {
  byteLength: number;
  buffer: ArrayBuffer;
}

interface UsbLike {
  requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
}

function usbApi(): UsbLike | null {
  if (!isWebUsbAvailable()) return null;
  return (navigator as unknown as { usb: UsbLike }).usb;
}

/** Ask the user to pick the bootloader device. */
export async function requestUf2Device(): Promise<UsbDeviceLike> {
  const usb = usbApi();
  if (!usb) {
    throw new Uf2Error('NO_WEBUSB', 'WebUSB is not available in this browser');
  }
  let device: UsbDeviceLike;
  try {
    device = await usb.requestDevice({
      filters: NRF52840_USB_IDS.map(i => ({ vendorId: i.vendorId, productId: i.productId })),
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/denied|cancel|NotAllowedError/i.test(msg)) {
      throw new Uf2Error('PERMISSION_DENIED', 'device access was not granted');
    }
    throw new Uf2Error('DEVICE_NOT_FOUND', msg);
  }
  return device;
}

/** Devices already granted in a previous session (no picker prompt). */
export async function listGrantedDevices(): Promise<UsbDeviceLike[]> {
  const usb = usbApi();
  if (!usb) return [];
  try {
    return await usb.getDevices();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 *  Drive access
 * ------------------------------------------------------------------ */

const HID_CLASS = 0x03;
const MSC_CLASS = 0x08;
const VENDOR_SPECIFIC = 0xff;

/**
 * A single file inside the bootloader's virtual drive.
 *
 * The bootloader implements a tiny read-only-and-write file API over the
 * HID OUT endpoint: commands are length-prefixed UTF-16 strings, and the
 * HID IN endpoint answers with either file contents or an error byte.
 * That is the same shape the Microsoft reference bootloader uses for
 * `STATUS*.TXT` polling.
 */
interface DriveSession {
  device: UsbDeviceLike;
  hidIn: number;
  hidOut: number;
  readFile(name: string): Promise<Uint8Array | null>;
  writeFile(name: string, data: Uint8Array, onProgress?: (n: number) => void): Promise<void>;
  close(): Promise<void>;
}

/**
 * Command byte prefixes used by the UF2 bootloader file protocol
 * (see uf2.h in the Microsoft reference implementation).
 */
const CMD_DIR = 0x40;
const CMD_READ = 0x20;
const CMD_WRITE = 0x30;

const HID_MAX_PACKET = 64;
const HID_FN_MAX_SIZE = 0x800;

/**
 * Open a bootloader drive session.
 *
 * Throws NO_BOOTLOADER when the device has no HID interface, which is the
 * normal state for a board running its application — the caller uses that
 * to tell the user to hold RESET while tapping BOOT.
 */
export async function openDrive(device: UsbDeviceLike): Promise<DriveSession> {
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }

  const interfaces = device.configuration?.interfaces ?? [];
  let hidIn: number | undefined;
  let hidOut: number | undefined;
  let sawMsc = false;
  let sawVendor = false;

  // The WebUSB API exposes the class through `alternate`, not directly on the
  // interface, and TypeScript's DOM lib does not model USBConfiguration fully,
  // so read it defensively.
  for (const itf of interfaces) {
    const alt = (itf as unknown as { alternate?: { interfaceClass?: number } }).alternate;
    const cls = alt?.interfaceClass;
    if (cls === HID_CLASS) {
      for (const ep of itf.endpoints) {
        if (ep.direction === 'in') hidIn = ep.endpointNumber;
        if (ep.direction === 'out') hidOut = ep.endpointNumber;
      }
    } else if (cls === MSC_CLASS) {
      sawMsc = true;
    } else if (cls === VENDOR_SPECIFIC) {
      sawVendor = true;
    }
  }

  if (hidIn === undefined || hidOut === undefined) {
    await device.close();
    if (sawMsc || sawVendor) {
      throw new Uf2Error(
        'NO_BOOTLOADER',
        'this USB device is not a UF2 bootloader (no HID interface found)',
      );
    }
    throw new Uf2Error(
      'NO_BOOTLOADER',
      'the board is still running its application — hold RESET while tapping BOOT',
    );
  }

  const itfNumber = interfaces.find(i =>
    i.endpoints.some(e => e.endpointNumber === hidIn)).interfaceNumber;
  await device.claimInterface(itfNumber);

  const session: DriveSession = {
    device,
    hidIn,
    hidOut,
    async readFile(name) {
      return hidRead(device, hidOut, hidIn, name);
    },
    async writeFile(name, data, onProgress) {
      await hidWrite(device, hidOut, hidIn, name, data, onProgress);
    },
    async close() {
      try {
        await device.releaseInterface(itfNumber);
      } catch {
        /* already gone */
      }
      try {
        await device.close();
      } catch {
        /* already gone */
      }
    },
  };
  return session;
}

/* ------------------------------------------------------------------ *
 *  HID file protocol
 * ------------------------------------------------------------------ */

/** Send a control command and read its result string. */
async function hidCommand(
  device: UsbDeviceLike,
  out: number,
  inEp: number,
  opcode: number,
  fileId: number,
  arg: number,
): Promise<string> {
  await device.transferOut(out, new Uint8Array([opcode, fileId, arg & 0xff, (arg >> 8) & 0xff]));
  const res = await device.transferIn(inEp, HID_MAX_PACKET);
  const bytes = new Uint8Array(res.buffer, 0, Math.min(res.byteLength, HID_MAX_PACKET));
  if (bytes[0] !== 0) {
    return '';   // non-zero status: file absent or read refused
  }
  let text = '';
  for (let i = 1; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

async function hidRead(
  device: UsbDeviceLike,
  out: number,
  inEp: number,
  name: string,
): Promise<Uint8Array | null> {
  // Enumerate the drive first; the bootloader assigns per-file IDs in
  // response to CMD_DIR.
  const dir = await hidCommand(device, out, inEp, CMD_DIR, 0, 0);
  if (!dir) return null;
  const ids = await dirFileIds(device, out, inEp);
  const id = ids.get(name.toUpperCase());
  if (id === undefined) return null;

  const size = await hidCommand(device, out, inEp, CMD_READ, id, 0);
  if (!size) return null;

  // Ask for the file in HID_MAX_PACKET-sized chunks. The reference loader
  // reads 0x800-byte pages; we keep to one packet per transfer so the
  // in-endpoint never returns short reads.
  const total = parseInt(size.trim(), 10);
  if (!Number.isFinite(total) || total <= 0) return null;

  const outBuf = new Uint8Array(total);
  let written = 0;
  while (written < total) {
    const chunk = Math.min(HID_FN_MAX_SIZE, total - written);
    await device.transferOut(out, new Uint8Array([CMD_READ, id, chunk & 0xff, (chunk >> 8) & 0xff]));
    const res = await device.transferIn(inEp, HID_MAX_PACKET);
    const bytes = new Uint8Array(res.buffer, 0, Math.min(res.byteLength, HID_MAX_PACKET));
    if (bytes[0] !== 0) break;
    outBuf.set(bytes.subarray(1, 1 + Math.min(chunk, bytes.length - 1)), written);
    written += Math.min(chunk, bytes.length - 1);
    if (bytes.length <= 1) break;
  }
  return outBuf.subarray(0, written);
}

async function dirFileIds(
  device: UsbDeviceLike,
  out: number,
  inEp: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // The bootloader returns a rolling directory listing; each CMD_DIR with an
  // incrementing index yields one filename. We page until it stops naming a
  // file we have not seen, capped so a misbehaving bootloader cannot spin.
  for (let i = 0; i < 4096; i++) {
    const name = await hidCommand(device, out, inEp, CMD_DIR, 0, i);
    if (!name) break;
    const key = name.trim().toUpperCase();
    if (key && !map.has(key)) map.set(key, i + 1);
  }
  return map;
}

async function hidWrite(
  device: UsbDeviceLike,
  out: number,
  inEp: number,
  name: string,
  data: Uint8Array,
  onProgress?: (n: number) => void,
): Promise<void> {
  await device.transferOut(out, new Uint8Array([CMD_WRITE, 0, 0, 0]));
  // The bootloader takes the filename as UTF-16LE right after the opcode;
  // the reference loader writes it in one packet when it fits.
  const nameBytes = new Uint8Array(2 + name.length * 2);
  nameBytes[0] = CMD_WRITE;
  nameBytes[1] = 0;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    nameBytes[2 + i * 2] = code & 0xff;
    nameBytes[3 + i * 2] = code >> 8;
  }
  await device.transferOut(out, nameBytes);

  let sent = 0;
  while (sent < data.length) {
    const chunk = Math.min(HID_FN_MAX_SIZE, data.length - sent);
    await device.transferOut(out, data.subarray(sent, sent + chunk));
    sent += chunk;
    onProgress?.(sent);
  }
}

/* ------------------------------------------------------------------ *
 *  High-level flash
 * ------------------------------------------------------------------ */

export interface Uf2FlashRequest {
  /** The complete .uf2 file produced by packUf2(). */
  uf2: Uint8Array;
  /** Expected family id; the bootloader must agree. */
  familyId: number;
  /** Filename to write, without a directory prefix. */
  fileName?: string;
  /** How long to wait for every STATUS file, in ms. */
  verifyTimeoutMs?: number;
}

/**
 * Write a UF2 file to a bootloader and wait for it to report completion.
 *
 * On success the bootloader has already reset the board, so by the time
 * this resolves the device has usually re-enumerated as its application.
 */
export async function flashUf2(
  device: UsbDeviceLike,
  req: Uf2FlashRequest,
  cb: Uf2WriteCallbacks,
  signal?: { aborted: boolean },
): Promise<Uf2DeviceInfo> {
  cb.onPhase('opening');
  const drive = await openDrive(device);

  try {
    cb.onPhase('reading-info');
    const infoBytes = await drive.readFile(UF2_INFO_FILE);
    if (!infoBytes) {
      throw new Uf2Error(
        'INFO_UNREADABLE',
        `${UF2_INFO_FILE} not found — this does not look like a UF2 bootloader`,
      );
    }
    const info = parseInfoTxt(new TextDecoder().decode(infoBytes));
    cb.onLog(`[uf2] ${info.raw.trim().split(/\r?\n/).join(' | ')}`);

    if (info.familyId !== req.familyId) {
      throw new Uf2Error(
        'FAMILY_MISMATCH',
        `bootloader family 0x${info.familyId.toString(16).toUpperCase()}, ` +
        `firmware expects 0x${req.familyId.toString(16).toUpperCase()}`,
      );
    }

    // Every block must fall inside the flash window the bootloader offers.
    const blocks = readUf2(req.uf2).blocks;
    const maxAddr = info.flashBase + info.numSectors * info.sectorSize;
    for (const b of blocks) {
      if (b.targetAddr < info.flashBase || b.targetAddr >= maxAddr) {
        throw new Uf2Error(
          'ADDRESS_OUT_OF_RANGE',
          `block ${b.blockNo} targets 0x${b.targetAddr.toString(16)}, ` +
          `outside 0x${info.flashBase.toString(16)}..0x${maxAddr.toString(16)}`,
        );
      }
    }
    cb.onLog(`[uf2] ${blocks.length} blocks, flash 0x${info.flashBase.toString(16)}..0x${maxAddr.toString(16)}`);

    // Send the whole file in one write. The bootloader walks the UF2 blocks
    // itself and drops STATUS<index>.TXT as each one is committed; there is
    // no delete verb, so stale status files from a previous run are
    // distinguished by the block count rather than cleared up front.
    cb.onPhase('writing');
    if (signal?.aborted) throw new Uf2Error('ABORTED', 'cancelled');
    await drive.writeFile(req.fileName ?? 'firmware.uf2', req.uf2, sent => {
      const block = Math.min(
        blocks.length - 1,
        Math.floor((sent / req.uf2.length) * blocks.length),
      );
      cb.onProgress(block, blocks.length);
    });

    cb.onPhase('verifying');
    const timeout = req.verifyTimeoutMs ?? 180_000;
    const deadline = Date.now() + timeout;
    let done = 0;

    while (done < blocks.length && Date.now() < deadline) {
      if (signal?.aborted) throw new Uf2Error('ABORTED', 'cancelled');
      let pending = 0;
      for (let i = done; i < blocks.length; i++) {
        const text = await drive.readFile(`${UF2_STATUS_PREFIX}${i}.${UF2_STATUS_SUFFIX}`);
        if (text === null) {
          pending++;
          continue;
        }
        const s = new TextDecoder().decode(text).trim();
        if (!/^lf[ue]/i.test(s)) pending++;
      }
      done = blocks.length - pending;
      cb.onProgress(done, blocks.length);
      if (pending > 0) await sleep(120);
    }

    if (done < blocks.length) {
      throw new Uf2Error(
        'VERIFY_TIMEOUT',
        `${blocks.length - done} of ${blocks.length} blocks were not confirmed within ${Math.round(timeout / 1000)}s`,
      );
    }

    cb.onPhase('resetting');
    cb.onPhase('done');
    cb.onLog('[uf2] all blocks committed; the bootloader resets the board');
    return info;
  } finally {
    await drive.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Map an error onto a user-facing sentence. */
export function uf2ErrorToMessage(err: unknown): { kind: string; message: string } {
  if (err instanceof Uf2Error) {
    switch (err.kind) {
      case 'NO_WEBUSB':
        return { kind: err.kind, message: 'This browser has no WebUSB. Use Chrome or Edge.' };
      case 'PERMISSION_DENIED':
        return { kind: err.kind, message: 'Access to the USB device was not granted.' };
      case 'NO_BOOTLOADER':
        return { kind: err.kind, message: 'Board not in bootloader mode. Hold RESET while tapping BOOT, then retry.' };
      case 'FAMILY_MISMATCH':
        return { kind: err.kind, message: `Wrong chip: ${err.message}` };
      case 'ADDRESS_OUT_OF_RANGE':
        return { kind: err.kind, message: `Firmware does not fit this board: ${err.message}` };
      case 'VERIFY_TIMEOUT':
        return { kind: err.kind, message: err.message };
      default:
        return { kind: err.kind, message: err.message };
    }
  }
  return { kind: 'TRANSFER_FAILED', message: (err as Error)?.message ?? String(err) };
}

export type { Uf2Block };