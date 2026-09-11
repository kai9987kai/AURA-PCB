import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeBoard, BOARD_RULES } from '../src/analysis/boardChecks.ts';
import { buildGerberLayers } from '../src/export/gerber.ts';
import { hasReferencePlane } from '../src/simulation/signalIntegrity.ts';
import { computeConductivityGrid, createThermalGrid, solveThermalStep } from '../src/simulation/thermalSolver.ts';
import { parseProject, serializeProject } from '../src/project/projectFile.ts';
import type { CopperPour, PCBFootprint, PCBLayoutData, PCBTrace } from '../src/types/pcb.ts';

const HEIGHT = 20;
const pour = (overrides: Partial<CopperPour> = {}): CopperPour =>
  ({ id: 'pour1', net: 'GND', layer: 'top', margin: 0.5, clearance: 0.3, ...overrides });

const pad = (id: string, x: number, y: number, net: string, holeDiameter = 0.8): PCBFootprint => ({
  id, componentId: id, type: 'resistor', x, y, rotation: 0, width: 4, height: 2, isPlaced: true,
  pads: [{ id: '1', relX: 0, relY: 0, diameter: 1.6, holeDiameter, net }],
});
const board = (overrides: Partial<PCBLayoutData> = {}): PCBLayoutData => ({
  boardWidth: 40, boardHeight: HEIGHT, footprints: [], traces: [], vias: [], pours: [], ...overrides,
});
/** Two same-net pads with no copper between them: unroutable until something joins them. */
const twoGrounds = (overrides: Partial<PCBLayoutData> = {}) =>
  board({ footprints: [pad('G1', 10, 10, 'GND'), pad('G2', 30, 10, 'GND')], ...overrides });

const topCopper = (layout: PCBLayoutData) => {
  const layer = buildGerberLayers(layout).find(candidate => candidate.id === 'topCopper');
  assert.ok(layer);
  return layer.contents;
};
const gndNet = (layout: PCBLayoutData) => {
  const net = analyzeBoard(layout).nets.find(candidate => candidate.net === 'GND');
  assert.ok(net, 'expected a GND net');
  return net;
};

test('a pour connects same-net pads that no trace ever joined', () => {
  assert.equal(gndNet(twoGrounds()).connectedGroups, 2, 'precondition: bare pads are two groups');
  assert.equal(analyzeBoard(twoGrounds()).routingCompletion, 0);

  const flooded = twoGrounds({ pours: [pour()] });
  assert.equal(gndNet(flooded).connectedGroups, 1);
  assert.equal(gndNet(flooded).fullyRouted, true);
  assert.equal(analyzeBoard(flooded).routingCompletion, 100);
});

test('a pour joins only its own net', () => {
  const mixed = board({
    footprints: [pad('G1', 10, 10, 'GND'), pad('G2', 30, 10, 'GND'), pad('S1', 20, 5, 'SIG'), pad('S2', 20, 15, 'SIG')],
    pours: [pour()],
  });
  const nets = analyzeBoard(mixed).nets;
  assert.equal(nets.find(net => net.net === 'GND')?.connectedGroups, 1);
  assert.equal(nets.find(net => net.net === 'SIG')?.connectedGroups, 2, 'a foreign net is cleared, not connected');
});

test('a pour reaches only copper that shares its layer', () => {
  // Surface-mount pads exist on the top layer alone, so a bottom flood cannot touch them.
  const surfaceMount = board({
    footprints: [pad('G1', 10, 10, 'GND', 0), pad('G2', 30, 10, 'GND', 0)],
    pours: [pour({ layer: 'bottom' })],
  });
  assert.equal(gndNet(surfaceMount).connectedGroups, 2);
  // The same pads with drilled holes are plated through and the bottom flood does reach them.
  const plated = board({
    footprints: [pad('G1', 10, 10, 'GND'), pad('G2', 30, 10, 'GND')],
    pours: [pour({ layer: 'bottom' })],
  });
  assert.equal(gndNet(plated).connectedGroups, 1);
});

test('copper outside the flood region is not swallowed by it', () => {
  // Region 6..34 by 6..14; both pads sit in the corners outside it.
  const corners = board({
    footprints: [pad('G1', 3, 3, 'GND'), pad('G2', 37, 17, 'GND')],
    pours: [pour({ margin: 6 })],
  });
  assert.equal(gndNet(corners).connectedGroups, 2);
  // Widen the flood until it reaches them and the same two pads become one group.
  const reaching = board({ footprints: corners.footprints, pours: [pour({ margin: 1 })] });
  assert.equal(gndNet(reaching).connectedGroups, 1);
});

test('a flood that touches none of its net is reported as isolated copper', () => {
  const orphan = analyzeBoard(twoGrounds({ pours: [pour({ net: 'NOWHERE' })] }));
  assert.ok(orphan.issues.some(issue => issue.message.includes('Floating pour')), orphan.issues.map(i => i.message).join(' | '));
});

test('a flood that crowds the board edge is a fabrication finding', () => {
  const tight = analyzeBoard(twoGrounds({ pours: [pour({ margin: BOARD_RULES.edgeClearance / 2 })] }));
  assert.ok(tight.issues.some(issue => issue.kind === 'edge' && issue.message.includes('Pour')),
    tight.issues.map(i => i.message).join(' | '));
  // A flood whose margin consumes the whole board has no copper to contribute.
  const inverted = analyzeBoard(twoGrounds({ pours: [pour({ margin: 30 })] }));
  assert.ok(inverted.issues.some(issue => issue.kind === 'invalid' && issue.message.includes('no copper')));
});

