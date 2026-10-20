import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseIntelHex, toSparseImage, trimTrailingErased, packUf2, readUf2,
} from './uf2';

/**
 * Byte-for-byte comparison against Microsoft's reference uf2conv.py.
 *
 * Requires both fixtures:
 *   .tmp-w13.hex      — the W13 build output (see uf2.real.test.ts)
 *   .tmp-w13-ref.uf2  — uf2conv.py -f 0xADA52840 -c … output
 */
const HEX = resolve(__dirname, '../../.tmp-w13.hex');
const REF = resolve(__dirname, '../../.tmp-w13-ref.uf2');
const ready = existsSync(HEX) && existsSync(REF);

/** Lazy: describe.skipIf only skips the it() blocks, not the describe body,
 *  so the fixtures must not be read until a test actually runs. */
const ours = () => packUf2(trimTrailingErased(toSparseImage(parseIntelHex(readFileSync(HEX, 'utf8')))));
const ref = () => readFileSync(REF);

describe.skipIf(!ready)('vs Microsoft uf2conv.py (real)', () => {
  it('reports the size difference', () => {
    const a = ours(), b = ref();
    console.log(`  ours ${a.length} B (${a.length / 512} blocks)`);
    console.log(`  ref  ${b.length} B (${b.length / 512} blocks)`);
    expect(a.length % 512).toBe(0);
    expect(b.length % 512).toBe(0);
  });

  it('produces a block count at least as large as the reference', () => {
    // We fill gaps with 0xFF; uf2conv may emit fewer blocks by skipping
    // fully-erased regions. More blocks is safe (the bootloader writes 0xFF
    // over erased flash), so this is the direction we want to be in.
    expect(ours().length).toBeGreaterThanOrEqual(ref().length);
  });

  it('writes identical payload bytes for every block the reference emits', () => {
    const refInfo = readUf2(ref());
    const ourInfo = readUf2(ours());

    const oursByAddr = new Map(ourInfo.blocks.map(b => [b.targetAddr, b.payload]));
    let compared = 0;
    let mismatches = 0;
    const mismatchAddrs: number[] = [];

    for (const rb of refInfo.blocks) {
      const ob = oursByAddr.get(rb.targetAddr);
      if (!ob) {
        mismatchAddrs.push(rb.targetAddr);
        mismatches++;
        continue;
      }
      for (let i = 0; i < rb.payload.length; i++) {
        compared++;
        if (ob[i] !== rb.payload[i]) {
          mismatches++;
          if (mismatchAddrs.length < 8) mismatchAddrs.push(rb.targetAddr + i);
          break;
        }
      }
    }

    console.log(`  ref blocks ${refInfo.blocks.length}, compared ${compared} payload bytes`);
    console.log(`  mismatched blocks: ${mismatches}`);
    if (mismatchAddrs.length) {
      console.log('  first mismatch addrs:',
        mismatchAddrs.map(a => '0x' + a.toString(16)).join(', '));
    }
    expect(mismatches).toBe(0);
  });
});