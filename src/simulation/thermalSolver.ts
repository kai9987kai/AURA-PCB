import type { PCBLayoutData, ThermalGrid } from '../types/pcb';

export interface ThermalSource {
  x: number; // board x in mm
  y: number; // board y in mm
  power: number; // Watts
  radius: number; // mm
}

// Set up the thermal grid based on the board dimensions
export function createThermalGrid(
  boardWidth: number,
  boardHeight: number,
  cellSizeMm: number
): ThermalGrid {
  const widthCells = Math.ceil(boardWidth / cellSizeMm);
  const heightCells = Math.ceil(boardHeight / cellSizeMm);
  const temperatures = new Float32Array(widthCells * heightCells).fill(25.0); // ambient 25C

  return {
    widthCells,
    heightCells,
    cellSizeMm,
    temperatures
  };
}

// Compute the thermal conductivity matrix from the copper on the board: pours, traces and pads.
// Copper conductivity: ~390 W/m*K, FR4: ~0.3 W/m*K.
//
// Like the rest of this 2D model, a cell is either copper or substrate through the whole board
// thickness, so a 35um plane conducts as if it were 1.6mm of solid copper. That overstates
// spreading in absolute terms; it is kept because traces are already modelled the same way, and
// the display is a relative picture of where heat goes rather than a junction temperature.
export function computeConductivityGrid(
  layout: PCBLayoutData,
  widthCells: number,
  heightCells: number,
  cellSizeMm: number
): Float32Array {
  const conductivity = new Float32Array(widthCells * heightCells).fill(0.3); // Default FR4

  // Helper: check if a point is close to a line segment (trace)
  const distToSegment = (
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
  ) => {
    const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (l2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt((px - (x1 + t * (x2 - x1))) ** 2 + (py - (y1 + t * (y2 - y1))) ** 2);
  };

  // 0. A pour is by far the largest piece of copper on the board, and the dominant heat
  //    spreader when one exists. Stamping it first lets traces and pads only reinforce it.
  //    Clearance rings around foreign nets are ignored: they are far below one cell wide.
  for (const pour of layout.pours ?? []) {
    if (!(pour.margin >= 0) || !(pour.clearance > 0)) continue;
    for (let row = 0; row < heightCells; row++) {
      for (let col = 0; col < widthCells; col++) {
        const x = (col + 0.5) * cellSizeMm;
        const y = (row + 0.5) * cellSizeMm;
        if (x >= pour.margin && x <= layout.boardWidth - pour.margin &&
            y >= pour.margin && y <= layout.boardHeight - pour.margin) {
          conductivity[row * widthCells + col] = 390.0;
        }
      }
    }
  }

  // 1. Stamp copper traces with high conductivity
  layout.traces.forEach(trace => {
    for (let i = 0; i < trace.points.length - 1; i++) {
      const p1 = trace.points[i];
      const p2 = trace.points[i + 1];

      // Bounding box for segment
      const minX = Math.min(p1.x, p2.x) - trace.width - cellSizeMm;
      const maxX = Math.max(p1.x, p2.x) + trace.width + cellSizeMm;
      const minY = Math.min(p1.y, p2.y) - trace.width - cellSizeMm;
      const maxY = Math.max(p1.y, p2.y) + trace.width + cellSizeMm;

      const minCol = Math.max(0, Math.floor(minX / cellSizeMm));
      const maxCol = Math.min(widthCells - 1, Math.ceil(maxX / cellSizeMm));
      const minRow = Math.max(0, Math.floor(minY / cellSizeMm));
      const maxRow = Math.min(heightCells - 1, Math.ceil(maxY / cellSizeMm));

      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const cx = (c + 0.5) * cellSizeMm;
          const cy = (r + 0.5) * cellSizeMm;
          const dist = distToSegment(cx, cy, p1.x, p1.y, p2.x, p2.y);
          if (dist <= trace.width / 2 + cellSizeMm / 2) {
            conductivity[r * widthCells + c] = 390.0; // Copper trace
          }
        }
      }
    }
  });

  // 2. Stamp component pads with high conductivity
  layout.footprints.forEach(footprint => {
    footprint.pads.forEach(pad => {
      // Rotate pad rel coords
      const rad = (footprint.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = pad.relX * cos - pad.relY * sin;
      const ry = pad.relX * sin + pad.relY * cos;
      const px = footprint.x + rx;
      const py = footprint.y + ry;

      const col = Math.floor(px / cellSizeMm);
      const row = Math.floor(py / cellSizeMm);

      if (col >= 0 && col < widthCells && row >= 0 && row < heightCells) {
        conductivity[row * widthCells + col] = 390.0; // Copper pad
      }
    });
  });

  return conductivity;
}

