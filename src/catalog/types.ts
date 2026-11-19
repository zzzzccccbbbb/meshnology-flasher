/**
 * catalog/types.ts — Type definitions for v0.3 firmware catalog.
 *
 * Matches the JSON files in public/catalog/ — see docs/v0.3-plan.md
 * "Catalog data format" for the full schema.
 */

export interface DeviceSummary {
  id: string;
  displayName: string;
  vendor: string;
  chip: string;
  latestVersion: string;
  flashSize: string;
  notes?: string;
  /**
   * Keep the entry out of the device picker.
   *
   * The firmware and the device record stay in the catalog, so the file
   * is still reachable by URL and can be brought back by clearing the
   * flag. Used for a build that is not the one the boards should be
   * running yet.
   */
  hidden?: boolean;
}

export interface CatalogManifest {
  schemaVersion: 1;
  updated: string;
  devices: DeviceSummary[];
}

/**
 * How a catalog firmware is delivered.
 *
 *   bin  — a merged image, written at its flash offset (ESP32)
 *   hex  — Intel HEX carrying its own addresses, unpacked in the browser
 *          and written over Nordic DFU (nRF52840)
 *   dfu  — an Adafruit/Nordic DFU package (.dfu or .zip): a ZIP holding
 *          manifest.json, firmware.bin and firmware.dat. Same wire result
 *          as the hex it is built from, but it is the format
 *          adafruit-nrfutil and the nRF DFU apps accept, so publishing it
 *          lets one file serve the browser and the desktop tools.
 */
export type FirmwareFormat = 'bin' | 'hex' | 'dfu';

export interface FirmwareVersion {
  version: string;
  size: number;          // bytes on the wire as published
  sha256: string;        // 64-char lowercase hex
  uploaded: string;      // ISO 8601
  filename: string;      // basename only, used for UI display
  format?: FirmwareFormat; // defaults to 'bin' when absent
  notes?: string;
}

export interface DeviceDetails {
  id: string;
  displayName: string;
  vendor: string;
  chip: string;
  flashSize: string;
  notes?: string;
  /**
   * Which chip-family pipeline this device needs. Absent means 'esp32'.
   * The UI switches its whole flashing path when this is 'nrf52840', so a
   * catalog entry is enough to route the user to the right transport — no
   * manual chip selection needed.
   */
  chipFamily?: 'esp32' | 'nrf52840';
  versions: FirmwareVersion[];
}

/** Hex SHA-256 regex (lowercase, 64 chars). */
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Device id regex: lowercase, digits, dash, must start with [a-z0-9], 1..41 chars. */
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Semver-ish version regex: x.y.z with optional pre-release/build metadata.
 *
 * The leading "v" is allowed because that is how the releases are named in
 * the catalog ("v1.18.0"), and the version doubles as the directory name
 * the firmware is published under.
 */
export const VERSION_RE = /^v?\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/;

export function isValidDeviceId(id: string): boolean {
  return DEVICE_ID_RE.test(id);
}

export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

export function isValidSha256(sha: string): boolean {
  return SHA256_RE.test(sha);
}