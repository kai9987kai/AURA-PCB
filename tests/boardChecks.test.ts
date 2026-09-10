import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBoard, getPadBoardCoords, segmentDistance } from '../src/analysis/boardChecks.ts';
import type { PCBFootprint, PCBLayoutData, PCBTrace, PCBVia } from '../src/types/pcb.ts';

const board = (overrides: Partial<PCBLayoutData> = {}): PCBLayoutData => ({
  boardWidth: 50, boardHeight: 40, footprints: [], traces: [], vias: [], ...overrides,
});
const pad = (id: string, x: number, y: number, net?: string, holeDiameter = 0): PCBFootprint => ({
  id, componentId: id, type: 'resistor', x, y, rotation: 0, width: 2, height: 2, isPlaced: true,
  pads: [{ id: '1', relX: 0, relY: 0, diameter: 1.5, holeDiameter, net }],
});
const trace = (id: string, net: string, points: [number, number][], layer: 'top' | 'bottom' = 'top'): PCBTrace => ({
  id, net, layer, width: .4, points: points.map(([x, y]) => ({ x, y })),
});
const via = (id: string, net: string, x: number, y: number): PCBVia => ({
  id, net, x, y, diameter: .9, drillDiameter: .4,
});
const clearance = (layout: PCBLayoutData) => analyzeBoard(layout).issues.filter(issue => issue.kind === 'clearance');

test('segment distance finds interior crossings, collinear overlap and degenerate segments symmetrically', () => {
  const p = (x: number, y: number) => ({ x, y });
  assert.equal(segmentDistance(p(0, 0), p(10, 10), p(0, 10), p(10, 0)), 0);
  assert.equal(segmentDistance(p(0, 0), p(10, 0), p(2, 0), p(3, 0)), 0);
  assert.equal(segmentDistance(p(0, 0), p(0, 0), p(3, 4), p(3, 4)), 5);
  assert.equal(segmentDistance(p(0, 0), p(10, 0), p(5, 2), p(5, 4)), 2);
  assert.equal(segmentDistance(p(5, 2), p(5, 4), p(0, 0), p(10, 0)), 2);
});

test('crossing traces fail clearance only when sharing a layer', () => {
  const a = trace('a', 'A', [[5, 5], [15, 15]]);
  const b = trace('b', 'B', [[5, 15], [15, 5]]);
  assert.equal(clearance(board({ traces: [a, b] })).length, 1);
  assert.equal(clearance(board({ traces: [a, { ...b, layer: 'bottom' }] })).length, 0);
});

test('same-footprint and unassigned pads never bypass clearance', () => {
  const fp = pad('U1', 10, 10);
  fp.pads.push({ id: '2', relX: 1, relY: 0, diameter: 1.5, holeDiameter: 0 });
  assert.equal(clearance(board({ footprints: [fp] })).length, 1);
  fp.pads[0].net = 'A';
  fp.pads[1].net = 'B';
  assert.equal(clearance(board({ footprints: [fp] })).length, 1);
});

test('unassigned traces and pads are clearance obstacles', () => {
  assert.equal(clearance(board({ traces: [trace('a', '', [[5, 10], [15, 10]]), trace('b', '', [[10, 5], [10, 15]])] })).length, 1);
  assert.equal(clearance(board({ footprints: [pad('P', 10, 10)], traces: [trace('a', 'A', [[5, 10], [15, 10]])] })).length, 1);
});

test('via clearance covers both copper layers, other vias, and pads', () => {
  const sharedVia = via('V', 'A', 10, 10);
  assert.equal(clearance(board({ vias: [sharedVia], traces: [trace('b', 'B', [[5, 10], [15, 10]], 'bottom')] })).length, 1);
  assert.equal(clearance(board({ vias: [sharedVia, via('V2', 'B', 10.5, 10)] })).length, 1);
  assert.equal(clearance(board({ vias: [sharedVia], footprints: [pad('P', 10, 10, 'B')] })).length, 1);
});

test('a bottom-layer trace may pass below a top-only SMD pad', () => {
  assert.equal(clearance(board({ footprints: [pad('P', 10, 10, 'A')], traces: [trace('b', 'B', [[5, 10], [15, 10]], 'bottom')] })).length, 0);
  assert.equal(clearance(board({ footprints: [pad('P', 10, 10, 'A', .8)], traces: [trace('b', 'B', [[5, 10], [15, 10]], 'bottom')] })).length, 1);
});

test('GND has no implicit plane and partial copper cannot mark an entire net routed', () => {
  const layout = board({ footprints: [pad('P1', 5, 10, 'GND'), pad('P2', 15, 10, 'GND'), pad('P3', 25, 10, 'GND')],
    traces: [trace('t', 'GND', [[5, 10], [15, 10]])] });
  const analysis = analyzeBoard(layout);
  assert.deepEqual(analysis.nets, [{ net: 'GND', padCount: 3, connectedGroups: 2, fullyRouted: false }]);
  assert.equal(analysis.airwires.length, 1);
  assert.equal(analysis.routingCompletion, 50);
  assert.ok(analysis.issues.some(issue => issue.kind === 'unrouted'));
});

