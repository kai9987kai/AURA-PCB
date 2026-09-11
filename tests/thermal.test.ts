import assert from 'node:assert/strict';
import test from 'node:test';
import { computeConductivityGrid, createThermalGrid, solveThermalStep } from '../src/simulation/thermalSolver.ts';
import type { CopperPour, PCBLayoutData, ThermalSource } from '../src/types/pcb.ts';

const CELL = 1.5;
const WIDTH = 40;
const HEIGHT = 20;
const AMBIENT = 25;
const CONVECTION = 15;
const COLS = Math.ceil(WIDTH / CELL);
const ROWS = Math.ceil(HEIGHT / CELL);

const layout = (pours: CopperPour[] = []): PCBLayoutData =>
  ({ boardWidth: WIDTH, boardHeight: HEIGHT, footprints: [], traces: [], vias: [], pours });
const plane: CopperPour = { id: 'p1', net: 'GND', layer: 'bottom', margin: 0.5, clearance: 0.3 };

function settle(board: PCBLayoutData, sources: ThermalSource[], steps = 20000) {
  const conductivity = computeConductivityGrid(board, COLS, ROWS, CELL);
  let grid = createThermalGrid(WIDTH, HEIGHT, CELL);
  for (let step = 0; step < steps; step++) {
    grid = solveThermalStep(grid, conductivity, sources, AMBIENT, CONVECTION);
  }
  const values = [...grid.temperatures];
  return { peak: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}

/**
 * At steady state every watt put in leaves through the two board faces, so the mean rise is
 * fixed by the energy balance alone. The discretised board is COLS x ROWS cells, which is
 * slightly larger than the nominal outline.
 */
const equilibriumMean = (power: number) =>
  AMBIENT + power / (2 * CONVECTION * (COLS * CELL / 1000) * (ROWS * CELL / 1000));

test('a settled board sheds exactly the power it was given', () => {
  for (const power of [1, 0.25]) {
    const { mean } = settle(layout(), [{ x: 20, y: 10, power, radius: 2 }]);
    assert.ok(Math.abs(mean - equilibriumMean(power)) < 0.5,
      `${power}W settled at a mean of ${mean.toFixed(2)}C, expected ${equilibriumMean(power).toFixed(2)}C`);
  }
});

test('where the heat goes is a matter of copper; how much leaves is not', () => {
  // Conductivity decides the gradient. It cannot change the energy balance that sets the mean.
  const source: ThermalSource[] = [{ x: 20, y: 10, power: 1, radius: 2 }];
  const bare = settle(layout(), source);
  const planed = settle(layout([plane]), source);

  assert.ok(Math.abs(bare.mean - planed.mean) < 0.5,
    `mean must not depend on copper: bare ${bare.mean.toFixed(2)}C vs planed ${planed.mean.toFixed(2)}C`);
  // A plane is a heat spreader: it trades a local hot spot for a nearly isothermal board.
  assert.ok(planed.peak < bare.peak / 4, `a plane must flatten the hot spot: ${planed.peak.toFixed(0)}C vs ${bare.peak.toFixed(0)}C`);
  assert.ok(planed.peak - planed.mean < 2, 'a planed board is close to isothermal');
  assert.ok(bare.peak - bare.mean > 50, 'bare substrate concentrates heat under the part');
});

test('a part smaller than one cell still delivers all of its heat', () => {
  const tiny = settle(layout(), [{ x: 20, y: 10, power: 1, radius: 0.01 }]);
  assert.ok(Math.abs(tiny.mean - equilibriumMean(1)) < 0.5,
    `a sub-cell part settled at ${tiny.mean.toFixed(2)}C, expected ${equilibriumMean(1).toFixed(2)}C`);
});

test('heat from a part off the board edge is placed, not discarded', () => {
  const outside = settle(layout(), [{ x: -5, y: -5, power: 1, radius: 0.5 }]);
  assert.ok(Math.abs(outside.mean - equilibriumMean(1)) < 0.5,
    `power silently vanished: settled at ${outside.mean.toFixed(2)}C, expected ${equilibriumMean(1).toFixed(2)}C`);
});

test('several parts sum rather than compete', () => {
  const split = settle(layout([plane]), [
    { x: 10, y: 10, power: 0.5, radius: 2 },
    { x: 30, y: 10, power: 0.5, radius: 2 },
  ]);
  assert.ok(Math.abs(split.mean - equilibriumMean(1)) < 0.5,
    `two half-watt parts settled at ${split.mean.toFixed(2)}C, expected ${equilibriumMean(1).toFixed(2)}C`);
});

test('an unpowered board never drifts off ambient', () => {
  const idle = settle(layout([plane]), [], 200);
  assert.ok(Math.abs(idle.peak - AMBIENT) < 1e-3);
  assert.ok(Math.abs(idle.mean - AMBIENT) < 1e-3);
});

test('doubling the convection coefficient halves the temperature rise', () => {
  const conductivity = computeConductivityGrid(layout([plane]), COLS, ROWS, CELL);
  const riseAt = (coefficient: number) => {
    let grid = createThermalGrid(WIDTH, HEIGHT, CELL);
    for (let step = 0; step < 20000; step++) {
      grid = solveThermalStep(grid, conductivity, [{ x: 20, y: 10, power: 1, radius: 2 }], AMBIENT, coefficient);
    }
    return [...grid.temperatures].reduce((sum, value) => sum + value, 0) / grid.temperatures.length - AMBIENT;
  };
  const slow = riseAt(CONVECTION);
  const fast = riseAt(CONVECTION * 2);
  assert.ok(Math.abs(fast - slow / 2) < 0.5, `rise ${slow.toFixed(2)}C should halve to ${(slow / 2).toFixed(2)}C, got ${fast.toFixed(2)}C`);
});

test('a via array pulls heat away from a part that bare substrate would let cook', () => {
  // A line of vias from the part toward the board edge, the way a thermal via array is laid.
  const vias = Array.from({ length: 10 }, (_, index) => ({
    id: `v${index}`, net: 'GND', x: 20 + index * 1.5, y: 10, diameter: 0.8, drillDiameter: 0.4,
  }));
  const conductivity = computeConductivityGrid(layout(), COLS, ROWS, CELL);
  const viaCell = computeConductivityGrid({ ...layout(), vias }, COLS, ROWS, CELL)[Math.floor(10 / CELL) * COLS + Math.floor(27.5 / CELL)];
  assert.equal(viaCell, 390, 'a via cell is copper');
  assert.ok(Math.abs(conductivity[Math.floor(10 / CELL) * COLS + Math.floor(27.5 / CELL)] - 0.3) < 1e-6, 'without the via it is substrate');

  const source = [{ x: 20, y: 10, power: 1, radius: 2 }];
  const bare = settle(layout(), source);
  const stitched = settle({ ...layout(), vias }, source);
  assert.ok(stitched.peak < bare.peak, `vias must lower the hot spot: ${stitched.peak.toFixed(0)}C vs ${bare.peak.toFixed(0)}C`);
  // The same power still leaves the board; vias move heat, they do not remove it.
  assert.ok(Math.abs(stitched.mean - bare.mean) < 0.5);
});
