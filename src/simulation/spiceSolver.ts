import type { SchematicData, SimResult, SimSettings } from '../types/pcb';

// SPICE notation: M is milli; use MEG for mega. Invalid values return NaN.
export function parseValue(value: string): number {
  const match = value.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(meg|[pnuμµmkg])?\s*(?:ohms?|Ω|[vafh]|hz)?$/i);
  if (!match) return NaN;
  const scale: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, μ: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9 };
  return Number(match[1]) * (scale[(match[2] || '').toLowerCase()] ?? 1);
}

export const SIMULATION_LIMITS = { maxSteps: 10000, maxUnknowns: 96, maxWork: 250_000_000 };

function junction(voltage: number, led = false) {
  const saturation = led ? 1e-18 : 1e-14;
  const vt = led ? 0.052 : 0.026;
  if (voltage / vt > 60) throw new Error('Junction exceeds the simplified model range. Add current limiting or use a device SPICE model.');
  const exponential = Math.exp(voltage / vt);
  return { current: saturation * (exponential - 1) + 1e-12 * voltage, conductance: saturation / vt * exponential + 1e-12 };
}

// Simple Gaussian elimination with partial pivoting to solve A * x = B
function solveMatrix(A: number[][], B: number[]): number[] {
  const n = B.length;
  const ACopy = A.map(row => [...row]);
  const BCopy = [...B];

  for (let row = 0; row < n; row++) {
    const scale = Math.max(...ACopy[row].map(Math.abs));
    if (!Number.isFinite(scale) || scale === 0 || !Number.isFinite(BCopy[row])) throw new Error('Singular or non-finite circuit. Check floating pins and conflicting ideal voltage sources.');
    ACopy[row] = ACopy[row].map(value => value / scale);
    BCopy[row] /= scale;
  }
  for (let i = 0; i < n; i++) {
    // Search for maximum in this column
    let maxEl = Math.abs(ACopy[i][i]);
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(ACopy[k][i]) > maxEl) {
        maxEl = Math.abs(ACopy[k][i]);
        maxRow = k;
      }
    }

    // Swap maximum row with current row
    const tmpRow = ACopy[maxRow];
    ACopy[maxRow] = ACopy[i];
    ACopy[i] = tmpRow;

    const tmpB = BCopy[maxRow];
    BCopy[maxRow] = BCopy[i];
    BCopy[i] = tmpB;

    if (Math.abs(ACopy[i][i]) < 1e-14) throw new Error('Singular or ill-conditioned circuit. Connect floating nodes and remove conflicting ideal sources.');

    // Upper triangularize
    for (let k = i + 1; k < n; k++) {
      const c = -ACopy[k][i] / ACopy[i][i];
      for (let j = i; j < n; j++) {
        if (i === j) {
          ACopy[k][j] = 0;
        } else {
          ACopy[k][j] += c * ACopy[i][j];
        }
      }
      BCopy[k] += c * BCopy[i];
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = BCopy[i];
    for (let j = i + 1; j < n; j++) {
      sum -= ACopy[i][j] * x[j];
    }
    x[i] = sum / ACopy[i][i];
  }
  if (x.some(value => !Number.isFinite(value))) throw new Error('Circuit solution is non-finite.');
  for (let row = 0; row < n; row++) {
    const terms = A[row].map((coefficient, col) => coefficient * x[col]);
    const residual = Math.abs(terms.reduce((sum, value) => sum + value, 0) - B[row]);
    const scale = Math.abs(B[row]) + terms.reduce((sum, value) => sum + Math.abs(value), 0);
    if (!Number.isFinite(residual) || residual > 1e-9 + 1e-8 * scale) throw new Error('Circuit solution failed its residual check.');
  }
  return x;
}

