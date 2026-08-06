export type FirmwareSegment = { name: string; offset: number; size: number };
export function validateSegments(segments: FirmwareSegment[]): string[] {
  const errors: string[] = [];
  const sorted = [...segments].sort((a,b)=>a.offset-b.offset);
  for (const s of sorted) {
    if (!Number.isInteger(s.offset) || s.offset < 0) errors.push(`${s.name}: 地址必须是非负整数`);
    if (!Number.isInteger(s.size) || s.size <= 0) errors.push(`${s.name}: 文件为空或大小无效`);
    if (s.offset % 4 !== 0) errors.push(`${s.name}: 地址应按 4 字节对齐`);
  }
  for (let i=1;i<sorted.length;i++) if (sorted[i-1].offset + sorted[i-1].size > sorted[i].offset) errors.push(`${sorted[i-1].name} 与 ${sorted[i].name} 地址范围重叠`);
  return errors;
}
export function detectBrowserSupport(nav: {usb?: unknown; serial?: unknown}): {webUsb:boolean;webSerial:boolean} {
  return { webUsb: !!nav.usb, webSerial: !!nav.serial };
}
