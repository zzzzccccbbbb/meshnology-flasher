import { describe, it, expect } from 'vitest';
import { STRINGS, type Lang } from './i18n';

describe('i18n strings', () => {
  it('has both en and zh bundles', () => {
    expect(STRINGS.en).toBeTruthy();
    expect(STRINGS.zh).toBeTruthy();
  });
  it('has the same keys in both languages', () => {
    const ek = Object.keys(STRINGS.en).sort();
    const zk = Object.keys(STRINGS.zh).sort();
    expect(ek).toEqual(zk);
  });
  it('EN/ZH differ in copy', () => {
    // Pick a string that's still present in both languages to spot-check
    // that the two locales didn't silently collapse to the same text.
    expect(STRINGS.en.step1Title).not.toBe(STRINGS.zh.step1Title);
    expect(STRINGS.en.terminalLabel).not.toBe(STRINGS.zh.terminalLabel);
  });
  it('filesCount formats plural correctly', () => {
    expect(STRINGS.en.filesCount(1)).toBe('1 file');
    expect(STRINGS.en.filesCount(3)).toBe('3 files');
    expect(STRINGS.zh.filesCount(1)).toBe('1 个文件');
    expect(STRINGS.zh.filesCount(5)).toBe('5 个文件');
  });
  it('Lang type is en | zh', () => {
    const langs: Lang[] = ['en', 'zh'];
    expect(langs.length).toBe(2);
  });
});
