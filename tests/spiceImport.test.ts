import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSpiceNetlist, importSpiceNetlist } from '../src/interchange/spiceNetlist.ts';
import { runSpiceSimulation } from '../src/simulation/spiceSolver.ts';
import { applyConnectivityNets } from '../src/project/connectivity.ts';
import { parseProject, serializeProject } from '../src/project/projectFile.ts';
import { PARTS, partPads, partBody, partPins } from '../src/project/parts.ts';
import type { ComponentType, SchematicData, Wire } from '../src/types/pcb.ts';

const part = (type: ComponentType, id: string, value = PARTS[type].value) => ({
  id, type, name: id, value, x: 0, y: 0, rotation: 0, params: { ...PARTS[type].params }, pins: partPins(type),
});
const wire = (id: string, fromCompId: string, fromPinId: string, toCompId: string, toPinId: string): Wire =>
  ({ id, fromCompId, fromPinId, toCompId, toPinId, points: [], net: '' });
const settings = { type: 'transient' as const, stopTime: 2e-3, stepTime: 1e-5 };
const byId = (schematic: SchematicData, id: string) => schematic.components.find(component => component.id === id);

/** Which nets the pins of a component land on, so two schematics can be compared electrically. */
function netsOf(schematic: SchematicData, id: string) {
  const resolved = applyConnectivityNets(schematic, { boardWidth: 0, boardHeight: 0, footprints: [], traces: [], vias: [], pours: [] }).schematic;
  const component = resolved.components.find(candidate => candidate.id === id);
  return Object.fromEntries((component?.pins ?? []).map(pin => [pin.id, pin.net]));
}

const flasher = (): SchematicData => ({
  components: [part('voltage_source', 'V1', '5V'), part('resistor', 'R1', '330'), part('led', 'LED1'),
    part('transistor_npn', 'Q1'), part('resistor', 'R2', '4.7k'), part('gnd', 'G1')],
  wires: [wire('w1', 'V1', 'p', 'R1', '1'), wire('w2', 'R1', '2', 'LED1', 'a'), wire('w3', 'LED1', 'c', 'Q1', 'c'),
    wire('w4', 'Q1', 'e', 'G1', 'gnd'), wire('w5', 'V1', 'n', 'G1', 'gnd'), wire('w6', 'V1', 'p', 'R2', '1'),
    wire('w7', 'R2', '2', 'Q1', 'b')],
});

test('a deck this project wrote comes back as the same circuit', () => {
  const original = flasher();
  const { schematic, warnings } = importSpiceNetlist(exportSpiceNetlist(original, settings, 'flasher').netlist);
  assert.deepEqual(warnings, []);

  // Same parts with the same values, the LED recognised as an LED and not a generic diode.
  assert.equal(byId(schematic, 'R1')?.value, '330');
  assert.equal(byId(schematic, 'R2')?.value, '4700');
  assert.equal(byId(schematic, 'DLED1')?.type, 'led');
  assert.equal(byId(schematic, 'Q1')?.type, 'transistor_npn');
  assert.equal(byId(schematic, 'Q1')?.value, PARTS.transistor_npn.value, 'a solver model name is not a part value');

  // Same physics: the LED draws the same current in both.
  const current = (data: SchematicData) => {
    const result = runSpiceSimulation(data, settings);
    const key = Object.keys(result.currents).find(name => /LED/i.test(name));
    return key ? result.currents[key].at(-1) ?? NaN : NaN;
  };
  const before = current(original);
  const after = current(schematic);
  assert.ok(before > 0.05, `precondition: the LED conducts (${before})`);
  assert.ok(Math.abs(before - after) / before < 1e-3, `LED current changed: ${before} vs ${after}`);
});

test('the transistor comes back with collector, base and emitter on the right nets', () => {
  const original = flasher();
  const { schematic } = importSpiceNetlist(exportSpiceNetlist(original, settings).netlist);
  const before = netsOf(original, 'Q1');
  const after = netsOf(schematic, 'Q1');
  // Net names differ between the two, so compare by which other pins share each net.
  assert.equal(after.e, 'GND', 'emitter to ground');
  assert.equal(netsOf(schematic, 'R2')['2'], after.b, 'base fed from R2');
  assert.equal(netsOf(schematic, 'DLED1').c, after.c, 'collector on the LED cathode');
  assert.equal(before.e, 'GND', 'precondition on the original');
});

test('a zener and a MOSFET recover their parameters from the model lines', () => {
  const original: SchematicData = {
    components: [part('zener', 'D1', '3.3V'), { ...part('mosfet_n', 'M1'), params: { vth: 1.7, kn: 0.12 } }, part('gnd', 'G1')],
    wires: [wire('w1', 'D1', 'a', 'G1', 'gnd'), wire('w2', 'M1', 's', 'G1', 'gnd'), wire('w3', 'M1', 'd', 'D1', 'c')],
  };
  const { schematic } = importSpiceNetlist(exportSpiceNetlist(original).netlist);
  assert.equal(byId(schematic, 'D1')?.type, 'zener');
  assert.equal(byId(schematic, 'D1')?.value, '3.3V');
  assert.equal(byId(schematic, 'M1')?.type, 'mosfet_n');
  assert.deepEqual(byId(schematic, 'M1')?.params, { vth: 1.7, kn: 0.12 });
  assert.deepEqual(netsOf(schematic, 'M1').s, 'GND');
});

