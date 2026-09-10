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
export function computeFftSpectrum(
  timepoints: number[],
  voltages: number[],
  maxFftPoints: number = 1024
): FFTSpectrumData {
  if (timepoints.length < 4 || voltages.length < 4) {
    return {
      frequenciesHz: [],
      magnitudesDb: [],
      fundamentalFreqHz: 0,
      peakMagnitudeDb: -100,
      thdPercent: 0,
    };
  }

  const tStart = timepoints[0];
  const tEnd = timepoints[timepoints.length - 1];
  const totalDuration = tEnd - tStart;
  if (totalDuration <= 0) {
    return {
      frequenciesHz: [],
      magnitudesDb: [],
      fundamentalFreqHz: 0,
      peakMagnitudeDb: -100,
      thdPercent: 0,
    };
  }

  // Choose power of 2 size
  let n = 64;
  while (n * 2 <= Math.min(timepoints.length, maxFftPoints)) {
    n *= 2;
  }
  n = Math.min(n, 1024);

  const dt = totalDuration / (n - 1);
  const sampleRate = 1 / dt;

  // Resample voltages at uniform time points
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  let srcIdx = 0;
  for (let i = 0; i < n; i++) {
    const t = tStart + i * dt;
    while (srcIdx < timepoints.length - 2 && timepoints[srcIdx + 1] < t) {
      srcIdx++;
    }
    const t0 = timepoints[srcIdx];
    const t1 = timepoints[srcIdx + 1] || t0;
    const v0 = voltages[srcIdx];
    const v1 = voltages[srcIdx + 1] !== undefined ? voltages[srcIdx + 1] : v0;

    const alpha = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const interpV = v0 + alpha * (v1 - v0);

    // Apply Hann window: w(i) = 0.5 * (1 - cos(2*pi*i / (n - 1)))
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[i] = interpV * window;
  }

  // Run FFT
  radix2Fft(re, im);

  // Single-sided spectrum up to Nyquist (N/2)
  const numBins = Math.floor(n / 2);
  const frequenciesHz: number[] = new Array(numBins);
  const magnitudesDb: number[] = new Array(numBins);
  const rawMagnitudes: number[] = new Array(numBins);

  let fundamentalBin = 1;
  let maxNonDcMag = -Infinity;

  // Window coherent gain correction for Hann window is 2.0
  const normFactor = (2.0 / n) * 2.0;

  for (let k = 0; k < numBins; k++) {
    frequenciesHz[k] = (k * sampleRate) / n;
    const mag = Math.hypot(re[k], im[k]) * normFactor;
    rawMagnitudes[k] = mag;
    // Limit lower threshold to -120 dBV
    const db = 20 * Math.log10(Math.max(1e-6, mag));
    magnitudesDb[k] = Math.max(-120, Math.min(60, db));

    // Exclude DC (k=0) from fundamental search
    if (k > 0 && mag > maxNonDcMag) {
      maxNonDcMag = mag;
      fundamentalBin = k;
    }
  }

  const fundamentalFreqHz = frequenciesHz[fundamentalBin] || 0;
  const peakMagnitudeDb = magnitudesDb[fundamentalBin] || -100;

  // Estimate Total Harmonic Distortion (THD) from 2nd through 5th harmonics
  let harmonicEnergy = 0;
  const f0Mag = rawMagnitudes[fundamentalBin] || 1e-9;

  for (let h = 2; h <= 5; h++) {
    const targetBin = fundamentalBin * h;
    if (targetBin < numBins) {
      const harmMag = rawMagnitudes[targetBin];
      harmonicEnergy += harmMag * harmMag;
    }
  }

  const thdPercent = f0Mag > 1e-6
    ? Math.min(100, (Math.sqrt(harmonicEnergy) / f0Mag) * 100)
    : 0;

  return {
    frequenciesHz,
    magnitudesDb,
    fundamentalFreqHz,
    peakMagnitudeDb,
    thdPercent: Math.round(thdPercent * 10) / 10,
  };
}
