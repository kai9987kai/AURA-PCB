import assert from 'node:assert/strict';
import test from 'node:test';
import { computeFftSpectrum } from '../src/simulation/fft.ts';

const times = (count = 1024, rate = 1024) => Array.from({ length: count }, (_, i) => i / rate);
const near = (actual: number, expected: number, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);

test('DC and zero have no AC tone, with undoubled DC and no invented harmonic ratio', () => {
  const t = times();
  for (const dc of [0, 5, -3]) {
    const spectrum = computeFftSpectrum(t, t.map(() => dc));
    assert.equal(spectrum.fundamentalFreqHz, 0);
    assert.equal(spectrum.thdPercent, null);
    near(spectrum.dcOffsetV, dc);
    near(spectrum.rmsV, Math.abs(dc));
    near(spectrum.magnitudesDb[0], dc === 0 ? -120 : 20 * Math.log10(Math.abs(dc)));
    assert.ok(spectrum.magnitudesDb.slice(1).every(value => value === -120));
  }
});

test('a coherent sine on a DC offset has calibrated RMS dBV amplitude', () => {
  const t = times();
  const spectrum = computeFftSpectrum(t, t.map(time => 5 + Math.SQRT2 * Math.sin(2 * Math.PI * 32 * time)));
  near(spectrum.fundamentalFreqHz, 32);
  near(spectrum.peakMagnitudeDb, 0);
  near(spectrum.dcOffsetV, 5);
  near(spectrum.rmsV, Math.sqrt(26));
  near(spectrum.thdPercent!, 0, 1e-6);
  assert.equal(spectrum.frequenciesHz.length, 513);
  assert.equal(spectrum.nyquistHz, 512);
});

test('limiting FFT work retains the native sample rate instead of aliasing a high tone', () => {
  const t = times(10000, 10000);
  const spectrum = computeFftSpectrum(t, t.map(time => Math.sin(2 * Math.PI * 2000 * time)));
  assert.equal(spectrum.sampleCount, 1024);
  near(spectrum.sampleRateHz, 10000);
  near(spectrum.frequencyResolutionHz, 10000 / 1024);
  near(spectrum.fundamentalFreqHz, 2000, spectrum.frequencyResolutionHz / 2);
  assert.equal(spectrum.startTimeS, t[10000 - 1024]);
  assert.equal(spectrum.endTimeS, t.at(-1));
  assert.ok(spectrum.warnings.some(warning => /contiguous|last/.test(warning)));
});

test('a fractional final solver step is excluded without shifting frequency bins', () => {
  const t = times(1024, 1024);
  t.push(t.at(-1)! + 0.0001);
  const spectrum = computeFftSpectrum(t, t.map(time => Math.sin(2 * Math.PI * 32 * time)));
  assert.equal(spectrum.sampleCount, 1024);
  assert.equal(spectrum.sampleRateHz, 1024);
  assert.equal(spectrum.endTimeS, 1023 / 1024);
  assert.equal(spectrum.fundamentalFreqHz, 32);
  assert.ok(spectrum.warnings.some(warning => /fractional/.test(warning)));
});

test('Nyquist amplitude is single sided only once', () => {
  const t = times();
  const spectrum = computeFftSpectrum(t, t.map((_, i) => i % 2 === 0 ? 2 : -2));
  assert.equal(spectrum.frequenciesHz.at(-1), 512);
  near(spectrum.magnitudesDb.at(-1)!, 20 * Math.log10(2));
  assert.equal(spectrum.thdPercent, null);
});

test('resolved harmonic ratio follows known second and third harmonic energy', () => {
  const t = times();
  const spectrum = computeFftSpectrum(t, t.map(time =>
    Math.sin(2 * Math.PI * 32 * time) + 0.1 * Math.sin(2 * Math.PI * 64 * time) + 0.05 * Math.sin(2 * Math.PI * 96 * time)));
  near(spectrum.thdPercent!, Math.sqrt(0.1 ** 2 + 0.05 ** 2) * 100, 0.01);
});

test('unresolved, off-bin, and bandwidth-limited tones do not fabricate precise harmonic ratios', () => {
  const t = times();
  for (const frequency of [1, 32.4, 200]) {
    const spectrum = computeFftSpectrum(t, t.map(time => Math.sin(2 * Math.PI * frequency * time)));
    assert.equal(spectrum.thdPercent, null, `${frequency} Hz`);
  }
});

test('FFT bounds never upsample a short record or ignore the requested work limit', () => {
  const t = times(12, 1024);
  const spectrum = computeFftSpectrum(t, t.map(time => Math.sin(2 * Math.PI * 128 * time)), 4);
  assert.equal(spectrum.sampleCount, 4);
  assert.equal(spectrum.frequenciesHz.length, 3);
  assert.equal(spectrum.sampleRateHz, 1024);
});

test('invalid FFT inputs fail clearly instead of yielding NaN spectra', () => {
  const t = times(8);
  const v = t.map(() => 1);
  assert.throws(() => computeFftSpectrum(t, v.slice(1)), /same length/);
  assert.throws(() => computeFftSpectrum([0, 1, 1, 3], [1, 2, 3, 4]), /increasing/);
  assert.throws(() => computeFftSpectrum([0, 1, 3, 4], [1, 2, 3, 4]), /uniform/);
  assert.throws(() => computeFftSpectrum([0, 1, 2, NaN], [1, 2, 3, 4]), /finite/);
  assert.throws(() => computeFftSpectrum(t, [NaN, ...v.slice(1)]), /finite/);
  assert.throws(() => computeFftSpectrum(t.slice(0, 3), v.slice(0, 3)), /four/);
  for (const limit of [0, 3, 4.5, NaN, Infinity, 1e9]) {
    assert.throws(() => computeFftSpectrum(t, v, limit), /limit/);
  }
});
