import { describe, it, expect } from 'vitest';
import {
  parseInfoTxt,
  uf2ErrorToMessage,
  Uf2Error,
  isWebUsbAvailable,
  NRF52840_USB_IDS,
} from './uf2Transport';

describe('parseInfoTxt', () => {
  const FULL = [
    '# MicroPython UF2 boot script',
    'UF2VERSION: 0.3.0',
    'VBAT: 3.3',
    'FamilyID: 0xada52840',
    'FlashStart: 0x0',
    'FlashSize: 0x80000',
    'NumBlocks: 0x800',
    'SectorSize: 0x1000',
    'Programmed: ',
    '',
  ].join('\n');

  it('reads a complete bootloader info file', () => {
    const info = parseInfoTxt(FULL);
    expect(info.familyId).toBe(0xada52840);
    expect(info.flashBase).toBe(0);
    expect(info.numSectors).toBe(0x800);
    expect(info.sectorSize).toBe(512);
    expect(info.programmed).toBe(true);
    expect(info.raw).toBe(FULL);
  });

  it('is case-insensitive on keys and tolerates CRLF', () => {
    const info = parseInfoTxt(
      'familyid: 0xADA52840\r\nnumblocks: 0x800\r\nflash_start: 0x0\r\n',
    );
    expect(info.familyId).toBe(0xada52840);
    expect(info.numSectors).toBe(0x800);
  });

  it('applies the documented defaults for optional keys', () => {
    const info = parseInfoTxt('FamilyID: 0xada52840\nNumBlocks: 100\n');
    expect(info.flashBase).toBe(0);
    expect(info.programmed).toBe(false);
  });

  it('skips comments and blank lines', () => {
    const info = parseInfoTxt([
      '# a comment',
      '',
      '   ',
      'FamilyID: 0xada52840',
      '# another',
      'NumBlocks: 0x800',
    ].join('\n'));
    expect(info.familyId).toBe(0xada52840);
  });

  it('throws INFO_UNREADABLE when FamilyID is missing', () => {
    expect(() => parseInfoTxt('NumBlocks: 0x800')).toThrow(/FamilyID/);
    try {
      parseInfoTxt('NumBlocks: 0x800');
    } catch (e) {
      expect((e as Uf2Error).kind).toBe('INFO_UNREADABLE');
    }
  });

  it('throws INFO_UNREADABLE when NumBlocks is missing', () => {
    expect(() => parseInfoTxt('FamilyID: 0xada52840')).toThrow(/NumBlocks/);
  });

  it('throws on an empty file', () => {
    expect(() => parseInfoTxt('')).toThrow(/FamilyID/);
  });
});

describe('uf2ErrorToMessage', () => {
  it('tells the user how to get into bootloader mode', () => {
    const { message } = uf2ErrorToMessage(new Uf2Error('NO_BOOTLOADER', 'raw'));
    expect(message).toMatch(/RESET/);
    expect(message).toMatch(/BOOT/);
  });

  it('names Chrome or Edge for the WebUSB case', () => {
    const { message } = uf2ErrorToMessage(new Uf2Error('NO_WEBUSB', 'raw'));
    expect(message).toMatch(/Chrome|Edge/);
  });

  it('labels a family mismatch as a wrong-chip problem', () => {
    const { message } = uf2ErrorToMessage(
      new Uf2Error('FAMILY_MISMATCH', 'bootloader family 0x1234'),
    );
    expect(message).toMatch(/[Ww]rong chip/);
  });

  it('labels an out-of-range block as a size problem', () => {
    const { message } = uf2ErrorToMessage(
      new Uf2Error('ADDRESS_OUT_OF_RANGE', 'block 5 targets 0x900000'),
    );
    expect(message).toMatch(/does not fit/);
  });

  it('passes a verify timeout through unchanged', () => {
    const { message, kind } = uf2ErrorToMessage(
      new Uf2Error('VERIFY_TIMEOUT', '4 of 1968 blocks were not confirmed'),
    );
    expect(kind).toBe('VERIFY_TIMEOUT');
    expect(message).toMatch(/1968/);
  });

  it('falls back to TRANSFER_FAILED for a plain Error', () => {
    const { kind, message } = uf2ErrorToMessage(new Error('boom'));
    expect(kind).toBe('TRANSFER_FAILED');
    expect(message).toBe('boom');
  });

  it('stringifies non-Error throws', () => {
    const { kind } = uf2ErrorToMessage('weird');
    expect(kind).toBe('TRANSFER_FAILED');
  });
});

describe('environment', () => {
  it('reports WebUSB availability without throwing', () => {
    expect(typeof isWebUsbAvailable()).toBe('boolean');
  });

  it('ships the nRF52840 bootloader USB ids', () => {
    expect(NRF52840_USB_IDS.length).toBeGreaterThan(0);
    for (const id of NRF52840_USB_IDS) {
      expect(id.vendorId).toBe(0x1915);       // Nordic
      expect(typeof id.productId).toBe('number');
    }
  });
});