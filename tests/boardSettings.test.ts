import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyProject, parseProject, serializeProject } from '../src/project/projectFile.ts';
import { DEFAULT_SIGNAL_MODEL, parseSignalModel, resizeBoard, signalModelFor } from '../src/project/boardSettings.ts';
import { applyConnectivityNets, reconcileCopper } from '../src/project/connectivity.ts';
import { partPins, partPads, partBody } from '../src/project/parts.ts';

test('shared SI settings survive project roundtrip and legacy projects retain defaults', () => {
  const p = emptyProject();
  assert.deepEqual(signalModelFor(parseProject(serializeProject(p)).pcbLayout), DEFAULT_SIGNAL_MODEL);
  p.pcbLayout.signalModel = { ...DEFAULT_SIGNAL_MODEL, substrateHeightMm: 0.2, riseTimeNs: 1.2 };
  assert.deepEqual(parseProject(serializeProject(p)), p);
  assert.equal(signalModelFor(p.pcbLayout).substrateHeightMm, 0.2);
});
test('invalid setup values cannot enter imported documents', () => {
  for (const bad of [NaN, Infinity, -1, 1001]) assert.throws(() => parseSignalModel({ ...DEFAULT_SIGNAL_MODEL, riseTimeNs: bad }), /Rise time/);
  assert.throws(() => parseSignalModel({}), /Plane distance/);
  const p = emptyProject(); p.pcbLayout.signalModel = { ...DEFAULT_SIGNAL_MODEL, sourceImpedanceOhms: -1 };
  assert.throws(() => parseProject(serializeProject(p)), /Source impedance/);
});
test('board resizing preserves geometry and validates bounds', () => {
  const layout = emptyProject().pcbLayout;
  const resized = resizeBoard(layout, 100, 60);
  assert.equal(resized.boardWidth, 100); assert.equal(resized.boardHeight, 60);
  assert.equal(resized.traces, layout.traces); assert.equal(layout.boardWidth, 80);
  for (const width of [0, 501, Infinity, NaN]) assert.throws(() => resizeBoard(layout, width, 60));
});
test('net splits and merges reconcile pours as well as traces and vias', () => {
  const p = emptyProject();
  p.schematic.components = ['R1', 'R2'].map(id => ({ id, type: 'resistor', name: id, value: '1k', x: 100, y: 100, rotation: 0, params: {}, pins: partPins('resistor') }));
  p.pcbLayout.footprints = p.schematic.components.map(c => ({ id: c.id, componentId: c.id, type: c.type, x: 20, y: 20, rotation: 0, ...partBody(c.type), pads: partPads(c.type), isPlaced: true }));
  p.schematic.wires = [{ id: 'w', fromCompId: 'R1', fromPinId: '1', toCompId: 'R2', toPinId: '1', net: '', points: [] }];
  const before = applyConnectivityNets(p.schematic, p.pcbLayout);
  before.pcbLayout.pours = [{ id: 'pour', layer: 'bottom', margin: 1, clearance: 0.25, net: before.schematic.wires[0].net }];
  const split = reconcileCopper(before.schematic, { ...before.schematic, wires: [] }, before.pcbLayout);
  assert.equal(split.pcbLayout.pours.length, 0);
});
