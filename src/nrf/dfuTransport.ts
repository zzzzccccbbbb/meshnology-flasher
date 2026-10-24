/**
 * dfuTransport.ts — Web Serial driver for Nordic's HCI/DFU protocol.
 *
 * Replaces the UF2/WebUSB route for nRF52840. The difference matters for the
 * user: entering DFU here needs no button. Opening the port at 1200 baud and
 * closing it makes an nRF52 reboot into its bootloader on its own, so the
 * board stays plugged into the same USB cable the whole time. UF2 would have
 * required holding RESET while tapping BOOT.
 *
 * It also buys protocol-level erase, which UF2 has no equivalent of: START
 * erases exactly the pages named in the init packet, and ERASE_PAGE wipes an
 * arbitrary range before the write begins.
 *
 * The packet layer lives in ./nrfDfu.ts; this file only moves bytes.
 */

import {
  buildDfuPackets,
  eraseWaitSeconds,
  slipEncode,
  slipDecode,
  parseAck,
  HciSequence,
  DFU_TOUCH_BAUD,
  DFU_BAUD,
  SERIAL_PORT_OPEN_WAIT_TIME,
  TOUCH_RESET_WAIT_TIME,
  FLASH_PAGE_ERASE_TIME,
  FLASH_PAGE_WRITE_TIME,
  type DfuPackets,
} from './nrfDfu';

/** Payload bytes per DATA packet, excluding the 4-byte opcode. */
const DFU_PACKET_DATA = 512;

export type DfuPhase =
  | 'entering-dfu'
  | 'opening'
  | 'init'
  | 'start'
  | 'erasing'
  | 'writing'
  | 'finishing'
  | 'done';

export type DfuErrorKind =
  | 'NO_WEBSERIAL'
  | 'PERMISSION_DENIED'
  | 'NO_PORT'
  | 'NOT_IN_DFU'
  | 'ACK_MISMATCH'
  | 'TRANSFER_FAILED'
  | 'VERIFY_FAILED'
  | 'ABORTED';

export class DfuError extends Error {
  constructor(readonly kind: DfuErrorKind, message: string) {
    super(message);
    this.name = 'DfuError';
  }
}

export interface DfuCallbacks {
  onPhase: (phase: DfuPhase, detail?: string) => void;
  onProgress: (bytesSent: number, bytesTotal: number) => void;
  onLog: (line: string) => void;
  onError: (kind: string, message: string) => void;
}

export function isWebSerialAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/** Ask the user to pick the board's serial port. */
export async function requestDfuPort(): Promise<SerialPort> {
  if (!isWebSerialAvailable()) {
    throw new DfuError('NO_WEBSERIAL', 'Web Serial is not available in this browser');
  }
  try {
    return await navigator.serial.requestPort();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/denied|cancel|NotAllowedError/i.test(msg)) {
      throw new DfuError('PERMISSION_DENIED', 'serial port access was not granted');
    }
    throw new DfuError('NO_PORT', msg);
  }
}

/**
 * The port the board is on right now, if the browser already has permission.
 *
 * After a touch reset the board re-enumerates: the application CDC
 * disappears and the bootloader's CDC appears, often under a different
 * COM number. The SerialPort object we were handed refers to the old
 * instance and cannot be opened any more, so the bootloader has to be found
 * again among the permitted ports.
 *
 * Matching is by vendor/product id, and the DFU bootloader of an nRF52
 * reports the same 0x2FE3/0x0001 or 0x239A as the application, so the
 * candidate list is narrowed by vendor id and then the most recently
 * connected one is preferred — a board that just re-enumerated is the
 * newest.
 */
