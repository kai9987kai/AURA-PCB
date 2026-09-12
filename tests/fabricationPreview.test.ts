import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGerberLayers } from '../src/export/gerber.ts';
import { parseGeneratedGerber } from '../src/export/gerberPreview.ts';
import { createZip } from '../src/export/zip.ts';
import { emptyProject } from '../src/project/projectFile.ts';

test('preview reads actual exported pour polarity, apertures, and mask openings', () => {
  const p = emptyProject();
  p.pcbLayout.pours = [{ id: 'g', net: 'GND', layer: 'top', margin: 1, clearance: 0.25 }];
  p.pcbLayout.traces = [{ id: 't', net: 'SIG', layer: 'top', width: 0.4, points: [{ x: 5, y: 5 }, { x: 10, y: 5 }] }];
  p.pcbLayout.vias = [{ id: 'v', net: 'SIG', x: 10, y: 5, diameter: 1, drillDiameter: 0.4 }];
  const layers = buildGerberLayers(p.pcbLayout);
  const copper = parseGeneratedGerber(layers.find(l => l.id === 'topCopper')!.contents);
  assert.equal(copper[0].kind, 'region');
  assert.ok(copper.some(c => c.kind === 'stroke' && !c.dark && c.width === 0.9));
  assert.ok(copper.some(c => c.kind === 'stroke' && c.dark && c.width === 0.4 && c.from.y === 50));
  const mask = parseGeneratedGerber(layers.find(l => l.id === 'topMask')!.contents);
  assert.equal(mask.length, 1); assert.equal(mask[0].kind, 'flash');
  assert.ok(!mask.some(c => c.kind === 'region'));
});
test('ZIP contains complete UTF-8 entries, CRC32, and correct directory offsets', () => {
  const zip = createZip([{ filename: 'board.GTL', contents: '123456789' }, { filename: 'notes.txt', contents: 'micro µ' }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  assert.equal(view.getUint16(6, true), 0x800);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  const central = view.getUint32(end + 16, true);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint32(central + 42, true), 0);
  const start = 30 + view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(zip.slice(start, start + 9)), '123456789');
  assert.throws(() => createZip([{ filename: '../bad', contents: '' }]), /plain filenames/);
});
