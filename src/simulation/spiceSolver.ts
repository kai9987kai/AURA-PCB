import type { SchematicData, SimResult, SimSettings } from '../types/pcb';

// Helper for parsing component values, e.g., "10k" -> 10000, "100n" -> 1e-7
export function parseValue(valStr: string): number {
  if (!valStr) return 0;
  const match = valStr.trim().match(/^([0-9.-]+)\s*([a-zA-Zμ]*)$/);
  if (!match) return parseFloat(valStr) || 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  
  switch (unit) {
    case 'p': return num * 1e-12;
    case 'n': return num * 1e-9;
    case 'u':
    case 'μ': return num * 1e-6;
    case 'm': return num * 1e-3;
    case 'k': return num * 1e3;
    case 'meg':
    case 'mavg': return num * 1e6;
    case 'g': return num * 1e9;
    default: return num;
  }
}

// Simple Gaussian elimination with partial pivoting to solve A * x = B
function solveMatrix(A: number[][], B: number[]): number[] {
  const n = B.length;
  const ACopy = A.map(row => [...row]);
  const BCopy = [...B];

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

    if (Math.abs(ACopy[i][i]) < 1e-20) {
      // Singular matrix, add small offset to diagonal for stability
      ACopy[i][i] = 1e-20;
    }

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
  return x;
}

