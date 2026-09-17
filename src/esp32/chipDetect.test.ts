/**
 * chipDetect.test.ts — verify CHIP_NAME → ChipCode mapping for all 11 chips
 * plus the UNKNOWN fallback.
 */
import { describe, it, expect } from 'vitest';
import { detectChipCode, isChipKnown, type ChipCode } from './chipDetect';

const cases: Array<[string, ChipCode]> = [
  // [chip name from esptool, expected code]
  ['ESP32',                'ESP32'],
  ['ESP32-S3',             'ESP32-S3'],
  ['ESP32-S2',             'ESP32-S2'],
  ['ESP32-C2',             'ESP32-C2'],
  ['ESP32-C3',             'ESP32-C3'],
  ['ESP32-C5',             'ESP32-C5'],
  ['ESP32-C6',             'ESP32-C6'],
  ['ESP32-C61',            'ESP32-C61'],
  ['ESP32-H2',             'ESP32-H2'],
  ['ESP32-P4',             'ESP32-P4'],
  ['ESP8266',              'ESP8266'],
  ['unknown-rom-name',     'UNKNOWN'],
  ['',                     'UNKNOWN'],
];

describe('detectChipCode', () => {
  for (const [name, expected] of cases) {
    it(`maps "${name}" → ${expected}`, () => {
      const rom = { CHIP_NAME: name } as unknown as Parameters<typeof detectChipCode>[0];
      expect(detectChipCode(rom)).toBe(expected);
    });
  }

  it('returns UNKNOWN for null', () => {
    expect(detectChipCode(null)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for undefined', () => {
    expect(detectChipCode(undefined)).toBe('UNKNOWN');
  });

  // tricky: ESP32-C6 must NOT match when name is "ESP32-C61"
  it('does not confuse C6 with C61', () => {
    const rom = { CHIP_NAME: 'ESP32-C61' } as unknown as Parameters<typeof detectChipCode>[0];
    expect(detectChipCode(rom)).toBe('ESP32-C61');
  });

  it('does not confuse C61 with C6', () => {
    const rom = { CHIP_NAME: 'ESP32-C6' } as unknown as Parameters<typeof detectChipCode>[0];
    expect(detectChipCode(rom)).toBe('ESP32-C6');
  });
});

describe('isChipKnown', () => {
  it('returns true for known chips', () => {
    expect(isChipKnown('ESP32-S3')).toBe(true);
  });
  it('returns false for UNKNOWN', () => {
    expect(isChipKnown('UNKNOWN')).toBe(false);
  });
});