test('a hand-written deck from elsewhere imports with its comments and continuations honoured', () => {
  const deck = `RC low-pass, written by hand
* the source
V1 in 0 DC 5   ; five volts
R1 in
+ out 1k
C1 out 0 100n
.tran 1u 1m
.end
`;
  const { schematic, warnings } = importSpiceNetlist(deck);
  assert.deepEqual(warnings, []);
  assert.equal(schematic.components.filter(component => component.type !== 'gnd').length, 3);
  assert.equal(byId(schematic, 'R1')?.value, '1k', 'a continuation line completes the card');
  assert.equal(byId(schematic, 'C1')?.value, '100n');
  assert.equal(netsOf(schematic, 'R1')['1'], netsOf(schematic, 'V1').p, 'R1 hangs off the source');
  assert.equal(netsOf(schematic, 'C1')['2'], 'GND');
  assert.ok(!runSpiceSimulation(schematic, settings).errorMessage, 'the imported circuit simulates');
});

test('the title line is dropped but a first line that is a real card is kept', () => {
  const titled = importSpiceNetlist('my divider\nV1 1 0 5\nR1 1 0 1k\n.end');
  assert.equal(titled.schematic.components.filter(component => component.type !== 'gnd').length, 2);
  const untitled = importSpiceNetlist('R1 1 0 1k\nV1 1 0 5\n.end');
  assert.equal(untitled.schematic.components.filter(component => component.type !== 'gnd').length, 2, 'a card on the first line is not a title');
});

test('SPICE source waveforms become this project\'s forms, with what was dropped named', () => {
  const { schematic, warnings } = importSpiceNetlist(
    'sources\nV1 a 0 SIN(0 5 1000)\nV2 b 0 PULSE(0 3.3 0 1n 1n 5u 10u)\nV3 c 0 AC 1\nR1 a b 1k\nR2 b c 1k\n.end');
  assert.equal(byId(schematic, 'V1')?.value, 'sin(0,5,1000)');
  assert.equal(byId(schematic, 'V2')?.value, 'pulse(0,3.3,100000)', 'a 10us period is 100kHz');
  assert.ok(warnings.some(note => note.includes('V2') && note.includes('duty')), warnings.join(' | '));
  assert.ok(warnings.some(note => note.includes('V3') && note.includes('AC')), warnings.join(' | '));
});

test('a device this project cannot model is skipped and said so, never guessed', () => {
  const { schematic, warnings } = importSpiceNetlist('mixed\nR1 1 0 1k\nK1 L1 L2 0.9\nXU9 1 2 3 SOME_OPAMP\nE1 4 0 1 0 100\n.end');
  assert.equal(schematic.components.filter(component => component.type !== 'gnd').length, 1);
  assert.ok(warnings.some(note => note.includes('K1')), 'a coupled inductor is not modelled');
  assert.ok(warnings.some(note => note.includes('SOME_OPAMP')), 'a foreign subcircuit is not invented');
  assert.ok(warnings.some(note => note.includes('E1')), 'a controlled source is not modelled');
});

test('a deck without ground says so instead of pretending', () => {
  const { warnings } = importSpiceNetlist('floating\nR1 a b 1k\nR2 b c 1k\n.end');
  assert.ok(warnings.some(note => note.includes('no node 0')), warnings.join(' | '));
});

test('hostile input is bounded and names never reach an object key unscrubbed', () => {
  assert.throws(() => importSpiceNetlist('x'.repeat(600_000)), /limited to/);
  assert.throws(() => importSpiceNetlist(`big\n${'R1 1 0 1k '.repeat(500)}`), /exceeds/);
  assert.throws(() => importSpiceNetlist('* only comments\n* nothing else'), /no SPICE cards/);
  assert.throws(() => importSpiceNetlist('empty\n.tran 1u 1m\n.end'), /No devices/);

  const { schematic } = importSpiceNetlist('hostile\nR__proto__ 1 0 1k\nRconstructor 1 0 1k\nR1 __proto__ 0 1k\n.end');
  for (const component of schematic.components) {
    assert.ok(!['__proto__', 'constructor', 'prototype'].includes(component.id), `unsafe id ${component.id}`);
    assert.match(component.id, /^[\w.+-]+$/);
  }
  // Two R cards that scrub to the same name must stay two parts.
  const clash = importSpiceNetlist('clash\nR.1 1 0 1k\nR-1 1 0 2k\n.end');
  assert.equal(new Set(clash.schematic.components.map(component => component.id)).size, clash.schematic.components.length);
});

test('an imported circuit is a valid project once footprints are attached', () => {
  const { schematic } = importSpiceNetlist(exportSpiceNetlist(flasher()).netlist);
  const project = {
    name: 'imported', schematic,
    pcbLayout: {
      boardWidth: 100, boardHeight: 60,
      footprints: schematic.components.map((component, index) => ({
        id: component.id, componentId: component.id, type: component.type,
        x: 10 + (index % 8) * 11, y: 10 + Math.floor(index / 8) * 15, rotation: 0,
        ...partBody(component.type), pads: partPads(component.type), isPlaced: true,
      })),
      traces: [], vias: [], pours: [],
    },
  };
  const reloaded = parseProject(serializeProject(project));
  assert.equal(reloaded.schematic.components.length, schematic.components.length);
  assert.equal(reloaded.schematic.wires.length, schematic.wires.length);
});

test('imported wires carry a route the editor can draw and a part can be dragged away from', () => {
  const { schematic } = importSpiceNetlist('rc\nV1 in 0 5\nR1 in out 1k\nC1 out 0 100n\n.end');
  for (const link of schematic.wires) {
    assert.equal(link.points.length, 3, `${link.id} should be an orthogonal route`);
    const [start, bend, end] = link.points;
    assert.equal(bend.y, start.y, 'first leg is horizontal');
    assert.equal(bend.x, end.x, 'second leg is vertical');
  }
});
