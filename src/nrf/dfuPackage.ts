/**
 * dfuPackage.ts — Read an Adafruit/Nordic DFU package (.dfu / .zip).
 *
 * A DFU package is a ZIP holding three entries:
 *
 *   manifest.json   dfu_version, and the application block naming which
 *                   .bin carries the image and which .dat is the init packet
 *   firmware.bin    the application image, flat — starting with the ARM
 *                   vector table (SP, reset vector), not a Nordic container
 *   firmware.dat    the 14-byte SoftDevice init packet: device type and
 *                   revision, softdevice size, softdevice_req, crc16
 *
 * Only firmware.bin is needed to write over serial DFU. The init packet's
 * page list is regenerated at flash time from the image length and base
 * address (see src/nrf/nrfDfu.ts), and the .dat's device/revision/
 * softdevice_req fields are informational for us — the bootloader enforces
 * them itself.
 *
 * ZIP handling: the packages PlatformIO's adafruit-nrfutil produces store
 * their entries uncompressed (method 0), so no inflate is needed. Deflate is
 * rejected with a clear message rather than silently mis-parsed. Browsers do
 * have DecompressionStream('deflate-raw') for the other case if it ever comes
 * up.
 *
 * Verified against the W13 OLED build:
 *   w13-meshnology.dfu -> manifest.json 465 B, firmware.bin 462,620 B,
 *   firmware.dat 14 B, all stored. firmware.bin is byte-identical to the
 *   payload of the sibling firmware.hex, whose span is 0x027000..0x097f1c.
 */

export interface DfuManifestApplication {
  bin_file: string;
  dat_file: string;
  init_packet_data?: {
    application_version?: number;
    device_revision?: number;
    device_type?: number;
    firmware_crc16?: number;
    softdevice_req?: number[];
  };
}

export interface DfuPackage {
  manifest: DfuManifestApplication;
  /** The application image, flat. */
  image: Uint8Array;
  /** The raw .dat bytes, kept so the caller can report softdevice_req. */
  initPacket: Uint8Array;
  /** SoftDevice firmware IDs the package requires, e.g. [0x0123]. */
  softdeviceReq: number[];
  /** The application's SoftDevice requirement as a hex string, or null. */
  softdeviceReqLabel: string | null;
}

export class DfuPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DfuPackageError';
  }
}

/* ------------------------------------------------------------------ *
 *  Minimal ZIP reader (stored entries only)
 * ------------------------------------------------------------------ */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  // The EOCD record sits in the last 22 bytes plus up to 64 KiB of comment.
  const maxBack = Math.min(bytes.length, 0x10000 + 22);
  for (let i = 22; i <= maxBack; i++) {
    const at = bytes.length - i;
    if (at < 0) break;
    if (viewOf(bytes).getUint32(at, true) === EOCD_SIG) return at;
  }
  throw new DfuPackageError('not a ZIP archive: end-of-central-directory record not found');
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = viewOf(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== CENTRAL_SIG) {
      throw new DfuPackageError('corrupt ZIP: bad central directory signature');
    }
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractStoredEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.method !== 0) {
    throw new DfuPackageError(
      `${entry.name} is deflate-compressed (method ${entry.method}); ` +
      'only stored ZIP entries are supported',
    );
  }
  const view = viewOf(bytes);
  const lo = entry.localOffset;
  if (view.getUint32(lo, true) !== LOCAL_SIG) {
    throw new DfuPackageError(`corrupt ZIP: bad local header for ${entry.name}`);
  }
  const nameLen = view.getUint16(lo + 26, true);
  const extraLen = view.getUint16(lo + 28, true);
  const start = lo + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + entry.uncompressedSize);
}

/* ------------------------------------------------------------------ *
 *  Package parsing
 * ------------------------------------------------------------------ */

/**
 * Parse a DFU package.
 *
 * The manifest names the bin and dat entries rather than assuming the
 * conventional filenames, so a package built by a different tool still
 * resolves.
 */
export function parseDfuPackage(bytes: Uint8Array): DfuPackage {
  const entries = readZipDirectory(bytes);

  const manifestEntry = entries.get('manifest.json');
  if (!manifestEntry) {
    throw new DfuPackageError('DFU package has no manifest.json');
  }
  let parsed: { manifest?: { application?: DfuManifestApplication } };
  try {
    parsed = JSON.parse(new TextDecoder().decode(extractStoredEntry(bytes, manifestEntry)));
  } catch (e) {
    throw new DfuPackageError(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }

  const app = parsed.manifest?.application;
  if (!app?.bin_file) {
    throw new DfuPackageError('manifest.json has no manifest.application.bin_file');
  }

  const binEntry = entries.get(app.bin_file);
  if (!binEntry) {
    throw new DfuPackageError(
      `manifest names ${app.bin_file} but the archive does not contain it ` +
      `(has: ${[...entries.keys()].join(', ')})`,
    );
  }
  const image = extractStoredEntry(bytes, binEntry);

  let initPacket = new Uint8Array(0);
  if (app.dat_file) {
    const datEntry = entries.get(app.dat_file);
    if (datEntry) initPacket = extractStoredEntry(bytes, datEntry);
  }

  const req = app.init_packet_data?.softdevice_req ?? [];
  const softdeviceReq = req.filter(n => Number.isFinite(n));
  const softdeviceReqLabel = softdeviceReq.length
    ? softdeviceReq.map(n => '0x' + n.toString(16).padStart(4, '0')).join(' / ')
    : null;

  return {
    manifest: app,
    image: image.slice(),
    initPacket: initPacket.slice(),
    softdeviceReq,
    softdeviceReqLabel,
  };
}

/** One-line human summary for the terminal pane. */
export function describeDfuPackage(pkg: DfuPackage, baseAddress: number): string {
  const kb = (pkg.image.byteLength / 1024).toFixed(1);
  const pages = Math.ceil(pkg.image.byteLength / 4096);
  const sd = pkg.softdeviceReqLabel ? `, needs SoftDevice ${pkg.softdeviceReqLabel}` : '';
  return `${kb} KB at 0x${baseAddress.toString(16)}, ${pages} flash pages, ` +
    `device type 0x${(pkg.manifest.init_packet_data?.device_type ?? 0).toString(16)}` +
    ` rev 0x${(pkg.manifest.init_packet_data?.device_revision ?? 0).toString(16)}${sd}`;
}