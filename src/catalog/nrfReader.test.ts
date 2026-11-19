import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nrfImageFromBytes } from './nrfReader';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const DFU_PATH = join(repoRoot, 'public', 'firmware', 'w13-meshnology-meshcore', 'v1.18.0.dfu');

describe('nrfImageFromBytes', () => {
  it('unpacks a DFU package with the package\'s own init packet', () => {
    const bytes = new Uint8Array(readFileSync(DFU_PATH));
    const img = nrfImageFromBytes(bytes, 'meshnology-w13.dfu');

    // The package's firmware.dat, byte for byte.
    expect([...img.initPacket].map(b => b.toString(16).padStart(2, '0')).join('')).toBe(
      '5200afadffffffff010023011b41',
    );
    expect(img.deviceType).toBe(0x0052);
    expect(img.deviceRevision).toBe(0xadaf);
    expect(img.startAddress).toBe(0x27000);
    expect(img.bytes.byteLength).toBe(440224);
    expect(img.pages).toBe(108);
  });

  it('synthesises an init packet for a bare .bin', () => {
    const bytes = new Uint8Array(1024).fill(0x5a);
    const img = nrfImageFromBytes(bytes, 'app.bin');
    expect(img.startAddress).toBe(0x27000);
    expect(img.initPacket.length).toBe(12);
    expect(img.deviceType).toBe(0x0052);
  });

  it('reads a flat .bin at the application base address', () => {
    const bytes = new Uint8Array(4096).fill(0x11);
    const img = nrfImageFromBytes(bytes, 'x.bin');
    expect(img.bytes.byteLength).toBe(4096);
    expect(img.endAddress).toBe(0x27000 + 4096);
    expect(img.pages).toBe(1);
  });
});