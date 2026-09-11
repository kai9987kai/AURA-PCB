import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCentroidCsv, buildExcellonDrill, buildFabricationPackage, buildGerberLayers,
  MASK_EXPANSION_MM,
} from '../src/export/gerber.ts';
import type { GerberLayerId } from '../src/export/gerber.ts';
import type { PCBFootprint, PCBLayoutData, PCBTrace, PCBVia, SchematicData } from '../src/types/pcb.ts';

const BOARD_HEIGHT = 20;
const board = (overrides: Partial<PCBLayoutData> = {}): PCBLayoutData => ({
  boardWidth: 40, boardHeight: BOARD_HEIGHT, footprints: [], traces: [], vias: [], pours: [], ...overrides,
});
const part = (id: string, x: number, y: number, holeDiameter: number, rotation = 0): PCBFootprint => ({
  id, componentId: id, type: 'resistor', x, y, rotation, width: 4, height: 2, isPlaced: true,
  pads: [{ id: '1', relX: 0, relY: 0, diameter: 1.6, holeDiameter }],
});
const trace = (points: [number, number][], layer: 'top' | 'bottom' = 'top'): PCBTrace => ({
  id: 't1', net: 'N1', layer, width: 0.4, points: points.map(([x, y]) => ({ x, y })),
});
const via = (x: number, y: number): PCBVia => ({ id: 'v1', net: 'N1', x, y, diameter: 0.8, drillDiameter: 0.4 });

const layerOf = (layout: PCBLayoutData, id: GerberLayerId) => {
  const found = buildGerberLayers(layout).find(layer => layer.id === id);
  assert.ok(found, `expected a ${id} layer`);
  return found.contents;
};
/** Coordinate pairs as emitted, in integer units of 1e-6 mm. */
const coordinates = (gerber: string) => [...gerber.matchAll(/^X(-?\d+)Y(-?\d+)D0([123])\*$/gm)]
  .map(([, x, y, op]) => ({ x: Number(x), y: Number(y), op: Number(op) }));

test('every copper feature is reflected about the board height exactly once', () => {
  // The editor works in screen coordinates (y down); Gerber is y up. A missed or doubled
  // reflection mirrors the board and scraps the panel, so pin the exact emitted value.
  const layout = board({ footprints: [part('R1', 10, 5, 0.8)], vias: [via(20, 2)], traces: [trace([[4, 1], [30, 19]])] });
  const flashes = coordinates(layerOf(layout, 'topCopper')).filter(c => c.op === 3);
  assert.ok(flashes.some(c => c.x === 10e6 && c.y === (BOARD_HEIGHT - 5) * 1e6), 'pad reflected');
  assert.ok(flashes.some(c => c.x === 20e6 && c.y === (BOARD_HEIGHT - 2) * 1e6), 'via reflected');

  const strokes = coordinates(layerOf(layout, 'topCopper')).filter(c => c.op !== 3);
  assert.deepEqual(strokes.map(c => c.y), [(BOARD_HEIGHT - 1) * 1e6, (BOARD_HEIGHT - 19) * 1e6]);
});

test('a feature near the top of the editor lands near the top of the Gerber', () => {
  const high = coordinates(layerOf(board({ footprints: [part('R1', 10, 1, 0.8)] }), 'topCopper'))[0];
  const low = coordinates(layerOf(board({ footprints: [part('R1', 10, 19, 0.8)] }), 'topCopper'))[0];
  assert.ok(high.y > low.y, 'the part drawn higher on screen must have the larger Gerber Y');
});

test('coordinates are whole 4.6 units that read back as the original millimetres', () => {
  const gerber = layerOf(board({ footprints: [part('R1', 12.3456, 7.6543, 0.8)] }), 'topCopper');
  assert.match(gerber, /%FSLAX46Y46\*%/);
  assert.match(gerber, /%MOMM\*%/);
  assert.doesNotMatch(gerber, /^X[-\d]*\.\d/m, 'a coordinate may never carry a decimal point');
  const [flash] = coordinates(gerber);
  assert.equal(flash.x / 1e6, 12.3456);
  assert.equal(flash.y / 1e6, BOARD_HEIGHT - 7.6543);
});

test('every aperture is defined before use and equal sizes share one D-code', () => {
  const layout = board({
    footprints: [part('R1', 8, 5, 0.8), part('R2', 16, 5, 0.8), part('R3', 24, 5, 0)],
    traces: [trace([[4, 2], [30, 2]]), { ...trace([[4, 12], [30, 12]]), id: 't2' }],
  });
  for (const layer of buildGerberLayers(layout)) {
    const defined = new Set([...layer.contents.matchAll(/^%ADD(\d+)[CR],/gm)].map(([, code]) => code));
    const used = new Set([...layer.contents.matchAll(/^D(\d+)\*$/gm)].map(([, code]) => code));
    for (const code of used) assert.ok(defined.has(code), `${layer.id} selects undefined D${code}`);
    const specs = [...layer.contents.matchAll(/^%ADD\d+([CR],[\dX.]+)\*%$/gm)].map(([, spec]) => spec);
    assert.equal(specs.length, new Set(specs).size, `${layer.id} defines a duplicate aperture`);
  }
  // Three identical 1.6mm pads and two identical 0.4mm traces collapse to two apertures.
  assert.equal([...layerOf(layout, 'topCopper').matchAll(/^%ADD/gm)].length, 2);
});