export function runSpiceSimulation(
  schematic: SchematicData,
  settings: SimSettings
): SimResult {
  const { components, wires } = schematic;
  const { stopTime, stepTime } = settings;
  if (settings.type !== 'transient') throw new Error('Only transient analysis is supported.');
  if (!Number.isFinite(stopTime) || !Number.isFinite(stepTime) || stopTime <= 0 || stepTime <= 0 || stepTime > stopTime) throw new Error('Stop and step times must be finite and positive, with step time no greater than stop time.');
  const maxSteps = Math.ceil(stopTime / stepTime);
  if (maxSteps > SIMULATION_LIMITS.maxSteps) throw new Error(`Use at most ${SIMULATION_LIMITS.maxSteps.toLocaleString()} time steps. Increase step time or reduce stop time.`);
  if (!components.length || !components.some(c => c.type === 'gnd')) throw new Error('Add components and a ground reference before simulation.');
  if (components.length > 256 || wires.length > 2048) throw new Error('Circuit exceeds the interactive solver size limit.');
  const requiredPins: Record<string, string[]> = {
    resistor: ['1', '2'], capacitor: ['1', '2'], inductor: ['1', '2'],
    voltage_source: ['p', 'n'], gnd: ['gnd'], diode: ['a', 'c'], led: ['a', 'c'],
    transistor_npn: ['b', 'c', 'e'], opamp: ['in+', 'in-', 'out', 'v+', 'v-'],
    timer555: ['1', '2', '3', '4', '5', '6', '7', '8'],
  };
  const seenIds = new Set<string>();
  components.forEach(comp => {
    if (seenIds.has(comp.id)) throw new Error(`Duplicate component ID: ${comp.id}.`);
    seenIds.add(comp.id);
    if (!requiredPins[comp.type] || requiredPins[comp.type].some(pin => !comp.pins.some(p => p.id === pin))) throw new Error(`${comp.id} has unsupported or missing pins.`);
    if (new Set(comp.pins.map(pin => pin.id)).size !== comp.pins.length) throw new Error(`${comp.id} has duplicate pins.`);
    if (['resistor', 'capacitor', 'inductor'].includes(comp.type)) {
      const value = parseValue(comp.value);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${comp.id} needs a finite, positive ${comp.type} value.`);
    }
  });

  // 1. Build Netlist via Union-Find
  const pinToParent: Record<string, string> = Object.create(null);
  const allPins: string[] = [];

  components.forEach(comp => {
    comp.pins.forEach(pin => {
      const pinKey = `${comp.id}:${pin.id}`;
      pinToParent[pinKey] = pinKey;
      allPins.push(pinKey);
    });
  });

  function find(pinKey: string): string {
    let root = pinKey;
    while (pinToParent[root] !== root) root = pinToParent[root];
    while (pinKey !== root) {
      const next = pinToParent[pinKey];
      pinToParent[pinKey] = root;
      pinKey = next;
    }
    return root;
  }

  function union(pinKey1: string, pinKey2: string) {
    const root1 = find(pinKey1);
    const root2 = find(pinKey2);
    if (root1 !== root2) {
      pinToParent[root1] = root2;
    }
  }

  // Union connected wires
  wires.forEach(wire => {
    const fromKey = `${wire.fromCompId}:${wire.fromPinId}`;
    const toKey = `${wire.toCompId}:${wire.toPinId}`;
    if (!(fromKey in pinToParent) || !(toKey in pinToParent)) throw new Error(`Wire ${wire.id} references a missing pin.`);
    union(fromKey, toKey);
  });

  // Collect nets
  const netGroups: Record<string, string[]> = {};
  allPins.forEach(pinKey => {
    const root = find(pinKey);
    if (!netGroups[root]) {
      netGroups[root] = [];
    }
    netGroups[root].push(pinKey);
  });

  // Assign Net names / Node indices
  // "0" is reserved for GND
  const pinToNet: Record<string, string> = {};
  let groundRoot: string | null = null;

  // Find ground node
  components.forEach(comp => {
    if (comp.type === 'gnd') {
      const gndPinKey = `${comp.id}:gnd`;
      groundRoot = find(gndPinKey);
    }
  });

  const netNameToIndex: Record<string, number> = {};
  let nodeCount = 0;

  if (groundRoot) {
    netNameToIndex['GND'] = 0;
    netGroups[groundRoot].forEach(pinKey => {
      pinToNet[pinKey] = 'GND';
    });
  }

  let autoNetIdx = 1;
  Object.keys(netGroups).forEach(root => {
    if (root === groundRoot) return;

    // Check if there is an explicit user label or name, otherwise auto-name
    // Let's check if there is a pin that belongs to a ground component but wasn't caught
    const pinsInGroup = netGroups[root];
    const isGnd = pinsInGroup.some(pk => pk.endsWith(':gnd'));
    
    let netName = '';
    if (isGnd) {
      netName = 'GND';
    } else {
      netName = `NET_${autoNetIdx++}`;
    }

    if (netName === 'GND') {
      netNameToIndex['GND'] = 0;
    } else {
      netNameToIndex[netName] = ++nodeCount;
    }

    pinsInGroup.forEach(pinKey => {
      pinToNet[pinKey] = netName;
    });
  });

  // Unconnected pins get dummy open nets
  allPins.forEach(pinKey => {
    if (!pinToNet[pinKey]) {
      const dummyNetName = `NC_${pinKey.replace(':', '_')}`;
      pinToNet[pinKey] = dummyNetName;
      netNameToIndex[dummyNetName] = ++nodeCount;
    }
  });

  // Map pin connections on components
  const compPinNet = (compId: string, pinId: string): string => {
    return pinToNet[`${compId}:${pinId}`] || 'GND';
  };

  const compPinNode = (compId: string, pinId: string): number => {
    const net = compPinNet(compId, pinId);
    return netNameToIndex[net] ?? 0;
  };

  // Determine active elements and voltage branches
  // Voltage branches are added for: voltage sources, op-amp outputs, 555 output
  let voltBranchCount = 0;
  const voltageSources: {
    compId: string;
    nodePos: number;
    nodeNeg: number;
    branchIdx: number;
    type: 'dc' | 'sin' | 'pulse';
    vValue: number;
    freq?: number;
    amplitude?: number;
  }[] = [];

  const opamps: {
    compId: string;
    nodeOut: number;
    nodeInPlus: number;
    nodeInMinus: number;
    nodeVcc: number;
    nodeVee: number;
    branchIdx: number;
  }[] = [];

  const timers: {
    compId: string;
    nodeGnd: number;
    nodeTrig: number;
    nodeOut: number;
    nodeReset: number;
    nodeCtrl: number;
    nodeThr: number;
    nodeDisch: number;
    nodeVcc: number;
    outBranchIdx: number;
    state: { flipflop: boolean }; // state across time steps
  }[] = [];

  components.forEach(comp => {
    if (comp.type === 'voltage_source') {
      const nodePos = compPinNode(comp.id, 'p');
      const nodeNeg = compPinNode(comp.id, 'n');
      const branchIdx = nodeCount + (++voltBranchCount);
      
      let vType: 'dc' | 'sin' | 'pulse' = 'dc';
      let freq = 0;
      let amp = 0;
      let dcVal = parseValue(comp.value);
      const waveform = comp.value.trim().match(/^(sin|pulse)\(([^)]+)\)$/i);
      if (waveform) {
        const parts = waveform[2].split(/[\s,]+/).filter(Boolean).map(parseValue);
        if (parts.length !== 3 || parts.some(v => !Number.isFinite(v)) || parts[2] <= 0) throw new Error(`${comp.id}: use sin(offset, amplitude, frequency) or pulse(low, high, frequency).`);
        vType = waveform[1].toLowerCase() as 'sin' | 'pulse';
        dcVal = parts[0];
        amp = vType === 'pulse' ? parts[1] - parts[0] : parts[1];
        freq = parts[2];
      } else if (!Number.isFinite(dcVal)) throw new Error(`${comp.id} has an invalid voltage or waveform.`);

      voltageSources.push({
        compId: comp.id,
        nodePos,
        nodeNeg,
        branchIdx,
        type: vType,
        vValue: dcVal,
        freq,
        amplitude: amp
      });
    } else if (comp.type === 'opamp') {
      const nodeOut = compPinNode(comp.id, 'out');
      const nodeInPlus = compPinNode(comp.id, 'in+');
      const nodeInMinus = compPinNode(comp.id, 'in-');
      const nodeVcc = compPinNode(comp.id, 'v+');
      const nodeVee = compPinNode(comp.id, 'v-');
      const branchIdx = nodeCount + (++voltBranchCount);
      opamps.push({
        compId: comp.id,
        nodeOut,
        nodeInPlus,
        nodeInMinus,
        nodeVcc,
        nodeVee,
        branchIdx
      });
    } else if (comp.type === 'timer555') {
      const nodeGnd = compPinNode(comp.id, '1');
      const nodeTrig = compPinNode(comp.id, '2');
      const nodeOut = compPinNode(comp.id, '3');
      const nodeReset = compPinNode(comp.id, '4');
      const nodeCtrl = compPinNode(comp.id, '5');
      const nodeThr = compPinNode(comp.id, '6');
      const nodeDisch = compPinNode(comp.id, '7');
      const nodeVcc = compPinNode(comp.id, '8');
      
      const outBranchIdx = nodeCount + (++voltBranchCount);

      timers.push({
        compId: comp.id,
        nodeGnd,
        nodeTrig,
        nodeOut,
        nodeReset,
        nodeCtrl,
        nodeThr,
        nodeDisch,
        nodeVcc,
        outBranchIdx,
        state: { flipflop: false } // Initial state: reset
      });
    }
  });

  const totalMatrixSize = nodeCount + voltBranchCount + 1; // 1-indexed for nodes + voltage branches + ground row (ground is index 0)
  
  // Simulation loop variables
  const nonlinear = components.some(c => ['diode', 'led', 'transistor_npn', 'opamp', 'timer555'].includes(c.type));
  const maxNrIterations = nonlinear ? 100 : 1;
  if (totalMatrixSize > SIMULATION_LIMITS.maxUnknowns || totalMatrixSize ** 3 * maxSteps * maxNrIterations > SIMULATION_LIMITS.maxWork) throw new Error('Circuit and time resolution exceed the interactive computation budget. Simplify the circuit or increase step time.');
  const timepoints: number[] = [];
  const nodes = Object.keys(netNameToIndex).sort((a, b) => netNameToIndex[a] - netNameToIndex[b]);

  const voltageHistory: Record<string, number[]> = {};
  nodes.forEach(n => {
    voltageHistory[n] = [];
  });

  const currentHistory: Record<string, number[]> = {};
  components.forEach(c => {
    if (c.type !== 'gnd') {
      currentHistory[c.id] = [];
    }
  });

  // Track state variables for capacitors/inductors (Companion models)
  // Capacitor: stores V_c(t_n-1) and I_c(t_n-1)
  // Inductor: stores I_l(t_n-1)
  const capStates: Record<string, { vc: number; ic: number }> = {};
  const indStates: Record<string, { il: number }> = {};

  components.forEach(comp => {
    if (comp.type === 'capacitor') {
      capStates[comp.id] = { vc: 0, ic: 0 };
    } else if (comp.type === 'inductor') {
      indStates[comp.id] = { il: 0 };
    }
  });

  // Iteration variables
  let t = 0;
  let previousX = new Array<number>(totalMatrixSize).fill(0);
  
  // Power accumulator
  const instPower: Record<string, number[]> = {};
  components.forEach(c => {
    instPower[c.id] = [];
  });

  // Helper: stamp resistance
  const stampResistor = (A: number[][], n1: number, n2: number, value: number) => {
    const g = 1.0 / value;
    if (n1 > 0) A[n1][n1] += g;
    if (n2 > 0) A[n2][n2] += g;
    if (n1 > 0 && n2 > 0) {
      A[n1][n2] -= g;
      A[n2][n1] -= g;
    }
  };

  // Helper: stamp voltage source
  const stampVoltageSource = (A: number[][], B: number[], n1: number, n2: number, branchIdx: number, val: number) => {
    if (n1 > 0) {
      A[n1][branchIdx] += 1;
      A[branchIdx][n1] += 1;
    }
    if (n2 > 0) {
      A[n2][branchIdx] -= 1;
      A[branchIdx][n2] -= 1;
    }
    B[branchIdx] += val;
  };

  // Helper: stamp current source
  const stampCurrentSource = (B: number[], n1: number, n2: number, val: number) => {
    if (n1 > 0) B[n1] -= val; // current flows OUT of n1
    if (n2 > 0) B[n2] += val; // current flows INTO n2
  };

  // Run transient simulation loop
  // Zero initial stored energy. First sample is at h, not mislabeled as t=0.
  for (let step = 1; step <= maxSteps; step++) {
    t = Math.min(step * stepTime, stopTime);
    const dt = t - (timepoints.at(-1) ?? 0);
    if (dt <= 0) break;
    timepoints.push(t);

    let xVector: number[] = new Array(totalMatrixSize).fill(0);
    let converged = false;
    let nrIteration = 0;

    // Last iteration values for convergence check
    let lastX = [...previousX];

    // Dynamic 555 state updates at the start of time step based on voltages at previous step
    timers.forEach(tmr => {
      // Get previous step voltages
      const getPrevVolt = (node: number) => {
        if (node === 0) return 0;
        const netName = nodes.find(name => netNameToIndex[name] === node);
        if (!netName) return 0;
        const hist = voltageHistory[netName];
        return hist.length > 0 ? hist[hist.length - 1] : 0;
      };

      const vVcc = getPrevVolt(tmr.nodeVcc);
      const vTrig = getPrevVolt(tmr.nodeTrig);
      const vThr = getPrevVolt(tmr.nodeThr);
      const vReset = getPrevVolt(tmr.nodeReset);
      
      const vcc = vVcc;
      
      // Control voltage (pin 5) defaults to 2/3 VCC if not connected
      const vCtrl = tmr.nodeCtrl > 0 ? getPrevVolt(tmr.nodeCtrl) : (2.0 / 3.0) * vcc;
      const trigThreshold = vCtrl / 2.0;

      // 555 Logic
      if (vcc < 0.8 || vReset < 0.8) {
        tmr.state.flipflop = false; // Reset active
      } else {
        if (vTrig < trigThreshold) {
          tmr.state.flipflop = true; // Trigger sets flip-flop
        } else if (vThr > vCtrl) {
          tmr.state.flipflop = false; // Threshold resets flip-flop
        }
      }
    });

    while (!converged && nrIteration < maxNrIterations) {
      // Create empty matrix & right-hand side vector
      const A: number[][] = Array(totalMatrixSize).fill(0).map(() => new Array(totalMatrixSize).fill(0));
      const B: number[] = new Array(totalMatrixSize).fill(0);

      // Force ground node (0) to 0V
      A[0][0] = 1;
      B[0] = 0;

      // Stamp components
      components.forEach(comp => {
        const node1 = compPinNode(comp.id, '1') || compPinNode(comp.id, 'p') || compPinNode(comp.id, 'a');
        const node2 = compPinNode(comp.id, '2') || compPinNode(comp.id, 'n') || compPinNode(comp.id, 'c');
        const val = parseValue(comp.value);

        if (comp.type === 'resistor') {
          stampResistor(A, node1, node2, val || 1);
        } else if (comp.type === 'capacitor') {
          // Backward Euler companion model:
          // G_eq = C / h
          // I_eq = - (C / h) * V_c(t_n-1)
          const c = val;
          const geq = c / dt;
          const state = capStates[comp.id];
          const ieq = geq * state.vc;
          stampResistor(A, node1, node2, 1 / geq);
          stampCurrentSource(B, node1, node2, -ieq);
        } else if (comp.type === 'inductor') {
          // Backward Euler companion model:
          // G_eq = h / L
          // I_eq = I_l(t_n-1)
          const l = val;
          const geq = dt / l;
          const state = indStates[comp.id];
          const ieq = state.il;
          stampResistor(A, node1, node2, 1 / geq);
          stampCurrentSource(B, node1, node2, ieq);
        } else if (comp.type === 'diode' || comp.type === 'led') {
          const vd = lastX[node1] - lastX[node2];
          const model = junction(vd, comp.type === 'led');
          stampResistor(A, node1, node2, 1 / model.conductance);
          stampCurrentSource(B, node1, node2, model.current - model.conductance * vd);
        } else if (comp.type === 'transistor_npn') {
          // NPN BJT Simplified Ebers-Moll / Gummel-Poon
          // Pins: Collector (c), Base (b), Emitter (e)
          const nc = compPinNode(comp.id, 'c');
          const nb = compPinNode(comp.id, 'b');
          const ne = compPinNode(comp.id, 'e');

          const beta = 100;
          const vbe = lastX[nb] - lastX[ne];
          const model = junction(vbe);
          const gbe = model.conductance;
          const ibeEq = model.current - gbe * vbe;
          stampResistor(A, nb, ne, 1 / gbe);
          stampCurrentSource(B, nb, ne, ibeEq);

          // Collector-Emitter active current source: Ic = beta * Ib = beta * (Vbe * gbe + ibeEq)
          // We stamp a transconductance: gm = beta * gbe
          // Current flows from C to E, proportional to Vbe = Vb - Ve
          const gm = beta * gbe;
          if (nc > 0) {
            A[nc][nb] += gm;
            A[nc][ne] -= gm;
          }
          if (ne > 0) {
            A[ne][nb] -= gm;
            A[ne][ne] += gm;
          }
          // And add companion current source: beta * ibeEq from C to E
          stampCurrentSource(B, nc, ne, beta * ibeEq);

          // Minor leakage resistance to collector-base
          stampResistor(A, nc, nb, 1e7);
        }
      });

      // Stamp independent Voltage Sources
      voltageSources.forEach(src => {
        let vVal = src.vValue;
        if (src.type === 'sin') {
          vVal = src.vValue + (src.amplitude ?? 0) * Math.sin(2 * Math.PI * (src.freq ?? 0) * t);
        } else if (src.type === 'pulse') {
          // Square wave: 50% duty cycle
          const period = 1.0 / (src.freq ?? 1);
          const phase = t % period;
          vVal = phase < period / 2 ? src.vValue + (src.amplitude ?? 0) : src.vValue;
        }
        stampVoltageSource(A, B, src.nodePos, src.nodeNeg, src.branchIdx, vVal);
      });

      // Stamp Op-Amps
      // Ideal op-amp model: Out = In+ - In- times Gain
      // Stamped as: V_out - V_in+ * Gain + V_in- * Gain = 0
      // Clamped output: If V_out exceeds rails, we model it as a fixed voltage source driven to rail.
      opamps.forEach(op => {
        const gain = 1e5;
        const vcc = lastX[op.nodeVcc];
        const vee = lastX[op.nodeVee];
        const desiredOut = gain * (lastX[op.nodeInPlus] - lastX[op.nodeInMinus]);
        stampVoltageSource(A, B, op.nodeOut, 0, op.branchIdx, 0);
        if (desiredOut > Math.max(vcc, vee)) A[op.branchIdx][op.nodeVcc] -= 1;
        else if (desiredOut < vee) A[op.branchIdx][op.nodeVee] -= 1;
        else {
          A[op.branchIdx][op.nodeInPlus] -= gain;
          A[op.branchIdx][op.nodeInMinus] += gain;
        }
      });

      // Stamp 555 Timers behaviorally
      timers.forEach(tmr => {
        stampVoltageSource(A, B, tmr.nodeOut, tmr.nodeGnd, tmr.outBranchIdx, 0);
        if (tmr.state.flipflop) {
          A[tmr.outBranchIdx][tmr.nodeVcc] -= 1;
          A[tmr.outBranchIdx][tmr.nodeGnd] += 1;
        }
        stampResistor(A, tmr.nodeDisch, tmr.nodeGnd, tmr.state.flipflop ? 1e7 : 10);
        // Internal resistor divider supplies control pin 5 at nominal 2/3 VCC.
        stampResistor(A, tmr.nodeVcc, tmr.nodeCtrl, 5000);
        stampResistor(A, tmr.nodeCtrl, tmr.nodeGnd, 10000);
      });

      // Solve matrix A * xVector = B
      xVector = solveMatrix(A, B);

      if (!nonlinear) { converged = true; break; }
      // Limit junction voltage changes, rather than clamp the final device model.
      let damping = 1;
      components.forEach(comp => {
        const pins = comp.type === 'diode' || comp.type === 'led' ? ['a', 'c'] : comp.type === 'transistor_npn' ? ['b', 'e'] : null;
        if (!pins) return;
        const p = compPinNode(comp.id, pins[0]);
        const n = compPinNode(comp.id, pins[1]);
        const change = Math.abs(xVector[p] - xVector[n] - lastX[p] + lastX[n]);
        if (change > 0.15) damping = Math.min(damping, 0.15 / change);
      });
      converged = damping === 1 && xVector.every((value, i) => Math.abs(value - lastX[i]) <= (i <= nodeCount ? 1e-7 : 1e-10) + 1e-6 * Math.max(Math.abs(value), Math.abs(lastX[i])));
      lastX = xVector.map((value, i) => lastX[i] + damping * (value - lastX[i]));
      nrIteration++;
    }
    if (!converged) throw new Error(`Nonlinear solver did not converge at ${t.toExponential(3)} s. Reduce the step time or simplify the circuit.`);
    previousX = xVector;

    // Save node voltages
    nodes.forEach(nodeName => {
      const idx = netNameToIndex[nodeName];
      const volt = xVector[idx] || 0;
      voltageHistory[nodeName].push(volt);
    });

    // Update state variables (Vc and Il) for next step
    components.forEach(comp => {
      if (comp.type === 'gnd') {
        instPower[comp.id].push(0);
        return;
      }

      const node1 = compPinNode(comp.id, '1') || compPinNode(comp.id, 'p') || compPinNode(comp.id, 'a');
      const node2 = compPinNode(comp.id, '2') || compPinNode(comp.id, 'n') || compPinNode(comp.id, 'c');
      const val = parseValue(comp.value);

      const v1 = xVector[node1] || 0;
      const v2 = xVector[node2] || 0;
      const vDiff = v1 - v2;

      let current = 0;

      if (comp.type === 'resistor') {
        current = vDiff / (val || 1);
      } else if (comp.type === 'capacitor') {
        const c = val;
        const geq = c / dt;
        const state = capStates[comp.id];
        // I_c(t_n) = (C/h) * (V_c(t_n) - V_c(t_n-1))
        current = geq * (vDiff - state.vc);
        state.vc = vDiff;
        state.ic = current;
      } else if (comp.type === 'inductor') {
        const l = val;
        const geq = dt / l;
        const state = indStates[comp.id];
        // I_l(t_n) = I_l(t_n-1) + (h/L) * V_l(t_n)
        current = state.il + geq * vDiff;
        state.il = current;
      } else if (comp.type === 'voltage_source') {
        const src = voltageSources.find(s => s.compId === comp.id);
        if (src) {
          // Current is the branch current
          current = xVector[src.branchIdx] || 0;
        }
      } else if (comp.type === 'diode' || comp.type === 'led') {
        current = junction(vDiff, comp.type === 'led').current;
      } else if (comp.type === 'transistor_npn') {
        // Approximate collector current
        const nb = compPinNode(comp.id, 'b');
        const ne = compPinNode(comp.id, 'e');
        const vbe = (xVector[nb] || 0) - (xVector[ne] || 0);
        const nc = compPinNode(comp.id, 'c');
        current = 100 * junction(vbe).current + (xVector[nc] - xVector[nb]) / 1e7;
      } else if (comp.type === 'opamp') {
        const op = opamps.find(o => o.compId === comp.id);
        if (op) {
          current = xVector[op.branchIdx] || 0;
        }
      } else if (comp.type === 'timer555') {
        const tmr = timers.find(t => t.compId === comp.id);
        if (tmr) {
          current = xVector[tmr.outBranchIdx] || 0;
        }
      }

      currentHistory[comp.id].push(current);
      
      // Ideal reactive parts and sources have no modeled heat loss. Behavioral IC
      // internal losses are unknown; zero here does not certify zero real heating.
      let power = 0;
      if (comp.type === 'resistor' || comp.type === 'diode' || comp.type === 'led') power = Math.max(0, vDiff * current);
      if (comp.type === 'transistor_npn') {
        const vb = xVector[compPinNode(comp.id, 'b')];
        const vc = xVector[compPinNode(comp.id, 'c')];
        const ve = xVector[compPinNode(comp.id, 'e')];
        const ib = junction(vb - ve).current + (vb - vc) / 1e7;
        power = Math.max(0, (vc - ve) * current + (vb - ve) * ib);
      }
      if (!Number.isFinite(current) || !Number.isFinite(power)) throw new Error(`${comp.id} produced non-finite current or power.`);
      instPower[comp.id].push(power * dt);
    });
  }

  // Calculate average power dissipation per component
  const powerDissipation: Record<string, number> = {};
  components.forEach(comp => {
    if (comp.type === 'gnd') {
      powerDissipation[comp.id] = 0;
    } else {
      const powArr = instPower[comp.id];
      const avg = powArr.reduce((sum, energy) => sum + energy, 0) / stopTime;
      powerDissipation[comp.id] = avg;
    }
  });

  return {
    timepoints,
    nodes,
    voltages: voltageHistory,
    currents: currentHistory,
    powerDissipation
  };
}