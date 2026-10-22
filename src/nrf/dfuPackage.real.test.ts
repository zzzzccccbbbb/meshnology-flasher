import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDfuPackage, describeDfuPackage } from './dfuPackage';

/**
 * Parse the real DFU package produced by adafruit-nrfutil for the W13.
 *
 * Fixture is not committed; when absent the suite skips. To regenerate:
 *
 *   wsl -d Ubuntu-22.04 bash -lc \
 *     'base64 -w0 ~/platformIO/w13/MeshCore/.pio/build/\
 *      W13Meshnology_companion_radio_ble/w13-meshnology.dfu' \
 *     | tr -d '\0\r\n' | base64 -d > .tmp-w13.dfu
 */
const FIXTURE = resolve(__dirname, '../../.tmp-w13.dfu');
const hasFixture = existsSync(FIXTURE);
const bytes = () => new Uint8Array(readFileSync(FIXTURE));

describe.skipIf(!hasFixture)('W13 DFU package (real)', () => {
  it('unpacks and reports the SoftDevice requirement', () => {
    const pkg = parseDfuPackage(bytes());
    // The build logs sd-req 0x0123, i.e. S140 7.3.0.
    expect(pkg.softdeviceReq).toEqual([0x0123]);
    expect(pkg.softdeviceReqLabel).toBe('0x0123');
    expect(pkg.initPacket.byteLength).toBe(14);
  });

  it('extracts the application image with a valid vector table', () => {
    const pkg = parseDfuPackage(bytes());
    const view = new DataView(pkg.image.buffer, pkg.image.byteOffset, pkg.image.byteLength);
    const sp = view.getUint32(0, true);
    const reset = view.getUint32(4, true);
    // Initial stack pointer must land in SRAM, reset vector in flash.
    expect(sp).toBeGreaterThanOrEqual(0x20000000);
    expect(sp).toBeLessThanOrEqual(0x20080000);
    expect(reset).toBeGreaterThanOrEqual(0x27000);
    expect(reset).toBeLessThan(0x100000);
  });

  it('matches the payload size of the sibling firmware.hex', () => {
    const pkg = parseDfuPackage(bytes());
    // Both are the application only; the hex span is 0x027000..0x097f1c.
    expect(pkg.image.byteLength).toBe(462620);
  });

  it('describes itself in one line', () => {
    const line = describeDfuPackage(parseDfuPackage(bytes()), 0x27000);
    console.log('  ' + line);
    expect(line).toMatch(/451\.8 KB at 0x27000/);
    expect(line).toMatch(/113 flash pages/);
  });
});