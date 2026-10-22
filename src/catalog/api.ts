/**
 * catalog/api.ts — Fetch wrappers for the static catalog JSON.
 *
 * The catalog lives at /catalog/* under the same origin as the SPA.
 * Both endpoints are static GETs; no auth, no headers.
 */

import type { CatalogManifest, DeviceDetails } from './types';
import { isValidDeviceId } from './types';

const MANIFEST_PATH = '/catalog/manifest.json';

function devicePath(id: string): string {
  return `/catalog/devices/${encodeURIComponent(id)}.json`;
}

export class CatalogError extends Error {
  constructor(public kind: string, message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new CatalogError(
      'FETCH_FAILED',
      `GET ${url} -> ${res.status} ${res.statusText}`,
    );
  }
  try {
    return await res.json() as T;
  } catch (e) {
    throw new CatalogError(
      'PARSE_FAILED',
      `Failed to parse JSON from ${url}: ${(e as Error).message}`,
    );
  }
}

/** Fetch the top-level device list. */
export async function fetchManifest(): Promise<CatalogManifest> {
  const data = await fetchJson<CatalogManifest>(MANIFEST_PATH);
  if (data.schemaVersion !== 1) {
    throw new CatalogError(
      'SCHEMA_MISMATCH',
      `Unsupported catalog schemaVersion ${data.schemaVersion}; expected 1.`,
    );
  }
  if (!Array.isArray(data.devices)) {
    throw new CatalogError('PARSE_FAILED', 'manifest.json is missing "devices" array');
  }
  return data;
}

/** Fetch detailed info for one device (all its versions). */
export async function fetchDevice(id: string): Promise<DeviceDetails> {
  if (!isValidDeviceId(id)) {
    throw new CatalogError('DEVICE_INVALID', `Invalid device id: ${id}`);
  }
  const data = await fetchJson<DeviceDetails>(devicePath(id));
  if (data.id !== id) {
    throw new CatalogError(
      'PARSE_FAILED',
      `Device id mismatch: URL=${id} but body.id=${data.id}`,
    );
  }
  return data;
}

/**
 * Resolve a (device, version) pair to its download URL.
 *
 * The extension is the catalog entry's own filename, not a fixed ".bin": a
 * device may publish a merged ESP32 image, an Intel HEX, or a DFU package,
 * and the file on disk carries that extension. Hardcoding ".bin" made the
 * browser request a path that does not exist, and the SPA fallback answered
 * with index.html — which surfaced as "downloaded 612 bytes" rather than a
 * 404, because the fallback returns 200.
 */
export function firmwareUrl(id: string, version: string, filename?: string): string {
  const ext = filename && filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.'))
    : '.bin';
  return `/firmware/${encodeURIComponent(id)}/${encodeURIComponent(version)}${ext}`;
}