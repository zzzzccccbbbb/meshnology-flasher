/**
 * catalog/reader.ts — Download a firmware .bin from the static catalog
 * and verify its SHA-256 client-side before passing it to esptool.js.
 *
 * Replaces the v0.2 broken MD5 path. esptool.js wants a synchronous
 * MD5 callback; SubtleCrypto.digest is async, so the v0.2 path
 * always returned a Promise that got stringified to "[object Promise]"
 * and broke verification. SHA-256 client-side, before flashEsp32, is
 * both simpler and more correct.
 */

import { firmwareUrl, CatalogError } from './api';
import { isValidSha256, type FirmwareVersion } from './types';

export interface DownloadedFirmware {
  bytes: Uint8Array;
  version: FirmwareVersion;
}

export async function downloadFirmware(
  deviceId: string,
  version: FirmwareVersion,
): Promise<DownloadedFirmware> {
  if (!isValidSha256(version.sha256)) {
    throw new CatalogError('CATALOG_INVALID', `Bad sha256 in catalog: ${version.sha256}`);
  }

  const url = firmwareUrl(deviceId, version.version);
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new CatalogError(
      'BIN_MISSING',
      `GET ${url} -> ${res.status} ${res.statusText}. The catalog entry exists but the .bin is not in the deployment.`,
    );
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);

  if (bytes.byteLength !== version.size) {
    throw new CatalogError(
      'BIN_SIZE_MISMATCH',
      `Downloaded ${bytes.byteLength} bytes, expected ${version.size} per catalog. CDN may be serving a stale or truncated file.`,
    );
  }

  const actualHex = await sha256Hex(bytes);
  if (actualHex !== version.sha256) {
    throw new CatalogError(
      'FIRMWARE_CORRUPTED',
      `SHA-256 mismatch: expected ${version.sha256} got ${actualHex}. Refusing to flash.`,
    );
  }

  return { bytes, version };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto;
  if (!subtle || !subtle.subtle) {
    throw new CatalogError('SUBTLE_UNAVAILABLE', 'crypto.subtle is not available (requires HTTPS or localhost).');
  }
  const digest = await subtle.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}