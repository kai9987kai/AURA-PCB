import test from 'node:test';
import assert from 'node:assert/strict';
import { parseValue, runSpiceSimulation } from '../src/simulation/spiceSolver.ts';
import { createThermalGrid, solveThermalStep } from '../src/simulation/thermalSolver.ts';
import type { ComponentType, SchematicComponent, SchematicData, SimSettings } from '../src/types/pcb.ts';

function component(id: string, type: ComponentType, value: string, pins: string[]): SchematicComponent {
  return { id, type, value, name: id, x: 0, y: 0, rotation: 0, params: {}, pins: pins.map(id => ({ id, label: id, relX: 0, relY: 0 })) };
}

function circuit(loadType: ComponentType = 'resistor', loadValue = '1k', sourceValue = '5V'): SchematicData {
  const loadPins = ['diode', 'led'].includes(loadType) ? ['a', 'c'] : ['1', '2'];
  const schematic: SchematicData = {
    components: [component('V1', 'voltage_source', sourceValue, ['p', 'n']), component('R1', 'resistor', '1k', ['1', '2']), component('X1', loadType, loadValue, loadPins), component('G1', 'gnd', '', ['gnd'])], wires: [],
  };
  const links = [['V1', 'p', 'R1', '1'], ['R1', '2', 'X1', loadPins[0]], ['X1', loadPins[1], 'G1', 'gnd'], ['V1', 'n', 'G1', 'gnd']];
  schematic.wires = links.map(([fromCompId, fromPinId, toCompId, toPinId], i) => ({ id: `W${i}`, fromCompId, fromPinId, toCompId, toPinId, net: '', points: [] }));
  return schematic;
}

const settings: SimSettings = { type: 'transient', stopTime: 0.005, stepTime: 0.00001 };

test('engineering values accept scientific notation and reject trailing junk', () => {
  for (const [text, expected] of [['1e-6', 1e-6], ['2.2kOhm', 2200], ['100nF', 1e-7], ['1MEG', 1e6], ['5V', 5], ['2.2uF', 2.2e-6]] as const) assert.ok(Math.abs(parseValue(text) - expected) <= Math.abs(expected) * 1e-12, text);
  for (const invalid of ['', '10banana', '1.2.3', 'Infinity', 'NaN']) assert.ok(Number.isNaN(parseValue(invalid)), invalid);
});

test('DC divider obeys Ohm law, power balance, and source loss semantics', () => {
  const result = runSpiceSimulation(circuit(), settings);
  assert.ok(result.voltages['N_R1:2'].every(value => Math.abs(value - 2.5) < 1e-10));
  assert.ok(result.currents.R1.every(value => Math.abs(value - 0.0025) < 1e-12));
  assert.ok(Math.abs(result.powerDissipation.R1 - 0.00625) < 1e-12);
  assert.equal(result.powerDissipation.V1, 0);
  assert.equal(result.timepoints.at(-1), settings.stopTime);
});

test('RC charging agrees with analytic exponential and monotonic energy storage', () => {
  const result = runSpiceSimulation(circuit('capacitor', '1u'), settings);
  let previous = 0;
  result.timepoints.forEach((time, index) => {
    const voltage = result.voltages['N_R1:2'][index];
    assert.ok(voltage >= previous && voltage < 5);
    assert.ok(Math.abs(voltage - 5 * (1 - Math.exp(-time / 0.001))) < 0.01);
    assert.ok(Math.abs(result.currents.R1[index] - result.currents.X1[index]) < 1e-10);
    previous = voltage;
  });
  assert.equal(result.powerDissipation.X1, 0);
  assert.equal(result.timepoints[0], settings.stepTime);
});

test('RL current approaches V/R with the expected time constant', () => {
  const result = runSpiceSimulation(circuit('inductor', '1H'), settings);
  result.timepoints.forEach((time, index) => assert.ok(Math.abs(result.currents.X1[index] - 0.005 * (1 - Math.exp(-time / 0.001))) < 0.00001));
  assert.equal(result.powerDissipation.X1, 0);
});

test('diode and LED currents converge and satisfy series KCL', () => {
  for (const type of ['diode', 'led'] as const) {
    const result = runSpiceSimulation(circuit(type, ''), { ...settings, stopTime: 0.0001 });
    assert.ok(result.voltages['N_R1:2'][0] > 0.5 && result.voltages['N_R1:2'][0] < 2.5);
    result.currents.R1.forEach((current, i) => assert.ok(Math.abs(current - result.currents.X1[i]) < 1e-8));
  }
});

test('pulse values use requested levels and frequency, and sine allows zero amplitude', () => {
  const pulse = runSpiceSimulation(circuit('resistor', '1k', 'pulse(1,3,1k)'), { ...settings, stopTime: 0.002, stepTime: 0.00025 });
  assert.equal(pulse.voltages['N_R1:1'][0], 3);
  assert.equal(pulse.voltages['N_R1:1'][1], 1);
  const constant = runSpiceSimulation(circuit('resistor', '1k', 'sin(2,0,1k)'), settings);
  assert.ok(constant.voltages['N_R1:1'].every(value => value === 2));
});

test('invalid times and excessive work fail before simulation', () => {
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => runSpiceSimulation(circuit(), { ...settings, stepTime: value }), /finite|positive/);
    assert.throws(() => runSpiceSimulation(circuit(), { ...settings, stopTime: value }), /finite|positive/);
  }
  assert.throws(() => runSpiceSimulation(circuit(), { ...settings, stepTime: 1e-20 }), /time steps/);
  assert.throws(() => runSpiceSimulation(circuit(), { ...settings, type: 'dc_sweep' }), /Only transient/);
});

test('floating circuits and source conflicts fail instead of manufacturing a pivot', () => {
  const floating = circuit();
  floating.components.push(component('R2', 'resistor', '1k', ['1', '2']));
  assert.throws(() => runSpiceSimulation(floating, settings), /Singular/);
  const conflict = circuit();
  conflict.wires.push({ id: 'short', fromCompId: 'V1', fromPinId: 'p', toCompId: 'V1', toPinId: 'n', points: [], net: '' });
  assert.throws(() => runSpiceSimulation(conflict, settings), /Singular/);
});

test('invalid parts and dangling wire references are reported', () => {
  assert.throws(() => runSpiceSimulation(circuit('resistor', '-1'), settings), /positive/);
  const malformed = circuit();
  malformed.wires[0].toPinId = 'missing';
  assert.throws(() => runSpiceSimulation(malformed, settings), /missing pin/);
});

test('last fractional step ends exactly at stop time', () => {
  const result = runSpiceSimulation(circuit('capacitor', '1u'), { ...settings, stepTime: 0.0007 });
  assert.equal(result.timepoints.at(-1), settings.stopTime);
  assert.ok(result.timepoints.every(t => t <= settings.stopTime));
});

test('uniform thermal equilibrium stays at ambient', () => {
  const grid = createThermalGrid(3, 3, 1.5);
  const next = solveThermalStep(grid, new Float32Array(4).fill(0.3), [], 25, 15);
  assert.ok([...next.temperatures].every(value => Math.abs(value - 25) < 1e-5));
});
