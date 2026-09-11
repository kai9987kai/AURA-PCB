import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSpiceNetlist } from '../src/interchange/spiceNetlist.ts';
import { parseValue } from '../src/simulation/spiceSolver.ts';
import type { ComponentType, SchematicComponent, SchematicData, Wire } from '../src/types/pcb.ts';

const part = (id: string, type: ComponentType, value: string, pins: string[]): SchematicComponent => ({
  id, type, name: id, value, x: 0, y: 0, rotation: 0, params: {},
  pins: pins.map(pin => ({ id: pin, label: pin, relX: 0, relY: 0 })),
});
const wire = (id: string, fromCompId: string, fromPinId: string, toCompId: string, toPinId: string): Wire =>
  ({ id, fromCompId, fromPinId, toCompId, toPinId, points: [], net: '' });

const R = (id: string, value: string) => part(id, 'resistor', value, ['1', '2']);
const GND = part('G1', 'gnd', 'GND', ['gnd']);
const V = (value: string) => part('V1', 'voltage_source', value, ['p', 'n']);

/** Source, resistor and ground in series: the smallest circuit with a real node and a return. */
const divider = (extra: Partial<SchematicData> = {}): SchematicData => ({
  components: [V('5V'), R('R1', '10k'), GND, ...(extra.components ?? [])],
  wires: [wire('w1', 'V1', 'p', 'R1', '1'), wire('w2', 'R1', '2', 'G1', 'gnd'),
    wire('w3', 'V1', 'n', 'G1', 'gnd'), ...(extra.wires ?? [])],
});
/** Device cards only: the first line of a SPICE deck is its title, not a comment. */
const cards = (netlist: string) => netlist.split('\n').slice(1).filter(line => line && !line.startsWith('*') && !line.startsWith('.'));

test('ground becomes node 0 and nothing else claims it', () => {
  const { netlist } = exportSpiceNetlist(divider());
  const [source, resistor] = cards(netlist);
  assert.equal(source, 'V1 N_R1_1 0 DC 5');
  assert.equal(resistor, 'R1 N_R1_1 0 10000');
});

test('a deck without ground says so rather than emitting one SPICE will reject', () => {
  const floating: SchematicData = { components: [R('R1', '1k'), R('R2', '1k')], wires: [wire('w', 'R1', '2', 'R2', '1')] };
  const { caveats } = exportSpiceNetlist(floating);
  assert.ok(caveats.some(note => note.includes('no ground')), caveats.join(' | '));
});

test('values carry the solver\'s own interpretation, normalised for the deck', () => {
  // parseValue('100n') is 1.0000000000000001e-7 in binary floating point. The deck carries
  // the solver's number to 12 significant figures, which drops that noise without rounding
  // any value a designer could actually have entered.
  for (const [written, expected] of [['10k', '10000'], ['100n', '1e-7'], ['4.7', '4.7'], ['1meg', '1000000']] as const) {
    const solver = parseValue(written);
    assert.ok(Math.abs(solver - Number(expected)) <= Math.abs(solver) * 1e-12,
      `precondition: the solver reads ${written} as about ${expected}, got ${solver}`);
    const { netlist } = exportSpiceNetlist(divider({ components: [R('R9', written)] }));
    assert.ok(cards(netlist).some(card => card.startsWith('R9 ') && card.endsWith(` ${expected}`)),
      `${written} should reach the deck as ${expected}`);
  }
});

test('a reference that does not start with its device letter gains one', () => {
  const schematic = divider({
    components: [part('LED1', 'led', 'Red', ['a', 'c']), part('Q1', 'transistor_npn', '2N2222', ['b', 'c', 'e'])],
    wires: [wire('w4', 'R1', '2', 'LED1', 'a'), wire('w5', 'Q1', 'e', 'G1', 'gnd')],
  });
  const emitted = cards(exportSpiceNetlist(schematic).netlist);
  assert.ok(emitted.some(card => card.startsWith('DLED1 ')), 'an LED is a D card');
  assert.ok(emitted.some(card => card.startsWith('Q1 ')), 'a reference already carrying its letter keeps it');
});

test('a transistor is written collector, base, emitter', () => {
  const schematic: SchematicData = {
    components: [part('Q1', 'transistor_npn', '2N2222', ['b', 'c', 'e']), R('RC', '1k'), R('RB', '10k'), GND],
    wires: [wire('w1', 'Q1', 'c', 'RC', '1'), wire('w2', 'Q1', 'b', 'RB', '1'), wire('w3', 'Q1', 'e', 'G1', 'gnd')],
  };
  const card = cards(exportSpiceNetlist(schematic).netlist).find(line => line.startsWith('Q1 '));
  assert.ok(card);
  const [, collector, base, emitter, model] = card.split(' ');
  assert.equal(emitter, '0', 'the emitter is the pin tied to ground');
  assert.equal(collector, 'N_Q1_c');
  assert.equal(base, 'N_Q1_b');
  assert.equal(model, 'AURA_NPN');
});

