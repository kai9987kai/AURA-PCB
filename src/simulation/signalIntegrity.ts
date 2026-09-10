import type { PCBTrace, SignalIntegrityReport } from '../types/pcb';

type Point = { x: number; y: number };

export interface SIAnalysis extends SignalIntegrityReport {
  sourceImpedance: number;
  loadImpedance: number;
  riseTimeNs: number;
  signalSwingV: number;
  substrateHeightMm: number;
  dielectricConstant: number;
  copperThicknessUm: number;
  electricallyLong: boolean;
  coupledLengthMm: number;
  modelNotes: string[];
}

function requireRange(value: number, name: string, min: number, max: number, inclusive = false) {
  if (!Number.isFinite(value) || (inclusive ? value < min : value <= min) || value > max) {
    throw new Error(`${name} must be ${inclusive ? 'at least' : 'greater than'} ${min} and at most ${max}.`);
  }
}

export function calculateTraceLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

// Hammerstad-Jensen quasi-static microstrip equations, including finite thickness.
// Equation reference: https://qucs.sourceforge.net/tech/node75.html
function microstrip(width: number, height: number, er: number, thickness: number) {
  const u = width / height;
  const t = thickness / height;
  const du1 = t === 0 ? 0 : t / Math.PI * Math.log1p(4 * Math.E / t * Math.tanh(Math.sqrt(6.517 * u)) ** 2);
  const dur = du1 * (1 + 1 / Math.cosh(Math.sqrt(er - 1))) / 2;
  const airImpedance = (ratio: number) => {
    const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / ratio) ** 0.7528));
    return 376.730313668 / (2 * Math.PI) * Math.log(f / ratio + Math.sqrt(1 + (2 / ratio) ** 2));
  };
  const ur = u + dur;
  const a = 1 + Math.log((ur ** 4 + (ur / 52) ** 2) / (ur ** 4 + 0.432)) / 49 + Math.log1p((ur / 18.1) ** 3) / 18.7;
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  const effectiveEr = (er + 1) / 2 + (er - 1) / 2 * (1 + 10 / ur) ** (-a * b);
  return {
    impedance: airImpedance(ur) / Math.sqrt(effectiveEr),
    effectiveEr: effectiveEr * (airImpedance(u + du1) / airImpedance(ur)) ** 2,
  };
}

// Geometric screening only: same-layer, different-net, nearly parallel overlap.
// This deliberately does not replace a coupled transmission-line model.
function parallelCoupling(trace: PCBTrace, others: PCBTrace[], height: number) {
  let strongest = 0;
  let coupledLength = 0;
  for (const other of others) {
    if (other.id === trace.id || other.net === trace.net || other.layer !== trace.layer) continue;
    let weightedLength = 0;
    let overlapTotal = 0;
    for (let i = 1; i < trace.points.length; i++) {
      const p = trace.points[i - 1];
      const q = trace.points[i];
      const length = Math.hypot(q.x - p.x, q.y - p.y);
      if (length === 0) continue;
      const ux = (q.x - p.x) / length;
      const uy = (q.y - p.y) / length;
      for (let j = 1; j < other.points.length; j++) {
        const a = other.points[j - 1];
        const b = other.points[j];
        const otherLength = Math.hypot(b.x - a.x, b.y - a.y);
        if (otherLength === 0 || Math.abs(((b.x - a.x) * ux + (b.y - a.y) * uy) / otherLength) < 0.98) continue;
        const start = (a.x - p.x) * ux + (a.y - p.y) * uy;
        const end = (b.x - p.x) * ux + (b.y - p.y) * uy;
        const overlap = Math.max(0, Math.min(length, Math.max(start, end)) - Math.max(0, Math.min(start, end)));
        const centerDistance = Math.min(Math.abs((a.x - p.x) * uy - (a.y - p.y) * ux), Math.abs((b.x - p.x) * uy - (b.y - p.y) * ux));
        const edgeSpacing = Math.max(0, centerDistance - (trace.width + other.width) / 2);
        weightedLength += overlap / (1 + (edgeSpacing / height) ** 2);
        overlapTotal += overlap;
      }
    }
    if (weightedLength > strongest) {
      strongest = weightedLength;
      coupledLength = Math.min(calculateTraceLength(trace.points), overlapTotal);
    }
  }
  return { factor: Math.min(1, strongest / 100), coupledLength };
}

