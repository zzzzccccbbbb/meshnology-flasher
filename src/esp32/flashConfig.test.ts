/**
 * flashConfig.test.ts — verify UI string → esptool.js typed-literal mapping.
 */
import { describe, it, expect } from 'vitest';
import { toEspConfig, describeUiConfig, type FlashConfigUi } from './flashConfig';

const ALL_AUTO: FlashConfigUi = { mode: 'auto', freq: 'auto', size: 'auto' };

describe('toEspConfig', () => {
  it('auto/auto/auto → undefined, undefined, detect', () => {
    const esp = toEspConfig(ALL_AUTO);
    expect(esp.flashMode).toBeUndefined();
    expect(esp.flashFreq).toBeUndefined();
    expect(esp.flashSize).toBe('detect');
  });

  it('QIO/40m/16mb → qio, 40m, 16MB', () => {
    const esp = toEspConfig({ mode: 'QIO', freq: '40m', size: '16mb' });
    expect(esp.flashMode).toBe('qio');
    expect(esp.flashFreq).toBe('40m');
    expect(esp.flashSize).toBe('16MB');
  });

  it.each([
    ['QIO',  'qio'],
    ['QOUT', 'qout'],
    ['DIO',  'dio'],
    ['DOUT', 'dout'],
  ] as const)('mode %s → %s', (ui, esp) => {
    expect(toEspConfig({ mode: ui, freq: 'auto', size: 'auto' }).flashMode).toBe(esp);
  });

  it.each([
    ['1mb',  '1MB'],
    ['2mb',  '2MB'],
    ['4mb',  '4MB'],
    ['8mb',  '8MB'],
    ['16mb', '16MB'],
  ] as const)('size %s → %s', (ui, esp) => {
    expect(toEspConfig({ mode: 'auto', freq: 'auto', size: ui }).flashSize).toBe(esp);
  });

  it('falls back to detect on unknown size', () => {
    const esp = toEspConfig({ mode: 'auto', freq: 'auto', size: '99mb' });
    expect(esp.flashSize).toBe('detect');
  });
});

describe('describeUiConfig', () => {
  it('all-auto → mode=auto, freq=auto, size=detect', () => {
    expect(describeUiConfig(ALL_AUTO)).toBe('mode=auto, freq=auto, size=detect');
  });
  it('user-picked → explicit values', () => {
    expect(describeUiConfig({ mode: 'DIO', freq: '80m', size: '8mb' }))
      .toBe('mode=DIO, freq=80m, size=8mb');
  });
});