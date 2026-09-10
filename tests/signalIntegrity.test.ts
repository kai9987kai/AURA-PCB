import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTraceSI, calculateTraceLength, simulateReflections } from '../src/simulation/signalIntegrity.ts';
import type { PCBTrace } from '../src/types/pcb.ts';

const trace: PCBTrace = { id: 't1', net: 'CLK', layer: 'top', width: 0.3, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] };

test('trace length and documented microstrip geometry produce plausible dimensions', () => {
  assert.equal(calculateTraceLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
  const report = analyzeTraceSI({ ...trace, width: 3 }, [], 1.6, 4.5, 35);
  assert.ok(report.impedance > 45 && report.impedance < 55, `${report.impedance} ohm`);
  assert.ok(report.propagationDelay > 0.55 && report.propagationDelay < 0.7);
  const air = analyzeTraceSI(trace, [], 1.6, 1, 0);
  assert.ok(Math.abs(air.propagationDelay - 100 / 299.792458) < 1e-10);
});

test('microstrip impedance responds to width, plane distance, and copper thickness', () => {
  const base = analyzeTraceSI(trace, []);
  assert.ok(analyzeTraceSI({ ...trace, width: 0.6 }, []).impedance < base.impedance);
  assert.ok(analyzeTraceSI(trace, [], 0.8).impedance < base.impedance);
  assert.ok(analyzeTraceSI(trace, [], 1.6, 4.5, 70).impedance < base.impedance);
  assert.ok(analyzeTraceSI({ ...trace, width: 20 }, []).impedance > 0);
});

test('coupling only screens overlapping, parallel, different-net traces on the same layer', () => {
  const neighbor: PCBTrace = { ...trace, id: 't2', net: 'DATA', points: [{ x: 20, y: 1 }, { x: 80, y: 1 }] };
  const report = analyzeTraceSI(trace, [neighbor]);
  assert.equal(report.coupledLengthMm, 60);
  assert.ok(report.crosstalkPeakVoltage > 0);
  assert.equal(analyzeTraceSI(trace, [{ ...neighbor, net: 'CLK' }]).crosstalkPeakVoltage, 0);
  assert.equal(analyzeTraceSI(trace, [{ ...neighbor, layer: 'bottom' }]).crosstalkPeakVoltage, 0);
  assert.equal(analyzeTraceSI(trace, [{ ...neighbor, points: [{ x: 105, y: 1 }, { x: 125, y: 1 }] }]).crosstalkPeakVoltage, 0);
  assert.equal(analyzeTraceSI(trace, [{ ...neighbor, points: [{ x: 50, y: -20 }, { x: 50, y: 20 }] }]).crosstalkPeakVoltage, 0);
  const farther = analyzeTraceSI(trace, [{ ...neighbor, points: [{ x: 20, y: 10 }, { x: 80, y: 10 }] }]);
  assert.ok(farther.crosstalkPeakVoltage < report.crosstalkPeakVoltage);
});

test('matched line approaches its voltage divider and respects propagation delay', () => {
  const z0 = analyzeTraceSI(trace, []).impedance;
  const report = analyzeTraceSI(trace, [], 1.6, 4.5, 35, 0.1, z0, z0);
  const waveform = simulateReflections(report, 0.01, 10);
  assert.ok(waveform.voltage.filter((_, index) => waveform.time[index] < report.propagationDelay).every(value => value === 0));
  assert.ok(Math.abs(waveform.voltage.at(-1)! - 1.65) < 1e-6);
});

test('waveform follows source impedance and specified rise time', () => {
  const z0 = analyzeTraceSI(trace, []).impedance;
  const matched = analyzeTraceSI(trace, [], 1.6, 4.5, 35, 0.1, z0, z0);
  const weakDriver = analyzeTraceSI(trace, [], 1.6, 4.5, 35, 0.1, 2 * z0, z0);
  const slow = analyzeTraceSI(trace, [], 1.6, 4.5, 35, 2, z0, z0);
  const fastWave = simulateReflections(matched, 0.01, 10);
  const weakWave = simulateReflections(weakDriver, 0.01, 10);
  const slowWave = simulateReflections(slow, 0.01, 10);
  assert.ok(Math.abs(weakWave.voltage.at(-1)! - 1.1) < 1e-6);
  assert.ok(slowWave.voltage[100] < fastWave.voltage[100]);
  assert.ok(!matched.suggestions.some(text => text.includes('will cause ringing') || text.includes('parallel terminator')));
});

test('zero-length lines and ideal zero-ohm source are finite and invalid inputs fail clearly', () => {
  const report = analyzeTraceSI({ ...trace, points: [{ x: 2, y: 2 }, { x: 2, y: 2 }] }, [], 1.6, 4.5, 35, 0.5, 0);
  const waveform = simulateReflections(report);
  assert.ok(waveform.voltage.every(Number.isFinite));
  assert.ok(Math.abs(waveform.voltage.at(-1)! - 3.3) < 1e-6);
  assert.throws(() => analyzeTraceSI(trace, [], 0), /Reference-plane distance/);
  assert.throws(() => analyzeTraceSI(trace, [], 1.6, 4.5, 35, -1), /Rise time/);
  assert.throws(() => analyzeTraceSI({ ...trace, width: NaN }, []), /Trace width/);
  assert.throws(() => simulateReflections(report, 0), /time step/);
  assert.throws(() => simulateReflections(report, 1e-8), /20,000/);
});