test('a plated hole reaches both copper layers and the drill file; an SMD pad reaches neither', () => {
  const layout = board({ footprints: [part('R1', 10, 5, 0.8), part('U1', 25, 5, 0)] });
  const throughHole = { x: 10e6, y: (BOARD_HEIGHT - 5) * 1e6 };
  const surfaceMount = { x: 25e6, y: (BOARD_HEIGHT - 5) * 1e6 };
  const has = (id: GerberLayerId, at: { x: number; y: number }) =>
    coordinates(layerOf(layout, id)).some(c => c.x === at.x && c.y === at.y);

  assert.ok(has('topCopper', throughHole) && has('bottomCopper', throughHole), 'plated pad is on both layers');
  assert.ok(has('topCopper', surfaceMount), 'SMD pad is on the top layer');
  assert.ok(!has('bottomCopper', surfaceMount), 'SMD pad must not appear on the bottom layer');
  assert.ok(has('topPaste', surfaceMount) && !has('topPaste', throughHole), 'paste covers SMD pads only');

  const drill = buildExcellonDrill(layout);
  assert.match(drill, /^X10\.000Y15\.000$/m);
  assert.doesNotMatch(drill, /^X25\.000/m, 'an SMD pad has no hole to drill');
});

test('a via is drilled once and appears on both copper layers', () => {
  const layout = board({ vias: [via(20, 10)] });
  assert.ok(coordinates(layerOf(layout, 'topCopper')).length === 1);
  assert.ok(coordinates(layerOf(layout, 'bottomCopper')).length === 1);
  assert.equal([...buildExcellonDrill(layout).matchAll(/^X20\.000Y10\.000$/gm)].length, 1);
});

test('soldermask opens wider than the copper it clears', () => {
  const layout = board({ footprints: [part('R1', 10, 5, 0.8)] });
  const size = (id: GerberLayerId) => Number(/^%ADD\d+C,([\d.]+)\*%$/m.exec(layerOf(layout, id))?.[1]);
  // Aperture sizes are snapped to the coordinate grid, so compare well inside that grid
  // rather than against raw float arithmetic.
  assert.ok(Math.abs(size('topMask') - (size('topCopper') + 2 * MASK_EXPANSION_MM)) < 1e-6);
});

test('the drill declares one tool per distinct diameter and selects one before any hole', () => {
  const layout = board({
    footprints: [part('R1', 8, 5, 0.8), part('R2', 16, 5, 0.8), part('R3', 24, 5, 1.0)],
    vias: [via(30, 10)],
  });
  const drill = buildExcellonDrill(layout);
  const tools = [...drill.matchAll(/^T(\d+)C([\d.]+)$/gm)].map(([, code, diameter]) => ({ code, diameter }));
  assert.deepEqual(tools.map(t => t.diameter), ['0.400', '0.800', '1.000'], 'sorted, one per diameter');

  const body = drill.slice(drill.indexOf('\n%\n'));
  let selected = '';
  for (const line of body.split('\n')) {
    if (/^T\d+$/.test(line)) selected = line;
    else if (line.startsWith('X')) assert.ok(selected && selected !== 'T0', `${line} has no active tool`);
  }
  // A declared suppression code alongside explicit decimals is what makes drill files ambiguous.
  assert.match(drill, /^METRIC$/m);
  assert.doesNotMatch(drill, /^METRIC,(LZ|TZ)$/m);
});

test('the centroid agrees with the copper it is placed against', () => {
  const layout = board({ footprints: [part('U1', 25, 12, 0, 90), part('R1', 10, 5, 0.8)] });
  const schematic = { components: [{ id: 'U1', value: '10k' }], wires: [] } as unknown as SchematicData;
  const rows = buildCentroidCsv(layout, schematic).split('\r\n');

  assert.equal(rows.length, 2, 'through-hole parts are not machine placed and are excluded');
  // Same reflection as the Gerber, and the clockwise screen rotation negated with it.
  assert.equal(rows[1], '"U1","10k","resistor_4.000x2.000",25.000,8.000,270.000,"Top"');
});

test('a designator that looks like a formula cannot execute when the centroid is opened', () => {
  const layout = board({ footprints: [{ ...part('R1', 10, 5, 0), id: '-evil', componentId: '-evil' }] });
  assert.match(buildCentroidCsv(layout), /^"'-evil",/m);
});

test('a hostile project name cannot escape the download filename', () => {
  for (const name of ['../../etc/passwd', 'C:\\Windows\\system32', '=cmd|calc', '...', '']) {
    for (const file of buildFabricationPackage(board(), name)) {
      assert.doesNotMatch(file.filename, /[\\/]|\.\./, `${name} produced ${file.filename}`);
      assert.match(file.filename, /^[\w-]+\.[\w-]+$/);
    }
  }
});

test('every generated file is terminated and the package documents its own limits', () => {
  const layout = board({ footprints: [part('R1', 10, 5, 0.8)], vias: [via(20, 10)] });
  for (const layer of buildGerberLayers(layout)) {
    assert.ok(layer.contents.trimEnd().endsWith('M02*'), `${layer.id} is unterminated`);
    assert.match(layer.contents, /%TF\.FileFunction,/);
  }
  assert.ok(buildExcellonDrill(layout).trimEnd().endsWith('M30'));

  const notes = buildFabricationPackage(layout, 'demo').find(file => file.filename.endsWith('NOTES.txt'));
  assert.ok(notes, 'the package must carry its own limitations');
  for (const stated of ['No thermal relief', 'no stroke font', 'implies no', 'reflects Y']) {
    assert.ok(notes.contents.includes(stated), `notes must state: ${stated}`);
  }
});
