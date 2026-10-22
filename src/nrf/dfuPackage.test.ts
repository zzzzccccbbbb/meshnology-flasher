import { describe, it, expect } from 'vitest';
import { parseDfuPackage, describeDfuPackage, DfuPackageError } from './dfuPackage';

/** Build a stored-only ZIP in memory, enough for the reader to work on. */
function makeZip(files: Array<{ name: string; data: Uint8Array; method?: number }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const method = f.method ?? 0;
    const crc = 0; // not verified by the reader

    const local = new Uint8Array(30 + nameBytes.length + f.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);       // version needed
    lv.setUint16(6, 0, true);        // flags
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(f.data, 30 + nameBytes.length);
    chunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const MANIFEST = JSON.stringify({
  manifest: {
    application: {
      bin_file: 'firmware.bin',
      dat_file: 'firmware.dat',
      init_packet_data: {
        application_version: 4294967295,
        device_revision: 44463,
        device_type: 82,
        firmware_crc16: 60009,
        softdevice_req: [291],
      },
    },
    dfu_version: 0.5,
  },
});

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseDfuPackage', () => {
  it('reads a well-formed stored package', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'firmware.bin', data: Uint8Array.from([1, 2, 3, 4, 5]) },
      { name: 'firmware.dat', data: Uint8Array.from([0x52, 0x00, 0xaf, 0xad, 0xff, 0xff]) },
    ]);
    const pkg = parseDfuPackage(zip);
    expect(pkg.image.byteLength).toBe(5);
    expect([...pkg.image]).toEqual([1, 2, 3, 4, 5]);
    expect(pkg.initPacket.byteLength).toBe(6);
    expect(pkg.softdeviceReq).toEqual([291]);
    expect(pkg.softdeviceReqLabel).toBe('0x0123');
    expect(pkg.manifest.bin_file).toBe('firmware.bin');
  });

  it('reports device type and revision in hex', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'firmware.bin', data: new Uint8Array(4096) },
      { name: 'firmware.dat', data: new Uint8Array(14) },
    ]);
    const line = describeDfuPackage(parseDfuPackage(zip), 0x27000);
    expect(line).toMatch(/device type 0x52/);
    expect(line).toMatch(/rev 0xadaf/);
    expect(line).toMatch(/needs SoftDevice 0x0123/);
    expect(line).toMatch(/0x27000/);
  });

  it('counts flash pages by rounding up', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'firmware.bin', data: new Uint8Array(4096 * 2 + 1) },
      { name: 'firmware.dat', data: new Uint8Array(14) },
    ]);
    expect(describeDfuPackage(parseDfuPackage(zip), 0)).toMatch(/3 flash pages/);
  });

  it('honours a manifest that renames the entries', () => {
    const manifest = JSON.stringify({
      manifest: { application: { bin_file: 'app.bin', dat_file: 'app.dat' }, dfu_version: 0.5 },
    });
    const zip = makeZip([
      { name: 'manifest.json', data: enc(manifest) },
      { name: 'app.bin', data: Uint8Array.from([9, 9]) },
      { name: 'app.dat', data: new Uint8Array(14) },
    ]);
    const pkg = parseDfuPackage(zip);
    expect([...pkg.image]).toEqual([9, 9]);
    expect(pkg.softdeviceReqLabel).toBeNull();
  });

  it('tolerates a manifest with no softdevice_req', () => {
    const manifest = JSON.stringify({
      manifest: { application: { bin_file: 'firmware.bin', dat_file: 'firmware.dat' } },
    });
    const zip = makeZip([
      { name: 'manifest.json', data: enc(manifest) },
      { name: 'firmware.bin', data: new Uint8Array(16) },
      { name: 'firmware.dat', data: new Uint8Array(14) },
    ]);
    expect(parseDfuPackage(zip).softdeviceReq).toEqual([]);
  });

  it('rejects an archive with no manifest.json', () => {
    const zip = makeZip([{ name: 'firmware.bin', data: new Uint8Array(4) }]);
    expect(() => parseDfuPackage(zip)).toThrow(/no manifest\.json/);
  });

  it('rejects a manifest naming a missing bin', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'something-else.bin', data: new Uint8Array(4) },
    ]);
    expect(() => parseDfuPackage(zip)).toThrow(/does not contain it/);
  });

  it('rejects a manifest with no application block', () => {
    const zip = makeZip([{ name: 'manifest.json', data: enc('{"manifest":{}}') }]);
    expect(() => parseDfuPackage(zip)).toThrow(/bin_file/);
  });

  it('rejects invalid JSON', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc('{not json') },
      { name: 'firmware.bin', data: new Uint8Array(4) },
    ]);
    expect(() => parseDfuPackage(zip)).toThrow(/not valid JSON/);
  });

  it('rejects a non-ZIP buffer', () => {
    expect(() => parseDfuPackage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])))
      .toThrow(DfuPackageError);
  });

  it('names the method when an entry is deflated', () => {
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'firmware.bin', data: new Uint8Array(4), method: 8 },
      { name: 'firmware.dat', data: new Uint8Array(14) },
    ]);
    expect(() => parseDfuPackage(zip)).toThrow(/deflate-compressed \(method 8\)/);
  });

  it('survives a large image without truncation', () => {
    const big = new Uint8Array(462620);
    big[0] = 0x00; big[1] = 0x00; big[2] = 0x04; big[3] = 0x20;
    big.fill(0xab, 8);
    const zip = makeZip([
      { name: 'manifest.json', data: enc(MANIFEST) },
      { name: 'firmware.bin', data: big },
      { name: 'firmware.dat', data: new Uint8Array(14) },
    ]);
    const pkg = parseDfuPackage(zip);
    expect(pkg.image.byteLength).toBe(462620);
    expect([...pkg.image.subarray(0, 8)]).toEqual([...big.subarray(0, 8)]);
  });
});