test('an unrelated trace with matching net name supplies no pad connectivity', () => {
  const analysis = analyzeBoard(board({ footprints: [pad('A', 5, 10, 'N'), pad('B', 15, 10, 'N')], traces: [trace('t', 'N', [[30, 20], [40, 20]])] }));
  assert.equal(analysis.nets[0].fullyRouted, false);
  assert.equal(analysis.routingCompletion, 0);
});

test('same-layer crossing and junction copper joins multiple trace fragments', () => {
  const analysis = analyzeBoard(board({ footprints: [pad('A', 5, 10, 'N'), pad('B', 10, 5, 'N')],
    traces: [trace('a', 'N', [[5, 10], [15, 10]]), trace('b', 'N', [[10, 5], [10, 15]])] }));
  assert.equal(analysis.nets[0].fullyRouted, true);
  assert.equal(analysis.routingCompletion, 100);
  assert.equal(analysis.airwires.length, 0);
});

test('changing copper layer requires a real via at the junction', () => {
  const layout = board({ footprints: [pad('A', 5, 10, 'N'), pad('B', 15, 10, 'N', .8)],
    traces: [trace('a', 'N', [[5, 10], [10, 10]]), trace('b', 'N', [[10, 10], [15, 10]], 'bottom')] });
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, false);
  layout.vias.push(via('V', 'N', 10, 10));
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, true);
  layout.vias[0].x = 20;
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, false);
});

test('a through-hole pad can bridge layers; SMD cannot contact bottom copper', () => {
  const layout = board({ footprints: [pad('A', 5, 10, 'N'), pad('B', 15, 10, 'N')],
    traces: [trace('t', 'N', [[5, 10], [15, 10]], 'bottom')] });
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, false);
  layout.footprints.forEach(fp => fp.pads[0].holeDiameter = .8);
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, true);
});

test('trace copper wholly inside a hole does not bridge the ring', () => {
  const layout = board({ footprints: [pad('P', 10, 10, 'N', .8), pad('Q', 10, 10, 'N')],
    traces: [trace('t', 'N', [[10, 10], [10.05, 10]])] });
  // Q is a tiny copper disc entirely inside P's drilled opening.
  layout.footprints[1].pads[0].diameter = .2;
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, false);
});

test('drill and annular ring limits apply to through-hole pads and vias', () => {
  const fp = pad('P', 10, 10, 'N', .2);
  fp.pads[0].diameter = .4;
  const analysis = analyzeBoard(board({ footprints: [fp], vias: [{ ...via('V', 'N', 20, 20), drillDiameter: .8 }] }));
  assert.equal(analysis.issues.filter(issue => issue.message.includes('annular ring')).length, 2);
  assert.equal(analysis.issues.filter(issue => issue.message.includes('drill')).length, 1);
});

test('board-edge tests account for trace, via, and pad copper radii', () => {
  const analysis = analyzeBoard(board({ footprints: [pad('P', .8, 10, 'N')],
    traces: [trace('t', 'N', [[.3, 5], [.3, 15]])], vias: [via('V', 'N', 49.5, 20)] }));
  assert.equal(analysis.issues.filter(issue => issue.kind === 'edge' && !issue.message.includes('Footprint')).length, 3);
});

test('rotated footprint corners and pad positions are respected', () => {
  const fp = pad('P', 2, 10, 'N');
  fp.width = 2;
  fp.height = 8;
  fp.rotation = 90;
  fp.pads[0].relX = 2;
  const position = getPadBoardCoords(fp, fp.pads[0]);
  assert.ok(Math.abs(position.x - 2) < 1e-8 && Math.abs(position.y - 12) < 1e-8);
  assert.ok(analyzeBoard(board({ footprints: [fp] })).issues.some(issue => issue.message.includes('Footprint P')));
});

test('invalid geometry reports errors without throwing or inventing copper', () => {
  const analysis = analyzeBoard(board({ boardWidth: NaN,
    traces: [{ ...trace('empty', 'N', []), width: NaN }],
    vias: [{ ...via('bad', 'N', 5, 5), drillDiameter: -1 }] }));
  assert.equal(analysis.issues.filter(issue => issue.kind === 'invalid').length, 3);
});

test('invalid or fully drilled-away pads stay in the connectivity denominator', () => {
  const invalidPad = pad('bad', 15, 10, 'N', 1.5);
  const layout = board({ footprints: [pad('A', 5, 10, 'N'), invalidPad], traces: [trace('t', 'N', [[5, 10], [15, 10]])] });
  assert.deepEqual(analyzeBoard(layout).nets[0], { net: 'N', padCount: 2, connectedGroups: 2, fullyRouted: false });
  assert.equal(analyzeBoard(layout).routingCompletion, 0);
  invalidPad.pads[0].relX = NaN;
  assert.equal(analyzeBoard(layout).nets[0].fullyRouted, false);
});

test('airwires form a minimum connection tree and analysis does not mutate input', () => {
  const layout = board({ footprints: [pad('A', 5, 10, 'N'), pad('B', 15, 10, 'N'), pad('C', 25, 10, 'N'), pad('D', 35, 10, 'N')] });
  const original = structuredClone(layout);
  const analysis = analyzeBoard(layout);
  assert.equal(analysis.airwires.length, 3);
  assert.equal(analysis.airwires.reduce((sum, wire) => sum + Math.hypot(wire.to.x - wire.from.x, wire.to.y - wire.from.y), 0), 30);
  assert.deepEqual(layout, original);
});
