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
  DTR_LOW_MS,
  DTR_RESET_WAIT_MS,
  RE_ENUMERATE_WAIT_MS,
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

/** The first few bytes of a frame, hex — enough to tell two frames apart. */
function hexHead(frame: Uint8Array, count = 10): string {
  const head = Array.from(frame.subarray(0, count))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
  return frame.length > count ? `${head} …` : head;
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
   * Pulse DTR to make the bootloader enter DFU mode.
   *
   * Nordic's reference transport does this whenever the touch step is
   * disabled:
   *
   *     self.serial_port.setDTR(False); time.sleep(0.05)
   *     self.serial_port.setDTR(True);  time.sleep(0.1)
   *
   * The Feather-style bootloader on this board watches DTR: a low-to-high
   * edge is what puts it into the DFU protocol. Without the pulse it stays
   * in its mass-storage mode and never answers a DFU packet — which is
   * exactly the "no response from the bootloader" the page reported.
   *
   * Web Serial exposes the modem lines through setSignals(). A board that
   * does not support them throws, which is not fatal: the user may have
   * entered DFU by hand.
   */
  async pulseDtr(): Promise<boolean> {
    const signals = this.port as unknown as {
      setSignals?: (s: { dataTerminalReady: boolean; requestToSend: boolean }) => Promise<void>;
    };
    if (typeof signals.setSignals !== 'function') return false;
    try {
      await signals.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(DTR_LOW_MS);
      await signals.setSignals({ dataTerminalReady: true, requestToSend: true });
      await sleep(DTR_RESET_WAIT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send one framed packet and wait for its ACK.
   *
   * The bootloader answers with a two-delimiter SLIP frame. Bytes may arrive
   * with stale content before the opening 0xC0 (the reset banner, for
   * instance), so the reader counts delimiters rather than assuming the
   * first byte is one.
   *
   * The ACK check follows Nordic's own reference implementation
   * (nordicsemi/dfu/dfu_transport_serial.py):
   *
   *   * the first packet after opening is *not* sequence-checked — the
   *     reference breaks out of its retry loop on the first response
   *     whatever it says, because the board may answer with a stale
   *     sequence from before the reset
   *   * every later packet must carry the sequence one past the last
   *     accepted one
   *   * a packet that is not acknowledged is re-sent, and three failures
   *     abort the transfer
   *
   * `onSend` is called with the frame that went out and with a one-line
   * description, so the page can show what it is waiting for instead of
   * going quiet.
   */
  async send(
    packet: Uint8Array,
    timeoutMs = 5000,
    onSend?: (frame: Uint8Array, description: string) => void,
  ): Promise<void> {
    if (!this.writer || !this.reader) throw new DfuError('TRANSFER_FAILED', 'port not open');

    let lastAck: number | null = null;
    let attempts = 0;

    while (true) {
      attempts++;
      const frame = slipEncode(packet);
      await this.writer.write(frame);
      onSend?.(frame, `${frame.length} bytes on the wire`);
      const ack = await this.readAck(timeoutMs);

      // The first response is accepted as-is, matching the reference.
      if (lastAck === null) {
        lastAck = ack;
        this.lastAck = ack;
        return;
      }
      if (ack === (lastAck + 1) % 8) {
        lastAck = ack;
        this.lastAck = ack;
        return;
      }
      // Not the expected sequence — the packet was lost or the board
      // answered out of order. Send it again.
      if (attempts >= 3) {
        this.lastAck = -1;
        HciSequence.reset();
        throw new DfuError(
          'ACK_MISMATCH',
          `the bootloader did not acknowledge packet ${attempts} times ` +
          `(expected ACK ${(lastAck + 1) % 8}, got ${ack})`,
        );
      }
    }
  }

  /** Read one SLIP-framed ACK and return its sequence number. */
  private async readAck(timeoutMs: number): Promise<number> {
    if (!this.reader) throw new DfuError('TRANSFER_FAILED', 'port not open');

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
        // A read on a port whose device has gone away can stay pending
        // forever, so the deadline is enforced against the read itself and
        // not only between reads.
        chunk = await Promise.race([
          this.reader.read(),
          sleep(Math.max(0, deadline - Date.now())).then(() => {
            throw new DfuError(
              'NOT_IN_DFU',
              'no response from the bootloader — the board may not be in DFU mode',
            );
          }),
        ]);
      } catch (e) {
        if (e instanceof DfuError) throw e;
        // A read that rejects means the device went away underneath us.
        // On this hardware that is a reboot: the board resets, the USB
        // connection drops, and the port comes back under a new number.
        throw new DfuError(
          'TRANSFER_FAILED',
          'the board stopped talking — it rebooted or was disconnected mid-transfer',
        );
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

    // The reference decodes the escapes over the whole buffer and then
    // strips the leading and trailing 0xC0, so the first decoded byte is
    // the HCI header whose low three bits carry the ACK number.
    let decoded: Uint8Array;
    try {
      decoded = slipDecode(Uint8Array.from(buffer));
    } catch (e) {
      throw new DfuError('ACK_MISMATCH', (e as Error).message);
    }
    // Strip the two delimiters that survived the escape decoding.
    let start = 0;
    let end = decoded.length;
    while (start < end && decoded[start] === 0xc0) start++;
    while (end > start && decoded[end - 1] === 0xc0) end--;
    const body = decoded.subarray(start, end);
    if (body.length < 1) throw new DfuError('ACK_MISMATCH', 'ACK frame too short');

    return (body[0] >> 3) & 0x07;
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
   * closing it.
   *
   * Default false. The board's bootloader here is an Adafruit Feather UF2
   * one (239a:0029) that presents both a serial port and a mass-storage
   * volume, and adafruit-nrfutil programs it successfully with the touch
   * step *disabled* — the operator double-taps RESET to enter DFU and then
   * the tool talks to the port as-is. A 1200-baud open on this bootloader
   * has not been observed to work, and it may reboot the board back out of
   * DFU, so it is opt-in rather than automatic.
   */
  touchReset?: boolean;
  /** Give up after this long without progress, in ms. */
  timeoutMs?: number;
  /**
   * The DFU init packet — the "firmware.dat" content.
   *
   * It names the device type and revision, the SoftDevice the board must
   * already carry, and the CRC of the image. The bootloader checks all of
   * it and refuses the write on a mismatch, so it must be the packet that
   * was built for this image, not one synthesised at flash time.
   */
  initPacket: Uint8Array;
  /**
   * Pulse DTR before writing, to make the bootloader enter DFU mode.
   *
   * Off by default, and the reason is specific to the browser. Nordic's
   * reference transport pulses DTR whenever the touch step is off, but it
   * uses pyserial, where DTR is a hardware line and the USB connection
   * survives the edge. Under Web Serial the same edge makes the board
   * reboot, which tears the USB connection down: the port comes back
   * under a different COM number and everything written to the old handle
   * goes nowhere. The board's own mass-storage mode and the DFU protocol
   * can be entered by hand instead, by double-tapping RESET.
   */
  dtrPulse?: boolean;
}

/**
 * Push an image into the bootloader.
 *
 * Sequence: START (which carries the image sizes and triggers the erase) ->
 * wait for the erase -> INIT (the device/revision/SoftDevice/CRC packet) ->
 * [ERASE_PAGE *] -> DATA* -> STOP. The board reboots into its application on
 * its own once STOP lands.
 */
export async function flashNrfDfu(
  port: SerialPort,
  req: DfuFlashRequest,
  cb: DfuCallbacks,
  signal?: { aborted: boolean },
): Promise<{ bytesWritten: number }> {
  if (req.image.length === 0) throw new DfuError('TRANSFER_FAILED', 'empty firmware image');

  const packets: DfuPackets = buildDfuPackets(
    req.image,
    req.initPacket,
    req.startAddress,
    { erase: req.erase },
  );
  const link = new DfuLink(port);
  let opened = false;

  try {
    if (req.touchReset === true) {
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
      cb.onLog('[dfu] talking to the port as-is — put the board in DFU mode first');
    }
    if (signal?.aborted) throw new DfuError('ABORTED', 'cancelled');

    cb.onPhase('opening');
    // The board re-enumerates after the touch reset, so the handle can be
    // briefly unusable. Retry rather than fail on the first try.
    await link.openWithRetry();
    opened = true;
    cb.onLog(`[dfu] port open at ${DFU_BAUD} baud, ` +
      `${Math.ceil(req.image.length / DFU_PACKET_DATA)} data packets`);

    if (req.dtrPulse === true) {
      // Pulse DTR: on a Feather-style bootloader this edge is what switches
      // the device from its mass-storage mode into the DFU protocol.
      //
      // Under Web Serial the edge also reboots the board, and the reboot
      // takes the USB connection down with it. The port comes back a
      // moment later — usually under the same COM number, sometimes a
      // different one — so the wait is generous and the port is looked up
      // again and reopened before anything is sent. pyserial does not need
      // any of this, which is why the reference implementation gets away
      // with a single DTR toggle.
      cb.onLog('[dfu] pulsing DTR to switch the bootloader into DFU mode');
      await link.pulseDtr();
      cb.onLog('[dfu] waiting for the board to re-enumerate');
      await sleep(RE_ENUMERATE_WAIT_MS);

      await link.close();
      opened = false;
      const current = await findBootloaderPort(port);
      if (current !== port) {
        cb.onLog('[dfu] the board re-enumerated; using the re-found port');
        link.setPort(current);
      }
      await link.openWithRetry();
      opened = true;
      cb.onLog(`[dfu] port re-open at ${DFU_BAUD} baud`);
    }

    const check = () => {
      if (signal?.aborted) throw new DfuError('ABORTED', 'cancelled');
    };

    // Nordic's reference transport sends START before INIT:
    //
    //     send_start_dfu(...)   -> START, then sleep(erase_wait)
    //     send_init_packet(...) -> INIT
    //     send_firmware(...)    -> DATA..., STOP
    //
    // START carries the image sizes, so it has to go out first, and the
    // board spends the time right after it erasing the pages the image
    // covers. Data sent during that window is dropped on the floor, which
    // is what the earlier ordering (INIT first) ran into.
    //
    // Each packet is built right before it goes out, so the HCI sequence
    // number on the wire increases by one per packet in the order they are
    // sent. Building the whole batch up front handed out the numbers in
    // the build order instead, and the bootloader stopped answering after
    // the first couple of packets.
    cb.onPhase('start');
    check();
    await link.send(packets.start(), req.timeoutMs ?? 5000, (frame, what) => {
      cb.onLog(`[dfu] START sent (${what}, first bytes ${hexHead(frame)}), waiting for the ack`);
    });
    const wait = eraseWaitSeconds(req.image.length);
    cb.onLog(`[dfu] start accepted, waiting ${wait.toFixed(2)}s for the erase`);
    await sleep(wait * 1000);

    cb.onPhase('init');
    check();
    const initFrame = packets.init();
    await link.send(initFrame, req.timeoutMs ?? 10000, (frame, what) => {
      cb.onLog(`[dfu] INIT sent (${what}, first bytes ${hexHead(frame)}), waiting for the ack`);
    });
    cb.onLog(`[dfu] init packet: ${initFrame.length} bytes ` +
      `(${req.image.length} image bytes, base 0x${req.startAddress.toString(16)})`);

    const erasePackets = packets.erase();
    if (erasePackets.length) {
      cb.onPhase('erasing');
      cb.onLog(`[dfu] erasing ${erasePackets.length} pages first`);
      for (const p of erasePackets) {
        check();
        await link.send(p, req.timeoutMs ?? 5000);
        await sleep(FLASH_PAGE_ERASE_TIME * 1000);
      }
    }

    cb.onPhase('writing');
    let sent = 0;
    const dataChunks = packets.data();
    for (let i = 0; i < dataChunks.length; i++) {
      check();
      await link.send(dataChunks[i]);
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
    await link.send(packets.stop());

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
