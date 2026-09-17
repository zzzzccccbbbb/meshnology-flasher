/**
 * chipDetect.ts — Translate esptool.js chip name to a user-friendly label.
 *
 * esptool.js reports the chip via loader.chip.CHIP_NAME (e.g. "ESP32-S3",
 * "ESP32-C3", "ESP32", "ESP8266"). We add a stable, non-localized code so
 * the UI can key off it for things like "Show this banner only on S3".
 */

import type { ROM } from 'esptool-js';

export type ChipCode =
  | 'ESP32'
  | 'ESP32-S2'
  | 'ESP32-S3'
  | 'ESP32-C2'
  | 'ESP32-C3'
  | 'ESP32-C5'
  | 'ESP32-C6'
  | 'ESP32-C61'
  | 'ESP32-H2'
  | 'ESP32-P4'
  | 'ESP8266'
  | 'UNKNOWN';

const CHIP_TABLE: Array<{ code: ChipCode; matches: RegExp[] }> = [
  { code: 'ESP32-S3',   matches: [/ESP32-S3/i] },
  { code: 'ESP32-S2',   matches: [/ESP32-S2/i] },
  { code: 'ESP32-C61',  matches: [/ESP32-C61/i] },
  { code: 'ESP32-C6',   matches: [/ESP32-C6(?!1)/i] },
  { code: 'ESP32-C5',   matches: [/ESP32-C5/i] },
  { code: 'ESP32-C3',   matches: [/ESP32-C3/i] },
  { code: 'ESP32-C2',   matches: [/ESP32-C2/i] },
  { code: 'ESP32-H2',   matches: [/ESP32-H2/i] },
  { code: 'ESP32-P4',   matches: [/ESP32-P4/i] },
  { code: 'ESP32',      matches: [/^ESP32$/i] },
  { code: 'ESP8266',    matches: [/ESP8266/i] },
];

export function detectChipCode(rom: ROM | null | undefined): ChipCode {
  if (!rom) return 'UNKNOWN';
  const name = (rom as unknown as { CHIP_NAME?: string }).CHIP_NAME ?? '';
  for (const entry of CHIP_TABLE) {
    if (entry.matches.some(rx => rx.test(name))) return entry.code;
  }
  return 'UNKNOWN';
}

export function isChipKnown(code: ChipCode): boolean {
  return code !== 'UNKNOWN';
}