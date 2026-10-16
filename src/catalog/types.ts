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
}

export interface CatalogManifest {
  schemaVersion: 1;
  updated: string;
  devices: DeviceSummary[];
}

export interface FirmwareVersion {
  version: string;
  size: number;          // bytes
  sha256: string;        // 64-char lowercase hex
  uploaded: string;      // ISO 8601
  filename: string;      // basename only, used for UI display
  notes?: string;
}

export interface DeviceDetails {
  id: string;
  displayName: string;
  vendor: string;
  chip: string;
  flashSize: string;
  notes?: string;
  versions: FirmwareVersion[];
}

/** Hex SHA-256 regex (lowercase, 64 chars). */
export const SHA256_RE = /^[0-9a-f]{64}$/;

/** Device id regex: lowercase, digits, dash, must start with [a-z0-9], 1..41 chars. */
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Semver-ish version regex: x.y.z with optional pre-release/build metadata. */
export const VERSION_RE = /^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/;

export function isValidDeviceId(id: string): boolean {
  return DEVICE_ID_RE.test(id);
}

export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

export function isValidSha256(sha: string): boolean {
  return SHA256_RE.test(sha);
}