export async function findBootloaderPort(
  original: SerialPort,
  vendorIds: number[] = [0x2fe3, 0x239a, 0x1915],
): Promise<SerialPort> {
  if (!isWebSerialAvailable()) return original;
  let ports: SerialPort[] = [];
  try {
    ports = await navigator.serial.getPorts();
  } catch {
    return original;
  }
  if (ports.length <= 1) return original;

  const candidates: SerialPort[] = [];
  for (const p of ports) {
    try {
      const info = await p.getInfo();
      if (!info.usbVendorId) continue;
      if (vendorIds.includes(info.usbVendorId)) candidates.push(p);
    } catch {
      /* a port that cannot describe itself is not usable */
    }
  }
  if (candidates.length === 0) return original;

  // The original handle is still the best choice if it is in the list: it is
  // the one the user picked, and Chrome's Web Serial resolves a port by
  // vendor/product anyway.
  if (candidates.includes(original)) return original;
  return candidates[candidates.length - 1];
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * The other serial ports the browser already has permission for.
 *
 * After a board re-enumerates into its bootloader it may land on a
 * different COM number, and the handle we were handed then refers to a USB
 * instance that no longer exists. getPorts() lists what is currently
 * plugged in and permitted, so the new bootloader port shows up there.
 */
async function otherPermittedPorts(exclude: SerialPort): Promise<SerialPort[]> {
  if (!isWebSerialAvailable()) return [];
  let ports: SerialPort[] = [];
  try {
    ports = await navigator.serial.getPorts();
  } catch {
    return [];
  }
  return ports.filter(p => p !== exclude);
}

/* ------------------------------------------------------------------ *
 *  Link
 * ------------------------------------------------------------------ */

/**
 * One opened port plus the sequence bookkeeping the protocol needs.
 *
 * Every DFU packet is acknowledged; a mismatch means either the port was not
 * in DFU mode or a packet was lost, and both are unrecoverable here — the
 * bootloader has no resend. So the check is strict and fails loudly.
 */
export class DfuLink {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private lastAck = -1;
  private pending: number[] = [];

  constructor(private port: SerialPort) {}

  /** Point the link at a different port, e.g. after the board re-enumerated. */
  setPort(port: SerialPort): void {
    this.port = port;
  }

  /**
   * Reboot the board into DFU mode: open at 1200 baud, close, wait.
   *
   * The 1200-baud open is the trigger, not the data transfer — Nordic treats
   * it as a modem-control line change and resets into the bootloader.
   *
   * The board then re-enumerates: the application CDC disappears and the
   * bootloader's CDC takes its place, possibly with a different port number.
   * That takes a moment, and the port we were handed is briefly unusable, so
   * the caller has to retry rather than assume one open will do.
   */
  static async touchReset(port: SerialPort): Promise<void> {
    let touched = false;
    try {
      await port.open({ baudRate: DFU_TOUCH_BAUD });
      touched = true;
    } catch {
      // A board whose CDC is already open elsewhere cannot be touched. It may
      // already be sitting in DFU, so carry on and let the open below decide.
    }
    if (touched) {
      await sleep(SERIAL_PORT_OPEN_WAIT_TIME * 1000);
      try {
        await port.close();
      } catch {
        /* already closed */
      }
    }
    // Wait for the re-enumeration either way: if the touch did work the board
    // is rebooting, and if it did not the board may still be settling.
    await sleep(TOUCH_RESET_WAIT_TIME * 1000);
  }

  /**
   * Open the port, retrying while the board re-enumerates.
   *
   * Two failures dominate in practice:
   *   "Failed to open serial port"  — the board is mid-reset, the old handle
   *                                   is not usable yet
   *   "The port is already open"    — a previous attempt left the port open
   *                                   and the browser still holds it
   *
   * The second one needs a close first, so every failed attempt is followed
   * by a full close before the next open.
   *
   * The board may also have come back as a *different* port — the
   * bootloader's CDC often gets a new COM number. So each round also tries
   * the other ports the browser already has permission for, which is what
   * lets the write find the bootloader after a re-enumeration.
   */
  async openWithRetry(attempts = 12, delayMs = 500): Promise<void> {
    let lastError = '';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs);

      // Try the port we were given first, then any other permitted port.
      const candidates = [this.port, ...(await otherPermittedPorts(this.port))];

      for (const candidate of candidates) {
        try {
          this.port = candidate;
          await this.open();
          return;
        } catch (e) {
          lastError = (e as Error).message ?? String(e);
          // A half-open port blocks the next attempt, and the writer/reader
          // locks taken by a failed open stay attached to it. this.close()
          // releases both, in the right order.
          await this.close();
        }
      }
    }
    throw new DfuError(
      'NOT_IN_DFU',
      `could not open the serial port after ${attempts} tries: ${lastError}. ` +
      'The board may not be in DFU mode — double-tap RESET to enter the ' +
      'bootloader, then try again.',
    );
  }

  async open(): Promise<void> {
    await this.port.open({ baudRate: DFU_BAUD });
    HciSequence.reset();
    this.lastAck = -1;
    this.pending = [];
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  async close(): Promise<void> {
    try {
      await this.reader?.cancel();
    } catch { /* ignore */ }
    try {
      this.reader?.releaseLock();
    } catch { /* ignore */ }
    this.reader = null;
    try {
      await this.writer?.close();
    } catch { /* ignore */ }
    this.writer = null;
    try {
      await this.port.close();
    } catch { /* ignore */ }
  }

  /**
   * Send one framed packet and wait for its ACK.
   *
   * The bootloader answers with a two-delimiter SLIP frame. Bytes may arrive
   * with stale content before the opening 0xC0 (the reset banner, for
   * instance), so the reader counts delimiters rather than assuming the
   * first byte is one.
   */
  async send(packet: Uint8Array, timeoutMs = 5000): Promise<void> {
    if (!this.writer || !this.reader) throw new DfuError('TRANSFER_FAILED', 'port not open');

    await this.writer.write(slipEncode(packet));

    const expected = (this.lastAck + 1) % 8;
    const deadline = Date.now() + timeoutMs;
    let buffer: number[] = [];
    let delimiters = 0;

    while (delimiters < 2) {
      if (Date.now() > deadline) {
        throw new DfuError(
          'NOT_IN_DFU',
          'no response from the bootloader — the board may not be in DFU mode',
        );
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await this.reader.read();
      } catch {
        throw new DfuError('TRANSFER_FAILED', 'serial read failed');
      }
      if (chunk.done) {
        throw new DfuError('TRANSFER_FAILED', 'port closed while waiting for an ACK');
      }
      if (!chunk.value) continue;
      for (const byte of chunk.value) {
        buffer.push(byte);
        if (byte === 0xc0) delimiters++;
        // Bail out early if the board is spewing and no frame is forming.
        if (buffer.length > 4096) {
          throw new DfuError('TRANSFER_FAILED', 'received data without a frame delimiter');
        }
      }
    }

    const first = buffer.indexOf(0xc0);
    const second = buffer.indexOf(0xc0, first + 1);
    if (first === -1 || second === -1) {
      throw new DfuError('ACK_MISMATCH', 'incomplete ACK frame');
    }

    let decoded: Uint8Array;
    try {
      decoded = slipDecode(Uint8Array.from(buffer.slice(first + 1, second)));
    } catch (e) {
      throw new DfuError('ACK_MISMATCH', (e as Error).message);
    }
    if (decoded.length < 2) throw new DfuError('ACK_MISMATCH', 'ACK frame too short');

    const ack = parseAck(Uint8Array.from(buffer.slice(first + 1, second)));
    if (this.lastAck !== -1 && ack !== expected) {
      this.lastAck = -1;
      HciSequence.reset();
      throw new DfuError(
        'ACK_MISMATCH',
        `out-of-sequence ACK: expected ${expected}, got ${ack}`,
      );
    }
    this.lastAck = ack;
  }
}