export function analyzeTraceSI(
  trace: PCBTrace,
  otherTraces: PCBTrace[],
  substrateHeightMm = 1.6,
  dielectricConstant = 4.5,
  copperThicknessUm = 35,
  riseTimeNs = 0.5,
  sourceImpedance = 50,
  loadImpedance = 10000,
): SIAnalysis {
  requireRange(trace.width, 'Trace width (mm)', 0, 1000);
  requireRange(substrateHeightMm, 'Reference-plane distance (mm)', 0, 100);
  requireRange(dielectricConstant, 'Relative permittivity', 1, 128, true);
  requireRange(copperThicknessUm, 'Copper thickness (um)', 0, 1000, true);
  requireRange(riseTimeNs, 'Rise time (ns)', 0, 1e6);
  requireRange(sourceImpedance, 'Source impedance (ohm)', 0, 1e9, true);
  requireRange(loadImpedance, 'Load impedance (ohm)', 0, 1e9, true);
  if (trace.points.length < 2 || trace.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    throw new Error('A trace needs at least two finite coordinate points.');
  }
  const lengthMm = calculateTraceLength(trace.points);
  const { impedance, effectiveEr } = microstrip(trace.width, substrateHeightMm, dielectricConstant, copperThicknessUm / 1000);
  const propagationDelay = lengthMm * Math.sqrt(effectiveEr) / 299.792458;
  const gammaS = (sourceImpedance - impedance) / (sourceImpedance + impedance);
  const gammaL = (loadImpedance - impedance) / (loadImpedance + impedance);
  const electricallyLong = propagationDelay > riseTimeNs / 6;
  const coupling = parallelCoupling(trace, otherTraces, substrateHeightMm);
  const signalSwingV = 3.3;
  const crosstalkPeakVoltage = coupling.factor * signalSwingV * Math.min(1, 2 * propagationDelay / riseTimeNs) * 1000;
  const suggestions = [
    `Estimated impedance: ${impedance.toFixed(1)} ohm. Compare with this signal's actual target; 50 ohm is not a universal requirement.`,
  ];
  if (electricallyLong) {
    suggestions.push(`The ${Math.round(propagationDelay * 1000)} ps delay exceeds the rise-time/6 screening threshold. Review driver, receiver, and return-path models for reflections.`);
    const seriesR = Math.max(0, impedance - sourceImpedance);
    if (seriesR > 0) suggestions.push(`For a point-to-point high-impedance load, approximately ${seriesR.toFixed(0)} ohm series resistance at the driver is a starting estimate. Validate timing and the driver model before selecting termination.`);
  } else {
    suggestions.push('Electrically short under the selected rise time; this screening check does not assess vias, loads, or return-path interruptions.');
  }
  if (crosstalkPeakVoltage > 150) suggestions.push('Nearby parallel routing raises the coupling indicator. Increase separation or shorten parallel overlap, then check with a coupled-line model.');
  const modelNotes = [
    'Assumes a uniform external microstrip over a continuous reference plane. The board editor does not model or verify that plane.',
    'Coupling is a geometric indicator for same-layer traces, not a calibrated noise prediction. Cross-layer coupling, losses, vias, and receiver capacitance are omitted.',
  ];
  if (trace.width / substrateHeightMm < 0.01 || trace.width / substrateHeightMm > 100 || copperThicknessUm / 1000 >= substrateHeightMm / 2) {
    modelNotes.push('This geometry is outside the normal thin-conductor microstrip screening range; use a field solver.');
  }
  return {
    traceId: trace.id, netName: trace.net, impedance, propagationDelay,
    reflectionCoefficientSource: gammaS, reflectionCoefficientLoad: gammaL,
    crosstalkPeakVoltage, ringingFrequency: electricallyLong ? 1 / (4 * propagationDelay) : undefined,
    suggestions, sourceImpedance, loadImpedance, riseTimeNs, signalSwingV,
    substrateHeightMm, dielectricConstant, copperThicknessUm, electricallyLong,
    coupledLengthMm: coupling.coupledLength, modelNotes,
  };
}

export function simulateReflections(
  report: SignalIntegrityReport & Partial<SIAnalysis>,
  stepTimeNs = 0.05,
  stopTimeNs = 10,
): { time: number[]; voltage: number[] } {
  requireRange(stepTimeNs, 'Waveform time step (ns)', 0, 1e6);
  requireRange(stopTimeNs, 'Waveform duration (ns)', 0, 1e6);
  const steps = Math.ceil(stopTimeNs / stepTimeNs);
  if (steps > 20000) throw new Error('Waveform is limited to 20,000 time steps. Increase the time step.');
  const td = report.propagationDelay;
  requireRange(td, 'Propagation delay (ns)', 0, 1e9, true);
  const source = report.sourceImpedance ?? 50;
  const load = report.loadImpedance ?? 10000;
  const swing = report.signalSwingV ?? 3.3;
  const initial = swing * report.impedance / (source + report.impedance);
  const product = report.reflectionCoefficientSource * report.reflectionCoefficientLoad;
  const tau = (report.riseTimeNs ?? 0.5) / Math.log(9); // 10%-90% rise time.
  const time: number[] = [];
  const voltage: number[] = [];
  let filtered = 0;
  for (let step = 0; step <= steps; step++) {
    const t = Math.min(stopTimeNs, step * stepTimeNs);
    let raw = 0;
    if (td === 0) {
      raw = source + load === 0 ? 0 : swing * load / (source + load);
    } else if (t >= td) {
      const arrivals = Math.floor((t - td) / (2 * td)) + 1;
      const sum = product === 1 ? arrivals : (1 - product ** arrivals) / (1 - product);
      raw = initial * (1 + report.reflectionCoefficientLoad) * sum;
    }
    const dt = step === 0 ? 0 : t - time[step - 1];
    filtered += -Math.expm1(-dt / tau) * (raw - filtered);
    time.push(t);
    voltage.push(filtered);
  }
  return { time, voltage };
}
