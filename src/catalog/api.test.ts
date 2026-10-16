/**
 * catalog/api.test.ts — Unit tests for the static catalog fetch wrappers.
 *
 * We mock global.fetch with vi.fn. No real network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchManifest, fetchDevice, firmwareUrl, CatalogError } from './api';
import { isValidDeviceId, isValidVersion, isValidSha256 } from './types';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE_MANIFEST = {
  schemaVersion: 1,
  updated: '2026-10-16T09:00:00Z',
  devices: [
    { id: 'w10-meshnology', displayName: 'W10', vendor: 'Meshnology',
      chip: 'ESP32-S3', latestVersion: '1.0.0', flashSize: '16MB' },
  ],
};

const SAMPLE_DEVICE = {
  id: 'w10-meshnology',
  displayName: 'W10 Meshnology (ESP32-S3)',
  vendor: 'Meshnology',
  chip: 'ESP32-S3',
  flashSize: '16MB',
  versions: [
    { version: '1.0.0', size: 1298224,
      sha256: 'a'.repeat(64),
      uploaded: '2026-10-16T09:00:00Z',
      filename: 'w10-meshnology-1.0.0.bin' },
  ],
};

describe('fetchManifest', () => {
  it('returns parsed manifest on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE_MANIFEST));
    const m = await fetchManifest();
    expect(m.devices).toHaveLength(1);
    expect(m.devices[0].id).toBe('w10-meshnology');
  });

  it('throws SCHEMA_MISMATCH on wrong schemaVersion', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ schemaVersion: 99, devices: [] }));
    await expect(fetchManifest()).rejects.toMatchObject({ kind: 'SCHEMA_MISMATCH' });
  });

  it('throws FETCH_FAILED on 500', async () => {
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 500 }));
    await expect(fetchManifest()).rejects.toBeInstanceOf(CatalogError);
  });

  it('throws PARSE_FAILED on invalid JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    await expect(fetchManifest()).rejects.toMatchObject({ kind: 'PARSE_FAILED' });
  });
});

describe('fetchDevice', () => {
  it('rejects invalid device id BEFORE making a fetch', async () => {
    await expect(fetchDevice('Has Spaces')).rejects.toMatchObject({ kind: 'DEVICE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns parsed device on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE_DEVICE));
    const d = await fetchDevice('w10-meshnology');
    expect(d.versions).toHaveLength(1);
    expect(d.versions[0].size).toBe(1298224);
  });

  it('throws PARSE_FAILED when body.id != URL id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...SAMPLE_DEVICE, id: 'something-else' }));
    await expect(fetchDevice('w10-meshnology')).rejects.toMatchObject({ kind: 'PARSE_FAILED' });
  });
});

describe('firmwareUrl', () => {
  it('builds the expected path', () => {
    expect(firmwareUrl('w10-meshnology', '1.0.0')).toBe('/firmware/w10-meshnology/1.0.0.bin');
  });

  it('percent-encodes device id and version', () => {
    expect(firmwareUrl('w10/with space', '1.0.0+meta')).toBe('/firmware/w10%2Fwith%20space/1.0.0%2Bmeta.bin');
  });
});

describe('validators', () => {
  it('accepts valid ids', () => {
    expect(isValidDeviceId('w10-meshnology')).toBe(true);
    expect(isValidDeviceId('a')).toBe(true);
    expect(isValidDeviceId('a-b-c-1-2-3')).toBe(true);
  });
  it('rejects bad ids', () => {
    expect(isValidDeviceId('-leading-dash')).toBe(false);
    expect(isValidDeviceId('UPPER')).toBe(false);
    expect(isValidDeviceId('has space')).toBe(false);
    expect(isValidDeviceId('')).toBe(false);
  });
  it('accepts semver-ish versions', () => {
    expect(isValidVersion('1.0.0')).toBe(true);
    expect(isValidVersion('0.0.1')).toBe(true);
    expect(isValidVersion('10.20.30-rc.1')).toBe(true);
    expect(isValidVersion('1.0.0+build.42')).toBe(true);
  });
  it('rejects bad versions', () => {
    expect(isValidVersion('1.0')).toBe(false);
    expect(isValidVersion('v1.0.0')).toBe(false);
    expect(isValidVersion('1.0.0.0')).toBe(false);
  });
  it('accepts 64-char hex SHA-256 only', () => {
    expect(isValidSha256('a'.repeat(64))).toBe(true);
    expect(isValidSha256('0'.repeat(64))).toBe(true);
    expect(isValidSha256('A'.repeat(64))).toBe(false);
    expect(isValidSha256('a' * 63)).toBe(false);
    expect(isValidSha256('g'.repeat(64))).toBe(false);
  });
});