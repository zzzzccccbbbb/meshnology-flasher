import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseIntelHex, toSparseImage, trimTrailingErased, packUf2, readUf2,
  NRF52840_FAMILY_ID,
} from './uf2';

/**
 * Real-firmware check against the actual W13 build output.
 *
 * The fixture is not committed (1.2 MB); when it is absent the test skips so
 * `npm test` stays green on machines that don't have the W13 checkout. To run
 * it for real:
 *
 *   wsl -d Ubuntu-22.04 bash -lc 'cat ~/platformIO/w13/w13/w13_factory.hex' \
 *     | tr -d '\0' > .tmp-w13.hex
 *   npx vitest run src/nrf/uf2.real.test.ts
 */
const FIXTURE = resolve(__dirname, '../../.tmp-w13.hex');
const hasFixture = existsSync(FIXTURE);

describe.skipIf(!hasFixture)('W13 factory firmware (real)', () => {
  const hexText = readFileSync(FIXTURE, 'utf8');

  it('parses every record without error', () => {
    const segs = parseIntelHex(hexText);
    expect(segs.length).toBeGreaterThan(10000);
    expect(segs.reduce((n, s) => n + s.data.length, 0)).toBeGreaterThan(100000);
  });

  it('covers both the SoftDevice region and the app at 0x27000', () => {
    const segs = parseIntelHex(hexText);
    const img = trimTrailingErased(toSparseImage(segs));

    // The W13 hex contains the whole protected layout: SoftDevice S140 v7
    // starts at 0x0 and the application sits at 0x27000, so the image spans
    // from the very beginning of flash up to ~0x7b000. That is why the
    // project ini warns that PlatformIO's default `loadbin ...,0x0` is safe
    // here — this particular hex really does own address 0.
    expect(img.start).toBe(0);
    expect(img.end).toBeGreaterThan(0x27000);

    // SoftDevice lives in the first 64 KB, the app well past it.
    const at = (addr: number) => img.bytes[addr - img.start];
    expect(at(0x0)).toBeDefined();
    expect(at(0x27000)).toBeDefined();

    // Both regions must actually carry bytes, not just be inside the span.
    const sliceHasData = (from: number, to: number) => {
      for (let a = from; a < to; a++) if (at(a) !== 0xff) return true;
      return false;
    };
    expect(sliceHasData(0x0, 0x1000)).toBe(true);       // SoftDevice header
    expect(sliceHasData(0x27000, 0x27100)).toBe(true);  // app start

    // And the image must not be a whole-chip dump.
    expect(img.end - img.start).toBeLessThan(2 * 1024 * 1024);
  });

  it('produces a contiguous, correctly sized UF2', () => {
    const segs = parseIntelHex(hexText);
    const img = trimTrailingErased(toSparseImage(segs));
    const uf2 = packUf2(img);
    const info = readUf2(uf2);

    expect(info.familyId).toBe(NRF52840_FAMILY_ID);
    expect(uf2.length % 512).toBe(0);
    expect(info.blocks.length).toBe(Math.ceil((img.end - img.start) / 256));

    for (let i = 1; i < info.blocks.length; i++) {
      expect(info.blocks[i].targetAddr - info.blocks[i - 1].targetAddr).toBe(256);
      expect(info.blocks[i].blockNo).toBe(i);
      expect(info.blocks[i].numBlocks).toBe(info.blocks.length);
    }
  });

  it('packs to a plausible download size', () => {
    const segs = parseIntelHex(hexText);
    const img = trimTrailingErased(toSparseImage(segs));
    const uf2 = packUf2(img);
    // UF2 is 2x the payload, so a 1.2 MB HEX should land around 2.4 MB.
    console.log(`  W13 image 0x${img.start.toString(16)}..0x${img.end.toString(16)}` +
      ` = ${(img.end - img.start).toLocaleString()} B -> ${info2(uf2.length)} blocks =` +
      ` ${(uf2.length / 1024 / 1024).toFixed(2)} MB`);
    expect(uf2.length).toBeGreaterThan(1024);
    expect(uf2.length).toBeLessThan(16 * 1024 * 1024);
  });
});

function info2(n: number): string {
  return String(n / 512);
}