test('two nets that scrub to the same identifier stay separate nodes', () => {
  // Nets are named after a pin key, so "A.1" pin 1 and "A_1" pin 1 both reduce to N_A_1_1.
  const schematic: SchematicData = {
    components: [R('A.1', '1k'), R('A_1', '1k'), GND],
    wires: [wire('w1', 'A.1', '2', 'G1', 'gnd'), wire('w2', 'A_1', '2', 'G1', 'gnd')],
  };
  const nodes = cards(exportSpiceNetlist(schematic).netlist)
    .filter(card => card.startsWith('R'))
    .map(card => card.split(' ')[1]);
  assert.equal(nodes.length, 2);
  assert.notEqual(nodes[0], nodes[1], 'distinct nets must never collapse onto one node');
});

test('two components whose references scrub alike stay separate devices', () => {
  const schematic: SchematicData = {
    components: [R('R.1', '1k'), R('R-1', '2k'), GND],
    wires: [wire('w1', 'R.1', '2', 'G1', 'gnd'), wire('w2', 'R-1', '2', 'G1', 'gnd')],
  };
  const names = cards(exportSpiceNetlist(schematic).netlist).map(card => card.split(' ')[0]);
  assert.equal(new Set(names).size, names.length, `duplicate reference in ${names.join(', ')}`);
});

test('a sine source keeps its three arguments and a square wave declares what it became', () => {
  const sine = exportSpiceNetlist(divider({ components: [part('V2', 'voltage_source', 'sin(0,5,1000)', ['p', 'n'])] }));
  assert.ok(cards(sine.netlist).some(card => card.startsWith('V2 ') && card.includes('SIN(0 5 1000)')));

  const square = exportSpiceNetlist(divider({ components: [part('V2', 'voltage_source', 'pulse(0,5,1000)', ['p', 'n'])] }));
  const card = cards(square.netlist).find(line => line.startsWith('V2 '));
  assert.ok(card);
  // AURA's pulse is ideal; SPICE needs a period, a duty and non-zero edges spelled out.
  assert.match(card, /PULSE\(0 5 0 0\.000001 0\.000001 0\.0005 0\.001\)/);
  assert.ok(square.caveats.some(note => note.includes('V2') && note.includes('50% duty')), square.caveats.join(' | '));
});

test('an unreadable value is reported rather than silently becoming a number', () => {
  const { netlist, caveats } = exportSpiceNetlist(divider({ components: [R('R9', 'about ten ohms')] }));
  assert.ok(cards(netlist).some(card => card === 'R9 N_R9_1 N_R9_2 0'));
  assert.ok(caveats.some(note => note.startsWith('R9:')), caveats.join(' | '));
});

test('behavioural parts are flagged and never pass as faithful models', () => {
  const schematic = divider({
    components: [part('U1', 'opamp', 'OPAMP', ['in-', 'in+', 'out', 'v+', 'v-'])],
    wires: [wire('w4', 'U1', 'v-', 'G1', 'gnd')],
  });
  const { netlist, caveats } = exportSpiceNetlist(schematic);
  assert.ok(cards(netlist).some(card => card.startsWith('XU1 ') && card.endsWith('AURA_OPAMP')));
  assert.match(netlist, /\.subckt AURA_OPAMP /);
  assert.ok(caveats.some(note => note.includes('U1') && note.includes('clamp')), caveats.join(' | '));

  const timer = exportSpiceNetlist(divider({ components: [part('U2', 'timer555', 'IC', ['1', '2', '3', '4', '5', '6', '7', '8'])] }));
  assert.match(timer.netlist, /PLACEHOLDER/);
  assert.ok(timer.caveats.some(note => note.includes('will not oscillate')), timer.caveats.join(' | '));
});

test('a part with no card is dropped loudly, not quietly', () => {
  const { netlist, caveats } = exportSpiceNetlist(divider({ components: [part('M1', 'mosfet_n', '2N7000', ['g', 'd', 's'])] }));
  assert.ok(!cards(netlist).some(card => card.includes('M1')), 'no card may be invented for it');
  assert.ok(caveats.some(note => note.includes('M1') && note.includes('omitted')), caveats.join(' | '));
});

test('the deck is framed as SPICE expects and carries the requested analysis', () => {
  const { netlist } = exportSpiceNetlist(divider(), { type: 'transient', stopTime: 0.05, stepTime: 2e-6 }, 'my board');
  assert.equal(netlist.split('\n')[0], 'my board', 'the first line of a deck is its title');
  assert.match(netlist, /^\.tran 0\.000002 0\.05$/m);
  assert.ok(netlist.trimEnd().endsWith('.end'));
});

test('a device missing the pins its card needs is dropped, never shorted to ground', () => {
  // Every terminal would otherwise resolve to node 0 and export as a dead short.
  const odd = divider({ components: [part('R9', 'resistor', '1k', ['a', 'b'])] });
  const { netlist, caveats } = exportSpiceNetlist(odd);
  assert.ok(!cards(netlist).some(card => card.startsWith('R9 ')), 'no card may be invented for it');
  assert.ok(caveats.some(note => note.includes('R9') && note.includes('missing')), caveats.join(' | '));
});
