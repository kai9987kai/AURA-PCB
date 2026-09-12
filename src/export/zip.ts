/** Small standards-compliant ZIP writer using stored entries (no compression dependency). */
export function createZip(files: { filename: string; contents: string }[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const entries = files.map(file => {
    if (!file.filename || /[\\/]/.test(file.filename) || file.filename === '..') throw new Error('ZIP entries must have plain filenames.');
    return { name: encoder.encode(file.filename), data: encoder.encode(file.contents) };
  });
  if (entries.length > 65535 || entries.some(e => e.name.length > 65535)) throw new Error('ZIP package exceeds supported entry limits.');
  const localSize = entries.reduce((sum, e) => sum + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  if (localSize + centralSize > 100_000_000) throw new Error('ZIP package exceeds 100 MB.');
  const output = new Uint8Array(localSize + centralSize + 22); const view = new DataView(output.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  let offset = 0; let central = localSize;
  for (const e of entries) {
    const crc = crc32(e.data);
    u32(offset, 0x04034b50); u16(offset + 4, 20); u16(offset + 6, 0x800); u16(offset + 12, 33);
    u32(offset + 14, crc); u32(offset + 18, e.data.length); u32(offset + 22, e.data.length); u16(offset + 26, e.name.length);
    output.set(e.name, offset + 30); output.set(e.data, offset + 30 + e.name.length);
    u32(central, 0x02014b50); u16(central + 4, 20); u16(central + 6, 20); u16(central + 8, 0x800); u16(central + 14, 33);
    u32(central + 16, crc); u32(central + 20, e.data.length); u32(central + 24, e.data.length); u16(central + 28, e.name.length); u32(central + 42, offset);
    output.set(e.name, central + 46);
    offset += 30 + e.name.length + e.data.length; central += 46 + e.name.length;
  }
  u32(central, 0x06054b50); u16(central + 8, entries.length); u16(central + 10, entries.length); u32(central + 12, centralSize); u32(central + 16, localSize);
  return output;
}
