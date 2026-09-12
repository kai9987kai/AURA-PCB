import type { FFTSpectrumData } from '../types/pcb';

/**
 * Perform Radix-2 Cooley-Tukey Fast Fourier Transform.
 * Length N must be a power of 2.
 */
function radix2Fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be a power of 2');

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tempR = re[i]; re[i] = re[j]; re[j] = tempR;
      const tempI = im[i]; im[i] = im[j]; im[j] = tempI;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Cooley-Tukey computation
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wR = 1.0;
      let wI = 0.0;
      for (let k = 0; k < half; k++) {
        const uR = re[i + k];
        const uI = im[i + k];
        const vR = re[i + k + half] * wR - im[i + k + half] * wI;
        const vI = re[i + k + half] * wI + im[i + k + half] * wR;

        re[i + k] = uR + vR;
        im[i + k] = uI + vI;
        re[i + k + half] = uR - vR;
        im[i + k + half] = uI - vI;

        const nextWR = wR * wStepR - wI * wStepI;
        wI = wR * wStepI + wI * wStepR;
        wR = nextWR;
      }
    }
  }
}

/**
 * Compute the single-sided FFT frequency spectrum from transient simulation results.
 */
export function computeFftSpectrum(timepoints: number[], voltages: number[], maxFftPoints = 1024): FFTSpectrumData {
  if (timepoints.length !== voltages.length) throw new Error('Times and voltages must have the same length.');
  if (timepoints.length < 4) throw new Error('At least four samples are required.');
  if (!Number.isInteger(maxFftPoints) || maxFftPoints < 4 || maxFftPoints > 16384 || timepoints.length > 1000000) throw new Error('FFT work limit must be an integer from 4 to 16384; records are limited to one million samples.');
  if (timepoints.some(t => !Number.isFinite(t)) || voltages.some(v => !Number.isFinite(v))) throw new Error('Samples must be finite.');
  const warnings: string[] = [];
  const dt = timepoints[1] - timepoints[0];
  if (!(dt > 0)) throw new Error('Sample times must be strictly increasing.');
  let end = timepoints.length;
  for (let i = 1; i < timepoints.length; i++) {
    const interval = timepoints[i] - timepoints[i - 1];
    if (!(interval > 0)) throw new Error('Sample times must be strictly increasing.');
    if (Math.abs(interval - dt) > dt * 1e-6) {
      if (i === timepoints.length - 1 && interval < dt && i >= 4) {
        end--; warnings.push('Excluded the fractional final solver step to keep uniform sampling.');
      } else throw new Error('FFT requires uniformly spaced samples.');
    }
  }
  const n = 2 ** Math.floor(Math.log2(Math.min(end, maxFftPoints)));
  const start = end - n;
  if (start) warnings.push('Using the last ' + n + ' contiguous samples at their native sample rate.');
  const values = voltages.slice(start, end);
  const dcOffsetV = values.reduce((sum, v) => sum + v / n, 0);
  const rmsV = Math.sqrt(values.reduce((sum, v) => sum + (v / Math.sqrt(n)) ** 2, 0));
  const re = Float64Array.from(values, (v, i) => (v - dcOffsetV) * 0.5 * (1 - Math.cos(2 * Math.PI * i / n)));
  const im = new Float64Array(n);
  radix2Fft(re, im);
  const sampleRateHz = 1 / dt;
  const resolution = sampleRateHz / n;
  const amplitudes = Array.from({ length: n / 2 + 1 }, (_, k) => k === 0 ? Math.abs(dcOffsetV) : Math.hypot(re[k], im[k]) * (k === n / 2 ? 2 : 2 * Math.SQRT2) / n);
  if (!Number.isFinite(rmsV) || amplitudes.some(v => !Number.isFinite(v))) throw new Error('Sample magnitudes exceed the finite FFT range.');
  let peak = 0;
  for (let k = 1; k < amplitudes.length; k++) if (amplitudes[k] > Math.max(1e-12, rmsV * 1e-12) && (!peak || amplitudes[k] > amplitudes[peak])) peak = k;
  const magnitudesDb = amplitudes.map(v => 20 * Math.log10(Math.max(1e-6, v)));
  let thdPercent: number | null = null;
  if (peak >= 4 && peak * 5 < n / 2 - 1) {
    const left = amplitudes[peak - 1]; const right = amplitudes[peak + 1];
    if (Math.abs(left - right) / amplitudes[peak] < 0.01) thdPercent = Math.sqrt([2,3,4,5].reduce((sum, h) => sum + amplitudes[peak * h] ** 2, 0)) / amplitudes[peak] * 100;
  }
  if (thdPercent === null) warnings.push('Harmonic ratio unavailable: needs a resolved, bin-centred dominant tone and harmonics 2–5 below Nyquist.');
  warnings.push('Dominant AC is the strongest bin, not necessarily the fundamental. Off-bin amplitudes have Hann scalloping error; aliasing above Nyquist cannot be diagnosed from these samples.');
  return { frequenciesHz: amplitudes.map((_, k) => k * resolution), magnitudesDb,
    fundamentalFreqHz: peak * resolution, peakMagnitudeDb: peak ? magnitudesDb[peak] : -120, thdPercent,
    sampleCount: n, sampleRateHz, frequencyResolutionHz: resolution, nyquistHz: sampleRateHz / 2,
    startTimeS: timepoints[start], endTimeS: timepoints[end - 1], dcOffsetV, rmsV, warnings };
}
