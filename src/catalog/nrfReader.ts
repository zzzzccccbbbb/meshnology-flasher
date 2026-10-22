/**
 * catalog/nrfReader.ts — Turn a catalog firmware into something the Nordic
 * DFU transport can write.
 *
 * The catalog publishes files by extension: a .bin is a flat ESP32 image, a
 * .hex is Intel HEX carrying its own addresses. The nRF bootloader needs the
 * second form turned into (a) a flat byte image and (b) the flash address the
 * first byte belongs at, because the DFU init packet is generated from that
 * base at flash time.
 *
 * Verified against the W13 MeshCore build: firmware.hex parses to
 * 0x027000..0x09b52c, 476,460 bytes, byte-identical to the firmware.bin
 * inside the sibling .dfu package. The .hex carries only the application;
 * SoftDevice must already be on the board (the .dfu manifest states
 * softdevice_req 0x0123, i.e. S140 7.3.0).
 */

import { parseIntelHex, toSparseImage, HexParseError } from '../nrf/uf2';
import { parseDfuPackage, describeDfuPackage } from '../nrf/dfuPackage';
import { firmwareUrl, type CatalogError } from './api';
import { isValidSha256, type FirmwareVersion } from './types';

export interface NrfImage {
  /** Flat image: linker holes between HEX records are 0xFF. */
  bytes: Uint8Array;
  /** Flash address the first byte of `bytes` goes to. */
  startAddress: number;
  /** Exclusive end address. */
  endAddress: number;
  /** Number of 4 KB flash pages the image touches. */
  pages: number;
}

/**
 * Decode an Intel HEX into a flat image plus its base address.
 *
 * A HEX that starts above 0 is an application-only image (the usual nRF case
 * — entry point at 0x27000 or wherever the linker script puts it). A HEX
 * that starts at 0 additionally carries a SoftDevice, and writing it back
 * through the app-only DFU mode would be wrong; we still accept it, because
 * the bootloader will erase and rewrite exactly the pages the init packet
 * names, but the log line makes the difference visible.
 */
export function hexToNrfImage(text: string): NrfImage {
  let segments;
  try {
    segments = parseIntelHex(text);
  } catch (e) {
    if (e instanceof HexParseError) {
      throw new Error(`Intel HEX is invalid: ${e.message}`);
    }
    throw e;
  }

  const sparse = toSparseImage(segments);
  return {
    bytes: sparse.bytes,
    startAddress: sparse.start,
    endAddress: sparse.end,
    pages: Math.ceil(sparse.bytes.byteLength / 4096),
  };
}

/** One-line human summary for the terminal pane. */
export function describeNrfImage(img: NrfImage): string {
  const kb = (img.bytes.byteLength / 1024).toFixed(1);
  const kind = img.startAddress === 0
    ? 'image starts at 0x0 — includes a SoftDevice prefix'
    : 'application only (SoftDevice assumed present on the board)';
  return `${kb} KB, flash 0x${img.startAddress.toString(16)}..0x${img.endAddress.toString(16)}, ` +
    `${img.pages} pages, ${kind}`;
}

/** The delivery format of a catalog entry, inferred from the extension. */
export function versionFormat(version: FirmwareVersion): 'hex' | 'bin' | 'dfu' {
  if (version.format) return version.format;
  const name = version.filename.toLowerCase();
  if (name.endsWith('.hex')) return 'hex';
  if (name.endsWith('.dfu') || name.endsWith('.zip')) return 'dfu';
  return 'bin';
}

/**
 * Fetch a catalog firmware and turn it into something the DFU transport can
 * write.
 *
 * The SHA-256 and size checks mirror what ./reader.ts does for ESP32 images —
 * both exist because a truncated or stale CDN copy that reaches the bootloader
 * writes garbage and there is no way to tell from the flash itself.
 */
export async function fetchNrfFirmware(
  deviceId: string,
  version: FirmwareVersion,
  onLog: (line: string) => void,
): Promise<NrfImage> {
  if (!isValidSha256(version.sha256)) {
    throw new Error(`bad sha256 in catalog: ${version.sha256}`);
  }

  const url = firmwareUrl(deviceId, version.version, version.filename);
  onLog(`[catalog] fetching ${deviceId} ${version.version}…`);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`firmware download failed: HTTP ${res.status} for ${url}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== version.size) {
    // A SPA fallback answers 200 with index.html for any unknown path, so a
    // size mismatch is the only signal that the file is not where the catalog
    // says it is. Say so, because "stale CDN copy" sends people looking at
    // caching when the URL was simply wrong.
    const looksLikeHtml = bytes.byteLength > 0 && bytes[0] === 0x3c; // '<'
    throw new Error(
      looksLikeHtml
        ? `${url} returned HTML (${bytes.byteLength} bytes), not the firmware — ` +
          `the file is not deployed at that path`
        : `downloaded ${bytes.byteLength} bytes, catalog says ${version.size} — ` +
          `stale CDN copy?`,
    );
  }

  const actual = await sha256Hex(bytes);
  if (actual !== version.sha256) {
    throw new Error(`SHA-256 mismatch: expected ${version.sha256}, got ${actual} — refusing to flash`);
  }
  onLog(`[catalog] sha-256 verified for ${version.filename}`);

  const fmt = versionFormat(version);
  if (fmt === 'bin') {
    return {
      bytes,
      startAddress: 0,
      endAddress: bytes.byteLength,
      pages: Math.ceil(bytes.byteLength / 4096),
    };
  }
  if (fmt === 'dfu') {
    // A DFU package carries the image at whatever base its linker used; the
    // W13 boards put the application at 0x27000. The package's own manifest
    // does not record that address, so it comes from the device entry.
    const pkg = parseDfuPackage(bytes);
    const base = 0x27000;
    onLog(`[dfu] ${describeDfuPackage(pkg, base)}`);
    if (pkg.softdeviceReqLabel) {
      onLog(`[dfu] the board must already carry SoftDevice ${pkg.softdeviceReqLabel}; ` +
        'the bootloader refuses the write otherwise');
    }
    return {
      bytes: pkg.image,
      startAddress: base,
      endAddress: base + pkg.image.byteLength,
      pages: Math.ceil(pkg.image.byteLength / 4096),
    };
  }
  return hexToNrfImage(new TextDecoder().decode(bytes));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto;
  if (!subtle?.subtle) {
    throw new Error('crypto.subtle is unavailable (needs HTTPS or localhost)');
  }
  const digest = await subtle.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
