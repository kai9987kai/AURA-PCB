import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConnectivityNets, electricalSignature, nextComponentId, reconcileCopper } from '../src/project/connectivity.ts';
import { buildBomCsv, emptyProject, parseProject, serializeProject } from '../src/project/projectFile.ts';
import { createHistory, projectHistory } from '../src/project/history.ts';
import type { Project } from '../src/project/projectFile.ts';

function fixture(): Project {
  const p = emptyProject();
  p.schematic.components = ['R1', 'R2', 'R3'].map((id, i) => ({ id, type: 'resistor', name: id, value: '1k', x: 100 + i * 100, y: 100, rotation: 0, pins: [{ id: '1', label: '1', relX: 0, relY: 0 }], params: { resistance: 1000 } }));
  p.schematic.wires = [{ id: 'w1', fromCompId: 'R1', fromPinId: '1', toCompId: 'R2', toPinId: '1', points: [], net: '' }, { id: 'w2', fromCompId: 'R2', fromPinId: '1', toCompId: 'R3', toPinId: '1', points: [], net: '' }];
  p.pcbLayout.footprints = p.schematic.components.map((c, i) => ({ id: c.id, componentId: c.id, type: c.type, x: 10 + i * 10, y: 10, rotation: 0, width: 3, height: 3, isPlaced: true, pads: [{ id: '1', relX: 0, relY: 0, diameter: 1.6, holeDiameter: 0.8 }] }));
  return { ...p, ...applyConnectivityNets(p.schematic, p.pcbLayout) };
}

test('versioned project round-trips schematic, net assignments and copper', () => {
  const p = fixture();
  p.pcbLayout.traces.push({ id: 't1', net: p.schematic.components[0].pins[0].net!, width: 0.4, layer: 'top', points: [{ x: 10, y: 10 }, { x: 20, y: 10 }] });
  assert.deepEqual(parseProject(serializeProject(p)), p);
});

test('invalid import is rejected for versions, duplicate IDs, dangling endpoints and geometry', () => {
  assert.throws(() => parseProject('{'), /JSON syntax/);
  assert.throws(() => parseProject('{"format":"aura-pcb","version":2}'), /version/);
  const duplicate = fixture(); duplicate.schematic.components[1].id = 'R1';
  assert.throws(() => parseProject(serializeProject(duplicate)), /duplicate/);
  const dangling = fixture(); dangling.schematic.wires[0].toPinId = 'absent';
  assert.throws(() => parseProject(serializeProject(dangling)), /missing pin/);
  const wrong = fixture(); wrong.pcbLayout.boardWidth = Infinity;
  assert.throws(() => parseProject(serializeProject(wrong)), /board width/);
  const unsafe = fixture(); unsafe.schematic.components[0].id = '__proto__';
  assert.throws(() => parseProject(serializeProject(unsafe)), /component id/);
});

test('net splitting removes ambiguous copper; undo recovers the complete design', () => {
  const p = fixture();
  p.pcbLayout.traces = [{ id: 't', net: p.schematic.wires[0].net, width: 0.4, layer: 'top', points: [{ x: 10, y: 10 }, { x: 30, y: 10 }] }];
  const edited = { ...p, schematic: { ...p.schematic, wires: p.schematic.wires.slice(1) } };
  const state = projectHistory(createHistory(p), { type: 'edit', project: edited, at: 1 });
  assert.equal(state.present.pcbLayout.traces.length, 0);
  assert.match(state.notice, /ambiguous route/);
  assert.deepEqual(projectHistory(state, { type: 'undo' }).present, p);
});

test('new disconnected component does not relabel unrelated net or copper', () => {
  const p = fixture(); const original = p.schematic.wires[0].net;
  p.schematic.components.unshift({ ...p.schematic.components[0], id: 'A0' });
  assert.equal(applyConnectivityNets(p.schematic, p.pcbLayout).schematic.wires[0].net, original);
});

test('net merges remap both traces and vias to the joined net', () => {
  const p = fixture(); p.schematic.wires = [];
  const before = applyConnectivityNets(p.schematic, p.pcbLayout);
  before.pcbLayout.vias = [{ id: 'via', x: 20, y: 10, net: before.schematic.components[1].pins[0].net!, diameter: 1, drillDiameter: 0.4 }];
  const after = reconcileCopper(before.schematic, fixture().schematic, before.pcbLayout);
  assert.equal(after.pcbLayout.vias[0].net, after.schematic.components[0].pins[0].net);
});

test('atomic history coalesces drag edits, supports redo, and clears redo on branching', () => {
  const initial = fixture();
  let h = projectHistory(createHistory(initial), { type: 'edit', project: { ...initial, name: 'A' }, group: 'name', at: 1 });
  h = projectHistory(h, { type: 'edit', project: { ...h.present, name: 'AB' }, group: 'name', at: 100 });
  assert.equal(h.past.length, 1);
  h = projectHistory(h, { type: 'undo' }); assert.equal(h.present.name, initial.name);
  h = projectHistory(h, { type: 'redo' }); assert.equal(h.present.name, 'AB');
  h = projectHistory(h, { type: 'undo' });
  h = projectHistory(h, { type: 'edit', project: { ...h.present, name: 'C' }, at: 1000 });
  assert.equal(h.future.length, 0);
});

test('import replaces topology without reconciling imported copper against the outgoing project', () => {
  const imported = fixture(); const prior = fixture();
  prior.schematic.wires = []; const normalized = { ...prior, ...applyConnectivityNets(prior.schematic, prior.pcbLayout) };
  imported.pcbLayout.traces = [{ id: 't', net: imported.schematic.wires[0].net, width: 0.4, layer: 'top', points: [{ x: 10, y: 10 }, { x: 30, y: 10 }] }];
  const state = projectHistory(createHistory(normalized), { type: 'edit', project: imported, group: 'replace', at: 1 });
  assert.deepEqual(state.present, imported);
});

test('electrical signature ignores placement, but invalidates on component value changes', () => {
  const p = fixture(); const before = electricalSignature(p.schematic);
  p.schematic.components[0].x += 10;
  assert.equal(electricalSignature(p.schematic), before);
  p.schematic.components[0].value = '2k';
  assert.notEqual(electricalSignature(p.schematic), before);
});

test('reference allocation avoids collisions after deletion, BOM quotes and neutralizes formula text', () => {
  const p = fixture(); p.schematic.components = p.schematic.components.filter(c => c.id !== 'R2');
  assert.equal(nextComponentId('R', p.schematic), 'R2');
  p.schematic.components[0].name = '=SUM(1,2)';
  p.schematic.components[0].value = 'a"b';
  const csv = buildBomCsv(p);
  assert.match(csv, /"'=SUM\(1,2\)"/); assert.match(csv, /"a""b"/);
});
