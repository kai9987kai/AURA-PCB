import type { PCBTrace, SignalIntegrityReport } from '../types/pcb';

// Calculate length of a trace path in mm
export function calculateTraceLength(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

// Signal Integrity Analyzer
// Computes characteristic impedance Z0, propagation delays, crosstalk, and reflections
export function analyzeTraceSI(
  trace: PCBTrace,
  otherTraces: PCBTrace[],
  substrateHeightMm: number = 1.6, // h
  dielectricConstant: number = 4.5, // er (FR4)
  copperThicknessUm: number = 35, // t (1 oz copper = 35um)
  riseTimeNs: number = 0.5, // tr (typical high speed rise time)
  sourceImpedance: number = 50, // Zs
  loadImpedance: number = 10000 // Zl (high-z CMOS gate)
): SignalIntegrityReport {
  const lengthMm = calculateTraceLength(trace.points);
  
  // Convert copper thickness to mm
  const t = copperThicknessUm / 1000.0;
  const w = trace.width;
  const h = substrateHeightMm;
  const er = dielectricConstant;

  // 1. Calculate Microstrip Characteristic Impedance Z0 (IPC-2141 formula)
  // Z0 = (87 / sqrt(er + 1.41)) * ln( 5.98 * h / (0.8 * w + t) )
  const innerFactor = (5.98 * h) / (0.8 * w + t);
  const z0 = (87.0 / Math.sqrt(er + 1.41)) * Math.log(Math.max(1.001, innerFactor));

  // 2. Calculate Effective Dielectric Constant
  // ereff = (er + 1)/2 + (er - 1)/2 * 1 / sqrt(1 + 12h/w)
  const ereff = (er + 1) / 2 + ((er - 1) / 2) * (1 / Math.sqrt(1 + (12 * h) / w));

  // Speed of light in vacuum is ~300 mm/ns
  const c = 299.792458; // mm/ns
  const v = c / Math.sqrt(ereff); // signal propagation speed on microstrip in mm/ns

  // Propagation delay in ns
  const propagationDelay = lengthMm / v;

  // Reflection coefficients
  const gammaS = (sourceImpedance - z0) / (sourceImpedance + z0);
  const gammaL = (loadImpedance - z0) / (loadImpedance + z0);

  // 3. Critical Length check:
  // Transmission line effects are significant if propagation delay > riseTime / 6
  const isTxLine = propagationDelay > riseTimeNs / 6;

  // 4. Estimate Crosstalk to nearest parallel trace
  // Find minimum distance to other traces that run parallel
  let minDistanceMm = Infinity;
  otherTraces.forEach(other => {
    if (other.id === trace.id) return;
    
    // Simple spatial proximity check
    // We average distances between all segments or find min distance between points
    trace.points.forEach(p1 => {
      other.points.forEach(p2 => {
        const dist = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
        if (dist < minDistanceMm) {
          minDistanceMm = dist;
        }
      });
    });
  });

  // Calculate crosstalk coefficient based on spacing
  // Kb = 1 / (1 + (d/h)^2) where d is spacing, h is dielectric height
  let kCrosstalk = 0;
  if (minDistanceMm < Infinity && minDistanceMm > 0) {
    const spacingRatio = minDistanceMm / h;
    kCrosstalk = 1.0 / (1.0 + spacingRatio * spacingRatio);
    // Scale by overlap length approximation
    kCrosstalk *= Math.min(1.0, lengthMm / 100.0);
  }

  // Peak crosstalk voltage assuming a 3.3V signal swing
  const signalSwingV = 3.3;
  const couplingFactor = Math.min(1.0, (2.0 * propagationDelay) / riseTimeNs);
  const crosstalkPeakVoltage = kCrosstalk * signalSwingV * couplingFactor * 1000; // in mV

  // 5. Generate Suggestions
  const suggestions: string[] = [];

  if (z0 < 45) {
    suggestions.push(`Impedance (${z0.toFixed(1)}Ω) is low. Consider reducing trace width or increasing dielectric thickness.`);
  } else if (z0 > 65) {
    suggestions.push(`Impedance (${z0.toFixed(1)}Ω) is high. Consider widening trace width or using a thinner prepreg layer.`);
  } else {
    suggestions.push(`Excellent impedance matching: ${z0.toFixed(1)}Ω is close to the 50Ω reference standard.`);
  }

  if (isTxLine) {
    suggestions.push(
      `Trace is electrically LONG (${(propagationDelay * 1000).toFixed(0)}ps delay > ${((riseTimeNs * 1000) / 6).toFixed(0)}ps critical limit). Reflections will cause ringing. Add a ${(z0).toFixed(0)}Ω parallel terminator at the load.`
    );
  } else {
    suggestions.push(`Trace is electrically short. Signal reflections will settle during rise time. No termination required.`);
  }

  if (crosstalkPeakVoltage > 150) {
    suggestions.push(
      `Crosstalk warning: coupling to adjacent traces is high (${crosstalkPeakVoltage.toFixed(0)} mV). Increase spacing to at least ${(3 * trace.width).toFixed(2)} mm (3W rule).`
    );
  }

  return {
    traceId: trace.id,
    netName: trace.net,
    impedance: z0,
    propagationDelay,
    reflectionCoefficientSource: gammaS,
    reflectionCoefficientLoad: gammaL,
    crosstalkPeakVoltage,
    ringingFrequency: isTxLine ? 1 / (4 * propagationDelay) : undefined, // GHz
    suggestions
  };
}

// Generate wave reflection waveform data over time for oscilloscope visualization
// We simulate a step input from 0 to 3.3V starting at t=0
export function simulateReflections(
  report: SignalIntegrityReport,
  stepTimeNs: number = 0.05,
  stopTimeNs: number = 10
): { time: number[]; voltage: number[] } {
  const { propagationDelay, impedance } = report;
  const gammaS = report.reflectionCoefficientSource;
  const gammaL = report.reflectionCoefficientLoad;
  const td = propagationDelay; // one-way delay

  const time: number[] = [];
  const voltage: number[] = [];

  const V_step = 3.3;
  const Z0 = impedance;
  const Zs = 50; // source resistance
  
  // Initial voltage launched into the transmission line
  const V_initial = V_step * (Z0 / (Zs + Z0));

  const steps = Math.ceil(stopTimeNs / stepTimeNs);

  for (let step = 0; step <= steps; step++) {
    const t = step * stepTimeNs;
    time.push(t);

    // Sum all waves arriving at the load (located at x = length).
    // A wave arrives at the load at t = (2k + 1) * Td for k = 0, 1, 2...
    let rawVoltage = 0;

    for (let k = 0; k < 10; k++) {
      const arrivalTime = (2 * k + 1) * td;
      if (t >= arrivalTime) {
        // Reflection factor for this round trip
        const factor = Math.pow(gammaS * gammaL, k);
        rawVoltage += V_initial * factor * (1 + gammaL);
      } else {
        break;
      }
    }

    // The finite edge rate is applied as a low-pass filter after building the stepped waveform.
    voltage.push(rawVoltage);
  }

  // Let's filter the voltage array to simulate rise-time distortion
  const filteredVoltage: number[] = [];
  let currentVal = 0;
  const RC = 0.25; // filter time constant in ns
  
  for (let i = 0; i < time.length; i++) {
    const dt = stepTimeNs;
    const alpha = dt / (RC + dt);
    currentVal = currentVal + alpha * (voltage[i] - currentVal);
    filteredVoltage.push(currentVal);
  }

  return { time, voltage: filteredVoltage };
}