test('the exported plane is a filled region reflected like every other layer', () => {
  const gerber = topCopper(twoGrounds({ pours: [pour()] }));
  const region = /G36\*\n([\s\S]*?)G37\*/.exec(gerber);
  assert.ok(region, 'the flood must be a filled contour');
  const corners = [...region[1].matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map(([, x, y]) => [Number(x) / 1e6, Number(y) / 1e6]);
  // Model region is 0.5..39.5 by 0.5..19.5; Y is reflected about the 20mm board height.
  assert.deepEqual(corners, [[0.5, 19.5], [39.5, 19.5], [39.5, 0.5], [0.5, 0.5], [0.5, 19.5]]);
});

test('the plane clears foreign copper and merges with its own net', () => {
  const layout = board({
    footprints: [pad('G1', 10, 10, 'GND'), pad('S1', 20, 5, 'SIG')],
    pours: [pour()],
  });
  const gerber = topCopper(layout);
  const cleared = /%LPC\*%\n([\s\S]*?)%LPD\*%/.exec(gerber);
  assert.ok(cleared, 'clearances must be punched in clear polarity');

  // 1.6mm pad plus 0.3mm clearance per side is a 2.2mm hole in the plane.
  assert.match(gerber, /%ADD\d+C,2\.200000\*%/);
  const punches = [...cleared[1].matchAll(/X(-?\d+)Y(-?\d+)D03\*/g)].map(([, x, y]) => [Number(x) / 1e6, Number(y) / 1e6]);
  assert.deepEqual(punches, [[20, HEIGHT - 5]], 'only the foreign pad is cleared');
  assert.ok(gerber.trimEnd().endsWith('M02*'));
  // Polarity must be back to dark before the copper itself is drawn, or the board inverts.
  assert.equal(gerber.lastIndexOf('%LPD*%') > gerber.lastIndexOf('%LPC*%'), true);
});

test('a board without a pour exports no plane at all', () => {
  const gerber = topCopper(twoGrounds());
  assert.doesNotMatch(gerber, /G36\*/);
  assert.doesNotMatch(gerber, /%LPC\*%/);
});

test('a trace has a reference plane only when copper floods the other side', () => {
  const top: Pick<PCBTrace, 'layer'> = { layer: 'top' };
  assert.equal(hasReferencePlane(top, []), false);
  assert.equal(hasReferencePlane(top, [pour({ layer: 'top' })]), false, 'a flood on its own layer is not a reference');
  assert.equal(hasReferencePlane(top, [pour({ layer: 'bottom' })]), true);
});

test('a pour survives a save and reload, and two on one layer are refused', () => {
  const project = {
    name: 'plane', schematic: { components: [], wires: [] },
    pcbLayout: twoGrounds({ footprints: [], pours: [pour(), pour({ id: 'pour2', layer: 'bottom' })] }),
  };
  const reloaded = parseProject(serializeProject(project));
  assert.deepEqual(reloaded.pcbLayout.pours, project.pcbLayout.pours);

  const shorted = { ...project, pcbLayout: twoGrounds({ footprints: [], pours: [pour(), pour({ id: 'pour2' })] }) };
  assert.throws(() => parseProject(serializeProject(shorted)), /one pour per layer/);
});

test('a document written before pours existed still loads', () => {
  const legacy = JSON.stringify({
    format: 'aura-pcb', version: 1,
    project: {
      name: 'legacy', schematic: { components: [], wires: [] },
      pcbLayout: { boardWidth: 40, boardHeight: 20, footprints: [], traces: [], vias: [] },
    },
  });
  assert.deepEqual(parseProject(legacy).pcbLayout.pours, []);
});

test('a pour with impossible clearance is refused rather than exported', () => {
  const project = {
    name: 'bad', schematic: { components: [], wires: [] },
    pcbLayout: twoGrounds({ footprints: [], pours: [pour({ clearance: 0 })] }),
  };
  assert.throws(() => parseProject(serializeProject(project)), /pour clearance/);
});

test('a ground plane spreads heat that bare substrate concentrates', () => {
  const layout = twoGrounds({ pours: [pour()] });
  const cell = 1.5;
  const conductivity = computeConductivityGrid(layout, Math.ceil(40 / cell), Math.ceil(HEIGHT / cell), cell);
  // Inside the flood is copper; the margin band at the very edge is still substrate.
  assert.equal(conductivity[Math.ceil(40 / cell) * 6 + 13], 390);
  // Float32 cannot hold 0.3 exactly, so compare against the substrate value with tolerance.
  const bareCell = computeConductivityGrid(twoGrounds(), Math.ceil(40 / cell), Math.ceil(HEIGHT / cell), cell)[Math.ceil(40 / cell) * 6 + 13];
  assert.ok(Math.abs(bareCell - 0.3) < 1e-6, `bare substrate should stay FR4, got ${bareCell}`);

  const peak = (grid: Float32Array) => {
    let state = createThermalGrid(40, HEIGHT, cell);
    for (let step = 0; step < 40; step++) {
      state = solveThermalStep(state, grid, [{ x: 20, y: 10, power: 1, radius: 2 }], 25, 15);
    }
    return Math.max(...state.temperatures);
  };
  const bare = peak(computeConductivityGrid(twoGrounds(), Math.ceil(40 / cell), Math.ceil(HEIGHT / cell), cell));
  const planed = peak(conductivity);
  assert.ok(planed < bare, `a plane must lower the hot spot: plane ${planed.toFixed(1)}C vs bare ${bare.toFixed(1)}C`);
  assert.ok(planed > 25, 'the board still warms up');
});
