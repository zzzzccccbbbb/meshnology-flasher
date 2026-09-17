/**
 * flashConfig.ts — Bridge between UI flashConfig (loose strings) and
 * esptool.js strict string literal types.
 *
 * UI values:
 *   mode: 'auto' | 'QIO' | 'QOUT' | 'DIO' | 'DOUT'
 *   freq: 'auto' | '40m' | '80m'
 *   size: 'auto' | '1mb' | '2mb' | '4mb' | '8mb' | '16mb'
 *
 * esptool.js values (see node_modules/esptool-js/lib/types/arguments.d.ts):
 *   FlashModeValues: 'keep' | 'dio' | 'qio' | 'dout' | 'qout'
 *   FlashFreqValues: 'keep' | '80m' | '60m' | '48m' | '40m' | '30m' | ...
 *   FlashSizeValues: 'detect' | 'keep' | '256KB' | '512KB' | '1MB' | '2MB' |
 *                    '2MB-c1' | '4MB' | '4MB-c1' | '8MB' | '16MB' | '32MB' |
 *                    '64MB' | '128MB'
 *
 * 'auto' from the UI maps to 'detect' (size) / esptool's default (mode/freq).
 * For mode/freq, we don't pass any value and let esptool pick (the API is
 * `flashMode?: FlashModeValues` with optional, so omitting means "auto-detect
 * from ROM").
 */

import type {
  FlashFreqValues,
  FlashModeValues,
  FlashSizeValues,
} from 'esptool-js';

export interface FlashConfigUi {
  mode: string;   // 'auto' | 'QIO' | 'QOUT' | 'DIO' | 'DOUT'
  freq: string;   // 'auto' | '40m' | '80m'
  size: string;   // 'auto' | '1mb' | '2mb' | '4mb' | '8mb' | '16mb'
}

export interface FlashConfigEsp {
  flashMode?: FlashModeValues;
  flashFreq?: FlashFreqValues;
  flashSize: FlashSizeValues;
}

const MODE_MAP: Record<string, FlashModeValues> = {
  QIO: 'qio',
  QOUT: 'qout',
  DIO: 'dio',
  DOUT: 'dout',
};

const FREQ_MAP: Record<string, FlashFreqValues> = {
  '40m': '40m',
  '80m': '80m',
};

const SIZE_MAP: Record<string, FlashSizeValues> = {
  '1mb': '1MB',
  '2mb': '2MB',
  '4mb': '4MB',
  '8mb': '8MB',
  '16mb': '16MB',
};

export function toEspConfig(ui: FlashConfigUi): FlashConfigEsp {
  return {
    flashMode: ui.mode === 'auto' ? undefined : MODE_MAP[ui.mode],
    flashFreq: ui.freq === 'auto' ? undefined : FREQ_MAP[ui.freq],
    flashSize: ui.size === 'auto' ? 'detect' : SIZE_MAP[ui.size] ?? 'detect',
  };
}

/** Used for UI display and the flash-config JSON log. */
export function describeUiConfig(ui: FlashConfigUi): string {
  const fmt = (v: string, fallback: string) => (v === 'auto' ? fallback : v);
  return [
    `mode=${fmt(ui.mode, 'auto')}`,
    `freq=${fmt(ui.freq, 'auto')}`,
    `size=${fmt(ui.size, 'detect')}`,
  ].join(', ');
}