export function runSpiceSimulation(
  schematic: SchematicData,
  settings: SimSettings
): SimResult {
  const { components, wires } = schematic;

  // 1. Build Netlist via Union-Find
  const pinToParent: Record<string, string> = {};
  const allPins: string[] = [];

  components.forEach(comp => {
    comp.pins.forEach(pin => {
      const pinKey = `${comp.id}:${pin.id}`;
      pinToParent[pinKey] = pinKey;
      allPins.push(pinKey);
    });
  });

  function find(pinKey: string): string {
    if (!pinToParent[pinKey]) return pinKey;
    if (pinToParent[pinKey] === pinKey) return pinKey;
    pinToParent[pinKey] = find(pinToParent[pinKey]);
    return pinToParent[pinKey];
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
    dischBranchIdx: number;
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
      
      // Parse parameters if sin or pulse
      if (comp.value.toLowerCase().includes('sin')) {
        vType = 'sin';
        const match = comp.value.match(/sin\(([^)]+)\)/i);
        if (match) {
          const parts = match[1].split(',').map(p => parseValue(p.trim()));
          dcVal = parts[0] || 0; // offset
          amp = parts[1] || 1;  // amplitude
          freq = parts[2] || 1000; // frequency
        }
      } else if (comp.value.toLowerCase().includes('pulse')) {
        vType = 'pulse';
        // Simple pulse parsing or defaults
        amp = 5;
        freq = 1000;
      }

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
      const dischBranchIdx = nodeCount + (++voltBranchCount);

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
        dischBranchIdx,
        state: { flipflop: false } // Initial state: reset
      });
    }
  });

  const totalMatrixSize = nodeCount + voltBranchCount + 1; // 1-indexed for nodes + voltage branches + ground row (ground is index 0)
  
  // Simulation loop variables
  const stopTime = settings.stopTime || 0.02;
  const stepTime = settings.stepTime || 5e-5;
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
  const maxSteps = Math.ceil(stopTime / stepTime);
  for (let step = 0; step <= maxSteps; step++) {
    t = step * stepTime;
    timepoints.push(t);

    let xVector: number[] = new Array(totalMatrixSize).fill(0);
    let converged = false;
    let nrIteration = 0;
    const maxNrIterations = 40;

    // Last iteration values for convergence check
    let lastX: number[] = new Array(totalMatrixSize).fill(0);

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
      
      const vcc = vVcc > 0.5 ? vVcc : 5.0; // default VCC if unpowered
      
      // Control voltage (pin 5) defaults to 2/3 VCC if not connected
      const vCtrl = tmr.nodeCtrl > 0 ? getPrevVolt(tmr.nodeCtrl) : (2.0 / 3.0) * vcc;
      const trigThreshold = vCtrl / 2.0;

      // 555 Logic
      if (vReset < 0.8 && tmr.nodeReset > 0) {
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
          const c = val || 1e-6;
          const geq = c / stepTime;
          const state = capStates[comp.id];
          const ieq = geq * state.vc;
          stampResistor(A, node1, node2, 1 / geq);
          stampCurrentSource(B, node1, node2, ieq);
        } else if (comp.type === 'inductor') {
          // Backward Euler companion model:
          // G_eq = h / L
          // I_eq = I_l(t_n-1)
          const l = val || 1e-3;
          const geq = stepTime / l;
          const state = indStates[comp.id];
          const ieq = state.il;
          stampResistor(A, node1, node2, 1 / geq);
          stampCurrentSource(B, node1, node2, ieq);
        } else if (comp.type === 'diode' || comp.type === 'led') {
          // Newton-Raphson stamp for Diode:
          // I_d = I_s * (exp(V_d/V_t) - 1)
          // At iteration k: V_d^k = V(node1) - V(node2) from last iteration
          const Is = comp.type === 'led' ? 1e-18 : 1e-14;
          const Vt = 0.026 * (comp.type === 'led' ? 2.0 : 1.0); // larger Vt for LED to match forward drop
          
          const v1Last = lastX[node1];
          const v2Last = lastX[node2];
          let vdLast = v1Last - v2Last;

          // Limit diode voltage steps to prevent exponential overflow
          if (vdLast > 0.8) vdLast = 0.8;
          if (vdLast < -2.0) vdLast = -2.0;

          const expVal = Math.exp(vdLast / Vt);
          const gd = (Is / Vt) * expVal;
          const id = Is * (expVal - 1);
          const ieq = id - gd * vdLast;

          stampResistor(A, node1, node2, 1 / (gd + 1e-12)); // Add minor conductance for convergence
          stampCurrentSource(B, node1, node2, -ieq); // current source in parallel
        } else if (comp.type === 'transistor_npn') {
          // NPN BJT Simplified Ebers-Moll / Gummel-Poon
          // Pins: Collector (c), Base (b), Emitter (e)
          const nc = compPinNode(comp.id, 'c');
          const nb = compPinNode(comp.id, 'b');
          const ne = compPinNode(comp.id, 'e');

          const Is = 1e-14;
          const Vt = 0.026;
          const beta = 100;

          // Vbe
          const vbe = lastX[nb] - lastX[ne];

          // Clamp
          const vbeClamped = Math.min(0.8, Math.max(-5.0, vbe));

          const expBe = Math.exp(vbeClamped / Vt);

          // Diode currents
          const ibe = Is * (expBe - 1);

          // Linearized conductances
          const gbe = (Is / Vt) * expBe;

          // Current generators
          // Ib = ibe/beta_f + ibc/beta_r
          // Ic = ibe - ibc - ibc/beta_r
          // Stamp linearized components:
          // We represent base-emitter as diode (gbe, ibe - gbe*vbe)
          // base-collector as diode (gbc, ibc - gbc*vbc)
          // And dependent current source: I_c_dependent = beta * I_base_emitter
          // To keep it simple and highly stable for simulation:
          // Base-emitter: stamp gbe between base and emitter. Companion current source: I_be_eq = ibe - gbe * vbe
          const ibeEq = ibe - gbe * vbeClamped;
          stampResistor(A, nb, ne, 1 / (gbe + 1e-12));
          stampCurrentSource(B, nb, ne, -ibeEq);

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
          stampCurrentSource(B, nc, ne, -beta * ibeEq);

          // Minor leakage resistance to collector-base
          stampResistor(A, nc, nb, 1e7);
        }
      });

      // Stamp independent Voltage Sources
      voltageSources.forEach(src => {
        let vVal = src.vValue;
        if (src.type === 'sin' && src.freq && src.amplitude) {
          vVal = src.vValue + src.amplitude * Math.sin(2 * Math.PI * src.freq * t);
        } else if (src.type === 'pulse' && src.freq && src.amplitude) {
          // Square wave: 50% duty cycle
          const period = 1.0 / src.freq;
          const phase = t % period;
          vVal = phase < period / 2 ? src.vValue + src.amplitude : src.vValue;
        }
        stampVoltageSource(A, B, src.nodePos, src.nodeNeg, src.branchIdx, vVal);
      });

      // Stamp Op-Amps
      // Ideal op-amp model: Out = In+ - In- times Gain
      // Stamped as: V_out - V_in+ * Gain + V_in- * Gain = 0
      // Clamped output: If V_out exceeds rails, we model it as a fixed voltage source driven to rail.
      opamps.forEach(op => {
        const gain = 1e5;
        const vcc = op.nodeVcc > 0 ? lastX[op.nodeVcc] : 15.0;
        const vee = op.nodeVee > 0 ? lastX[op.nodeVee] : -15.0;

        const vinPlus = lastX[op.nodeInPlus];
        const vinMinus = lastX[op.nodeInMinus];

        const desiredOut = gain * (vinPlus - vinMinus);
        
        if (desiredOut > vcc - 0.5) {
          // Clamp to VCC
          stampVoltageSource(A, B, op.nodeOut, 0, op.branchIdx, vcc - 1.0);
        } else if (desiredOut < vee + 0.5) {
          // Clamp to VEE
          stampVoltageSource(A, B, op.nodeOut, 0, op.branchIdx, vee + 1.0);
        } else {
          // Linear range equation: V_out - Gain*(V_in+ - V_in-) = 0
          // Stamp branch equations:
          // A[branchIdx][nodeOut] = 1
          // A[branchIdx][nodeIn+] = -Gain
          // A[branchIdx][nodeIn-] = +Gain
          // In Out node, current enters from opamp output branch
          A[op.branchIdx][op.nodeOut] += 1;
          A[op.nodeOut][op.branchIdx] += 1;

          A[op.branchIdx][op.nodeInPlus] -= gain;
          A[op.branchIdx][op.nodeInMinus] += gain;

          B[op.branchIdx] = 0;
        }
      });

      // Stamp 555 Timers behaviorally
      timers.forEach(tmr => {
        const vcc = tmr.nodeVcc > 0 ? lastX[tmr.nodeVcc] : 5.0;
        
        // Output Branch: pin 3 driven to VCC (if set) or GND (if reset)
        const voutTarget = tmr.state.flipflop ? (vcc - 0.7) : 0.1;
        stampVoltageSource(A, B, tmr.nodeOut, tmr.nodeGnd, tmr.outBranchIdx, voutTarget);

        // Discharge Branch: pin 7 connected to GND via 10 Ohm resistor (if reset), or open-circuit (if set)
        if (tmr.state.flipflop) {
          // Open: high resistance to GND
          stampResistor(A, tmr.nodeDisch, tmr.nodeGnd, 1e7);
          // Fixed 0V dummy branch for MNA stability
          stampVoltageSource(A, B, 0, 0, tmr.dischBranchIdx, 0);
        } else {
          // Connected: low resistance to GND (10 Ohms)
          stampResistor(A, tmr.nodeDisch, tmr.nodeGnd, 10);
          stampVoltageSource(A, B, tmr.nodeDisch, tmr.nodeGnd, tmr.dischBranchIdx, 0.1);
        }
      });

      // Solve matrix A * xVector = B
      xVector = solveMatrix(A, B);

      // Check convergence for NR
      let maxDiff = 0;
      for (let i = 0; i < totalMatrixSize; i++) {
        const diff = Math.abs(xVector[i] - lastX[i]);
        if (diff > maxDiff) maxDiff = diff;
      }

      if (maxDiff < 1e-4 || nrIteration > maxNrIterations - 2) {
        converged = true;
      }

      lastX = [...xVector];
      nrIteration++;
    }

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
        const c = val || 1e-6;
        const geq = c / stepTime;
        const state = capStates[comp.id];
        // I_c(t_n) = (C/h) * (V_c(t_n) - V_c(t_n-1))
        current = geq * (vDiff - state.vc);
        state.vc = vDiff;
        state.ic = current;
      } else if (comp.type === 'inductor') {
        const l = val || 1e-3;
        const geq = stepTime / l;
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
        const Is = comp.type === 'led' ? 1e-18 : 1e-14;
        const Vt = 0.026 * (comp.type === 'led' ? 2.0 : 1.0);
        current = Is * (Math.exp(vDiff / Vt) - 1);
      } else if (comp.type === 'transistor_npn') {
        // Approximate collector current
        const nb = compPinNode(comp.id, 'b');
        const ne = compPinNode(comp.id, 'e');
        const vbe = (xVector[nb] || 0) - (xVector[ne] || 0);
        const Is = 1e-14;
        const Vt = 0.026;
        const beta = 100;
        const ibe = Is * (Math.exp(Math.min(0.8, vbe) / Vt) - 1);
        current = beta * ibe; // approximate C-E current
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
      
      // Calculate instantaneous power P = V * I
      instPower[comp.id].push(Math.abs(vDiff * current));
    });
  }

  // Calculate average power dissipation per component
  const powerDissipation: Record<string, number> = {};
  components.forEach(comp => {
    if (comp.type === 'gnd') {
      powerDissipation[comp.id] = 0;
    } else {
      const powArr = instPower[comp.id];
      const avg = powArr.reduce((sum, p) => sum + p, 0) / powArr.length;
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
