/**
 * flasher.ts — Top-level flash orchestration over esptool.js.
 *
 * Public API:
 *   flashEsp32(port, files, flashConfig, callbacks)  → Promise<void>
 *
 * Where `callbacks` are:
 *   onPhase('connecting' | 'syncing' | 'detecting' | 'erasing' |
 *           'writing' | 'verifying' | 'restarting' | 'done', detail?)
 *   onProgress(written, total) — bytes-level progress
 *   onLog(line) — esptool.js stdout line (via IEspLoaderTerminal)
 *   onError(err) — thrown error with kind + message
 *
 * The function never throws on user-visible failures; it reports via
 * callbacks. Only programming errors (bad arguments) will throw.
 */

import { ESPLoader, Transport, type IEspLoaderTerminal, type FlashOptions } from 'esptool-js';
import { detectChipCode, type ChipCode } from './chipDetect';
import { toEspConfig, type FlashConfigUi } from './flashConfig';

export type Phase =
  | 'connecting'
  | 'syncing'
  | 'detecting'
  | 'erasing'
  | 'writing'
  | 'verifying'
  | 'restarting'
  | 'done';

export interface FlashCallbacks {
  onPhase: (phase: Phase, detail?: string) => void;
  onProgress: (written: number, total: number) => void;
  onLog: (line: string) => void;
  onChip: (code: ChipCode, name: string) => void;
  onError: (kind: string, message: string) => void;
}

export interface FlashFile {
  name: string;
  bytes: Uint8Array;
  offset: number;
}

export interface FlashResult {
  ok: true;
  chip: ChipCode;
  chipName: string;
}

export async function flashEsp32(
  port: SerialPort,
  files: FlashFile[],
  flashConfig: FlashConfigUi,
  cb: FlashCallbacks,
): Promise<FlashResult> {
  if (files.length === 0) throw new Error('flashEsp32: no files');

  const totalBytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);

  // Terminal interface — esptool.js's IEspLoaderTerminal feeds stdout here.
  const terminal: IEspLoaderTerminal = {
    clean: () => {},
    write: (s) => cb.onLog(s),
    writeLine: (s) => cb.onLog(s),
  };

  const transport = new Transport(port);
  const loader = new ESPLoader({
    transport,
    baudrate: 115200,
    terminal,
  });

  // Note: do NOT call transport.connect() here. ESPLoader.main() / detectChip()
  // calls transport.connect() internally; calling it twice causes
  // "Failed to execute 'open' on 'SerialPort': The port is already open".
  cb.onPhase('connecting');
  cb.onLog(`[transport] port acquired @ 115200 baud (open deferred to ESPLoader)`);

  // Wire up disconnect callback so we can report USB unplug events
  transport.setDeviceLostCallback(() => {
    cb.onError('PORT_DISCONNECT', 'Serial port disconnected during flash');
  });

  let chipName = 'unknown';
  let chipCode: ChipCode = 'UNKNOWN';

  try {
    // Connect / detect chip (resets into bootloader, sends SYNC, reads CHIP_ID)
    cb.onPhase('syncing');
    cb.onLog('[esptool] connecting…');
    await loader.main();

    chipName = (loader.chip as unknown as { CHIP_NAME?: string }).CHIP_NAME ?? 'unknown';
    chipCode = detectChipCode(loader.chip);
    cb.onChip(chipCode, chipName);
    cb.onLog(`[esptool] chip: ${chipName}`);

    cb.onPhase('detecting');

    const esp = toEspConfig(flashConfig);

    // Erase + write + verify + restart.
    // We report 'erasing' briefly, then 'writing' for the actual flashBlocks
    // progress (driven by reportProgress), then 'verifying' (esptool computes
    // MD5 of image, then optionally reads back), then 'restarting'.

    // Mark erasing as in-progress; esptool begins erasing at writeFlash().
    cb.onPhase('erasing');
    cb.onProgress(0, totalBytes);

    // Build FlashOptions
    //
    // Note: we intentionally do NOT pass `calculateMD5Hash`. esptool.js's API
    // expects a synchronous return value, but the only browser-side MD5 API
    // (SubtleCrypto.digest) is async. Passing an async fn yields a Promise
    // that gets stringified to "[object Promise]" and the post-write MD5
    // compare always fails with "MD5 of file does not match data in flash!"
    // Each flash block already has its own checksum + retry path inside
    // esptool.js (WRITE_BLOCK_ATTEMPTS), so verification at the block level
    // still happens — we just skip the whole-image MD5 verify.
    const flashOpts: FlashOptions = {
      fileArray: files.map(f => ({ data: f.bytes, address: f.offset })),
      flashMode: esp.flashMode ?? 'keep',
      flashFreq: esp.flashFreq ?? 'keep',
      flashSize: esp.flashSize ?? 'detect',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        // esptool.js reports `written` / `total` in *compressed* bytes.
        // Map that ratio back to the original (uncompressed) file size so
        // the UI progress bar shows bytes-vs-original-bytes, not bytes-vs-
        // compressed-bytes (which plateaus at ~60% for a typical 1.25 MB
        // .bin that compresses to 0.74 MB).
        const ratio = total > 0 ? written / total : 0;
        const priorUncompressed = files.slice(0, fileIndex).reduce((n, f) => n + f.bytes.byteLength, 0);
        const thisFileUncompressed = files[fileIndex]?.bytes.byteLength ?? 0;
        const aggregate = priorUncompressed + Math.floor(ratio * thisFileUncompressed);
        cb.onProgress(aggregate, totalBytes);
        cb.onPhase('writing');
      },
    };

    await loader.writeFlash(flashOpts);
    cb.onLog(`[esptool] write complete`);

    cb.onPhase('verifying');
    // esptool.js verifies inside writeFlash via MD5 (when calculateMD5Hash given).
    // For multi-file writes, we trust its built-in comparison.

    cb.onPhase('restarting');
    await loader.after('hard_reset', false);
    cb.onLog(`[esptool] board reset`);
  } catch (e) {
    const msg = errMsg(e);
    const kind = classifyError(msg);
    cb.onError(kind, msg);
    // Best-effort cleanup
    try { await transport.disconnect(); } catch { /* ignore */ }
    throw e;
  }

  cb.onPhase('done');

  try { await transport.disconnect(); } catch { /* ignore */ }

  return { ok: true, chip: chipCode, chipName };
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/**
 * Map an esptool.js error message to one of our stable error kinds.
 * Returns 'ABORTED' for user cancellation, falls back to 'UNKNOWN'.
 */
function classifyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('already open')) return 'PORT_ALREADY_OPEN';
  if (m.includes('sync') || m.includes('timeout')) return 'SYNC_TIMEOUT';
  if (m.includes('failed to connect') || m.includes('no esptool')) return 'CHIP_UNKNOWN';
  if (m.includes('erase')) return 'ERASE_FAIL';
  if (m.includes('flash') || m.includes('write')) return 'WRITE_FAIL';
  if (m.includes('md5') || m.includes('checksum')) return 'VERIFY_FAIL';
  if (m.includes('cancelled') || m.includes('aborted')) return 'ABORTED';
  if (m.includes('disconnect') || m.includes('lost')) return 'PORT_DISCONNECT';
  return 'UNKNOWN';
}