// Solve one time-step of the 2D heat equation using Jacobi relaxation:
// T_new = [ k_right*T_right + k_left*T_left + k_up*T_up + k_down*T_down + Q*dx^2 + h_c*dx^2*T_amb ] / [ k_sum + h_c*dx^2 ]
// This provides a highly stable, physically inspired diffusion visualization.
export function solveThermalStep(
  grid: ThermalGrid,
  conductivity: Float32Array,
  sources: ThermalSource[],
  ambientTemp: number = 25.0,
  convectionCoeff: number = 15.0, // W/m^2*K (natural convection)
  iterations: number = 10
): ThermalGrid {
  const { widthCells, heightCells, cellSizeMm, temperatures } = grid;
  const size = widthCells * heightCells;
  
  // Convert cell size to meters for physical equation scale
  const dx = cellSizeMm / 1000.0; 
  const dx2 = dx * dx;

  // Set up heat generation matrix Q (W/m^3 or power per cell volume, scaled)
  const Q = new Float32Array(size);
  // Board thickness is roughly 1.6mm
  const thickness = 1.6 / 1000.0;
  sources.forEach(src => {
    const srcCol = Math.floor(src.x / cellSizeMm);
    const srcRow = Math.floor(src.y / cellSizeMm);
    const radCells = Math.ceil(src.radius / cellSizeMm);

    // Find the cells the component covers before handing out any power. Scaling each cell by
    // the ratio of cell area to disc area instead loses whatever the square grid fails to tile
    // (about 10% for a small part), and a board cannot shed power that was never put into it.
    const covered: number[] = [];
    for (let r = -radCells; r <= radCells; r++) {
      for (let c = -radCells; c <= radCells; c++) {
        const curCol = srcCol + c;
        const curRow = srcRow + r;
        if (curCol >= 0 && curCol < widthCells && curRow >= 0 && curRow < heightCells &&
            Math.sqrt(r * r + c * c) * cellSizeMm <= src.radius) {
          covered.push(curRow * widthCells + curCol);
        }
      }
    }
    // A part smaller than one cell, or sitting off the board, still has to put its heat
    // somewhere; the nearest in-bounds cell takes all of it.
    if (!covered.length) {
      const col = Math.max(0, Math.min(widthCells - 1, srcCol));
      const row = Math.max(0, Math.min(heightCells - 1, srcRow));
      covered.push(row * widthCells + col);
    }
    for (const idx of covered) Q[idx] += src.power / covered.length;
  });

  let T_old = new Float32Array(temperatures);
  let T_new = new Float32Array(size);

  // Convection leaves through both faces. Per unit volume that is 2h/dz, so it has to be
  // scaled by the thickness exactly like the source term is. Without the division the sink is
  // some five orders of magnitude weaker than conduction, and the board never reaches a steady
  // state at all: its temperature just climbs with the number of iterations run.
  const hc_dx2 = 2 * convectionCoeff * dx2 / thickness;

  for (let iter = 0; iter < iterations; iter++) {
    for (let r = 0; r < heightCells; r++) {
      for (let c = 0; c < widthCells; c++) {
        const idx = r * widthCells + c;

        // Boundary conditions (isolated edges, ambient heat transfer)
        const k_center = conductivity[idx];

        // Conductivities and temperatures of neighbors (reflective boundary at edges)
        const c_right = c < widthCells - 1 ? c + 1 : c;
        const c_left = c > 0 ? c - 1 : c;
        const r_up = r < heightCells - 1 ? r + 1 : r;
        const r_down = r > 0 ? r - 1 : r;

        const idx_r = r * widthCells + c_right;
        const idx_l = r * widthCells + c_left;
        const idx_u = r_up * widthCells + c;
        const idx_d = r_down * widthCells + c;

        // Average conductivities between interface
        const k_r = (k_center + conductivity[idx_r]) / 2.0;
        const k_l = (k_center + conductivity[idx_l]) / 2.0;
        const k_u = (k_center + conductivity[idx_u]) / 2.0;
        const k_d = (k_center + conductivity[idx_d]) / 2.0;

        const T_r = T_old[idx_r];
        const T_l = T_old[idx_l];
        const T_u = T_old[idx_u];
        const T_d = T_old[idx_d];

        // Heat conduction term: k * Area * (dT/dn)
        // Stamping in 2D grid:
        const numerator = k_r * T_r + k_l * T_l + k_u * T_u + k_d * T_d + Q[idx] / thickness + hc_dx2 * ambientTemp;
        const denominator = k_r + k_l + k_u + k_d + hc_dx2;

        T_new[idx] = numerator / denominator;
      }
    }
    // Swap buffers
    const temp = T_old;
    T_old = T_new;
    T_new = temp;
  }

  return {
    widthCells,
    heightCells,
    cellSizeMm,
    temperatures: T_old
  };
}