/* ------------------------------------------------------------------ *
 *  High-level flash
 * ------------------------------------------------------------------ */

export interface DfuFlashRequest {
  /** Flat image: SoftDevice and application concatenated, as in the .hex. */
  image: Uint8Array;
  /** First flash address the image occupies. 0 for a merged image. */
  startAddress: number;
  /** Send explicit ERASE_PAGE packets before starting. */
  erase?: boolean;
  /**
   * Reboot the board into DFU first, by opening the port at 1200 baud and
   * closing it. Set this false when the user has already put the board into
   * the bootloader by hand — touching it then would reboot it out of DFU
   * and into the application again.
   */
  touchReset?: boolean;
  /** Give up after this long without progress, in ms. */
  timeoutMs?: number;
}

/**
 * Push an image into the bootloader.
 *
 * Sequence: INIT (the page list) -> [ERASE_PAGE *] -> START (which erases the
 * pages INIT named, so this is where the real erase happens) -> DATA* ->
 * STOP. The board reboots into its application on its own once STOP lands.
 */
export async function flashNrfDfu(
  port: SerialPort,
  req: DfuFlashRequest,
  cb: DfuCallbacks,
  signal?: { aborted: boolean },
): Promise<{ bytesWritten: number }> {
  if (req.image.length === 0) throw new DfuError('TRANSFER_FAILED', 'empty firmware image');

  const packets: DfuPackets = buildDfuPackets(req.image, req.startAddress, { erase: req.erase });
  const link = new DfuLink(port);
  let opened = false;

  try {
    if (req.touchReset !== false) {
      cb.onPhase('entering-dfu');
      cb.onLog('[dfu] 1200-baud touch reset to enter the bootloader');
      await DfuLink.touchReset(port);
      // The board re-enumerated, so the handle we were given may point at a
      // USB instance that no longer exists. Look for the bootloader again.
      const current = await findBootloaderPort(port);
      if (current !== port) {
        cb.onLog('[dfu] the board re-enumerated; using the re-found port');
        link.setPort(current);
      }
    } else {
      cb.onLog('[dfu] using the port as-is (no touch reset)');
    }
    if (signal?.aborted) throw new DfuError('ABORTED', 'cancelled');

    cb.onPhase('opening');
    // The board re-enumerates after the touch reset, so the handle can be
    // briefly unusable. Retry rather than fail on the first try.
    await link.openWithRetry();
    opened = true;
    cb.onLog(`[dfu] port open at ${DFU_BAUD} baud, ${packets.data.length} data packets`);

    const check = () => {
      if (signal?.aborted) throw new DfuError('ABORTED', 'cancelled');
    };

    cb.onPhase('init');
    check();
    await link.send(packets.init);
    cb.onLog(`[dfu] init packet: ${packets.init.length} bytes ` +
      `(${req.image.length} image bytes, base 0x${req.startAddress.toString(16)})`);

    if (packets.erase.length) {
      cb.onPhase('erasing');
      cb.onLog(`[dfu] erasing ${packets.erase.length} pages first`);
      for (const p of packets.erase) {
        check();
        await link.send(p, req.timeoutMs ?? 5000);
        await sleep(FLASH_PAGE_ERASE_TIME * 1000);
      }
    }

    cb.onPhase('start');
    check();
    await link.send(packets.start, req.timeoutMs ?? 30000);
    // START has begun erasing the pages named in the init packet and will not
    // accept DATA until that finishes.
    const wait = eraseWaitSeconds(req.image.length);
    cb.onLog(`[dfu] start accepted, waiting ${wait.toFixed(2)}s for the erase`);
    await sleep(wait * 1000);

    cb.onPhase('writing');
    let sent = 0;
    for (let i = 0; i < packets.data.length; i++) {
      check();
      await link.send(packets.data[i]);
      sent += Math.min(DFU_PACKET_DATA, req.image.length - sent);
      cb.onProgress(sent, req.image.length);

      // One flash page is 8 packets of 512 bytes; pause between pages so the
      // controller keeps up.
      if ((i + 1) % 8 === 0) {
        await sleep(FLASH_PAGE_WRITE_TIME * 1000);
      }
    }

    cb.onPhase('finishing');
    await sleep(FLASH_PAGE_WRITE_TIME * 1000);
    check();
    await link.send(packets.stop);

    cb.onPhase('done');
    cb.onLog(`[dfu] stop accepted, ${sent} bytes written; the board will reboot`);
    return { bytesWritten: sent };
  } catch (e) {
    const err = e instanceof DfuError ? e : new DfuError('TRANSFER_FAILED', (e as Error).message);
    cb.onError(err.kind, err.message);
    throw err;
  } finally {
    if (opened) await link.close();
  }
}

/** Map an error onto a sentence the UI can show. */
export function dfuErrorToMessage(err: unknown): { kind: string; message: string } {
  if (err instanceof DfuError) {
    switch (err.kind) {
      case 'NO_WEBSERIAL':
        return { kind: err.kind, message: 'This browser has no Web Serial. Use Chrome or Edge.' };
      case 'PERMISSION_DENIED':
        return { kind: err.kind, message: 'Serial port access was not granted.' };
      case 'NOT_IN_DFU':
        return {
          kind: err.kind,
          message: 'The board did not respond. Unplug it, plug it back, and retry — the 1200-baud touch reset should put it in DFU mode.',
        };
      case 'ACK_MISMATCH':
        return { kind: err.kind, message: `Lost sync with the bootloader: ${err.message}` };
      case 'ABORTED':
        return { kind: err.kind, message: 'Cancelled.' };
      default:
        return { kind: err.kind, message: err.message };
    }
  }
  return { kind: 'TRANSFER_FAILED', message: (err as Error)?.message ?? String(err) };
}
