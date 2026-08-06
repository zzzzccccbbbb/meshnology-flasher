import { describe, it, expect } from 'vitest';
import { validateSegments, detectBrowserSupport } from './flasher';

describe('firmware validation', () => {
  it('accepts non-overlapping aligned segments', () => {
    expect(validateSegments([{name:'a.bin', offset:0, size:4096},{name:'b.bin', offset:0x1000,size:1024}])).toEqual([]);
  });
  it('rejects overlaps and invalid offsets', () => {
    expect(validateSegments([{name:'a.bin',offset:0,size:8192},{name:'b.bin',offset:0x1000,size:10}]).length).toBeGreaterThan(0);
    expect(validateSegments([{name:'x.bin',offset:-1,size:1}]).length).toBeGreaterThan(0);
  });
});

describe('browser support', () => {
  it('reports WebUSB and WebSerial independently', () => {
    expect(detectBrowserSupport({usb:{},serial:{}} as any)).toEqual({webUsb:true,webSerial:true});
    expect(detectBrowserSupport({} as any)).toEqual({webUsb:false,webSerial:false});
  });
});

