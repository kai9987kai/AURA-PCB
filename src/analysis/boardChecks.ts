import type { Pad, PCBFootprint, PCBLayoutData } from '../types/pcb';

import { segmentDistance } from './geometry';
import type { Point } from './geometry';
import { verifyPourConnections } from './pourConnectivity';
export { pointSegmentDistance, segmentDistance } from './geometry';
export type { Point } from './geometry';
export interface BoardIssue {
  id: string;
  message: string;
  kind: 'clearance' | 'edge' | 'fabrication' | 'unrouted' | 'invalid';
  x?: number;
  y?: number;
  net?: string;
  itemIds?: string[];
}
export interface NetConnectivity {
  net: string;
  padCount: number;
  connectedGroups: number;
  fullyRouted: boolean;
}
export interface Airwire { net: string; from: Point; to: Point }
export interface BoardAnalysis {
  issues: BoardIssue[];
  nets: NetConnectivity[];
  airwires: Airwire[];
  /** Percentage of required pad-to-pad connections supplied by actual copper. */
  routingCompletion: number;
  /** Conservative pour checks may leave narrow paths unverified. */
  notices: string[];
}

// Conservative project defaults, not a fabrication-house capability guarantee.
export const BOARD_RULES = Object.freeze({
  clearance: 0.25, edgeClearance: 0.25,
  minTraceWidth: 0.20, minDrillDiameter: 0.35, minAnnularRing: 0.15,
});
const EPSILON = 1e-9;
const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);
const knownNet = (net: string | undefined) => net?.trim() || undefined;

export function getPadBoardCoords(fp: Pick<PCBFootprint, 'x' | 'y' | 'rotation'>, pad: Pick<Pad, 'relX' | 'relY'>): Point {
  const rad = fp.rotation * Math.PI / 180;
  return {
    x: fp.x + pad.relX * Math.cos(rad) - pad.relY * Math.sin(rad),
    y: fp.y + pad.relX * Math.sin(rad) + pad.relY * Math.cos(rad),
  };
}

export interface Copper {
  id: string;
  label: string;
  net?: string;
  kind: 'pad' | 'via' | 'trace';
  points: Point[];
  radius: number;
  holeRadius: number;
  layers: number; // top = 1, bottom = 2, plated through = 3
}

function segments(copper: Copper): [Point, Point][] {
  return copper.points.length === 1 ? [[copper.points[0], copper.points[0]]] :
    copper.points.slice(1).map((point, i) => [copper.points[i], point]);
}

function copperDistance(a: Copper, b: Copper): number {
  let min = Infinity;
  for (const [a1, a2] of segments(a)) {
    for (const [b1, b2] of segments(b)) {
      min = Math.min(min, segmentDistance(a1, a2, b1, b2) - a.radius - b.radius);
    }
  }
  return min;
}

function touchesCopper(a: Copper, b: Copper, distance: number): boolean {
  if (distance > EPSILON) return false;
  // A trace contained wholly in a drilled void is not electrically attached.
  for (const [ring, other] of [[a, b], [b, a]]) {
    if (ring.holeRadius > 0 && other.points.every(p =>
      Math.hypot(p.x - ring.points[0].x, p.y - ring.points[0].y) + other.radius < ring.holeRadius - EPSILON)) {
      return false;
    }
  }
  return true;
}

class DisjointSet {
  parent: number[];
  constructor(count: number) { this.parent = Array.from({ length: count }, (_, i) => i); }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  join(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

/**
 * Two-layer circular-pad model: SMD pads are top-only; drilled pads and vias
 * are plated through. A copper pour supplies connectivity only through paths verified clear of
 * foreign-copper clearances and drill holes on its own layer. Invalid objects are reported and excluded from connectivity.
 */
export function analyzeBoard(layout: PCBLayoutData): BoardAnalysis {
  const issues: BoardIssue[] = [];
  const notices: string[] = [];
  const copper: Copper[] = [];
  const add = (kind: BoardIssue['kind'], id: string, message: string, point?: Point, itemIds?: string[]) => {
    issues.push({ id: `${kind}:${id}`, kind, message, ...(point ? { x: point.x, y: point.y } : {}), itemIds });
  };
  const validBoard = Number.isFinite(layout.boardWidth) && layout.boardWidth > 0 &&
    Number.isFinite(layout.boardHeight) && layout.boardHeight > 0;
  if (!validBoard) add('invalid', 'board', 'Invalid board dimensions: width and height must be finite and positive');

  function addCopper(item: Copper) {
    copper.push(item);
    if (validBoard && item.points.some(p =>
      p.x - item.radius < BOARD_RULES.edgeClearance - EPSILON ||
      p.y - item.radius < BOARD_RULES.edgeClearance - EPSILON ||
      p.x + item.radius > layout.boardWidth - BOARD_RULES.edgeClearance + EPSILON ||
      p.y + item.radius > layout.boardHeight - BOARD_RULES.edgeClearance + EPSILON)) {
      add('edge', item.id, `Board edge violation: ${item.label} copper needs ${BOARD_RULES.edgeClearance.toFixed(2)}mm edge clearance`, item.points[0], [item.id]);
    }
  }
  function checkDrill(id: string, label: string, diameter: number, drill: number, point: Point) {
    if (drill < BOARD_RULES.minDrillDiameter - EPSILON) {
      add('fabrication', `${id}:drill`, `Fabrication violation: ${label} drill ${drill.toFixed(2)}mm is below ${BOARD_RULES.minDrillDiameter.toFixed(2)}mm`, point, [id]);
    }
    const ring = (diameter - drill) / 2;
    if (ring < BOARD_RULES.minAnnularRing - EPSILON) {
      add('fabrication', `${id}:ring`, `Fabrication violation: ${label} annular ring ${ring.toFixed(2)}mm is below ${BOARD_RULES.minAnnularRing.toFixed(2)}mm`, point, [id]);
    }
  }

  layout.footprints.forEach((fp, fpIndex) => {
    if (![fp.x, fp.y, fp.rotation, fp.width, fp.height].every(Number.isFinite) || fp.width <= 0 || fp.height <= 0) {
      add('invalid', `footprint:${fpIndex}`, `Invalid footprint geometry: ${fp.id}`);
      return;
    }
    const corners = [-1, 1].flatMap(x => [-1, 1].map(y => getPadBoardCoords(fp,
      { relX: x * fp.width / 2, relY: y * fp.height / 2 })));
    if (validBoard && corners.some(p => p.x < -EPSILON || p.y < -EPSILON ||
      p.x > layout.boardWidth + EPSILON || p.y > layout.boardHeight + EPSILON)) {
      add('edge', `footprint:${fpIndex}`, `Board edge violation: Footprint ${fp.id} exceeds the board outline`, fp, [fp.id]);
    }
    fp.pads.forEach((pad, padIndex) => {
      const id = `pad:${fpIndex}:${padIndex}`;
      const label = `Pad ${fp.id}:${pad.id}`;
      const point = getPadBoardCoords(fp, pad);
      if (!finitePoint(point) || !Number.isFinite(pad.diameter) || pad.diameter <= 0 ||
          !Number.isFinite(pad.holeDiameter) || pad.holeDiameter < 0) {
        add('invalid', id, `Invalid copper geometry: ${label}`);
        return;
      }
      if (pad.holeDiameter > 0) checkDrill(id, label, pad.diameter, pad.holeDiameter, point);
      if (pad.holeDiameter >= pad.diameter) return; // No usable copper remains.
      addCopper({ id, label, kind: 'pad', net: knownNet(pad.net), points: [point],
        radius: pad.diameter / 2, holeRadius: pad.holeDiameter / 2, layers: pad.holeDiameter > 0 ? 3 : 1 });
    });
  });
  layout.vias.forEach((via, index) => {
    const id = `via:${index}`;
    const label = `Via ${via.id}`;
    if (!finitePoint(via) || !Number.isFinite(via.diameter) || via.diameter <= 0 ||
        !Number.isFinite(via.drillDiameter) || via.drillDiameter <= 0) {
      add('invalid', id, `Invalid copper geometry: ${label}`);
      return;
    }
    checkDrill(id, label, via.diameter, via.drillDiameter, via);
    if (via.drillDiameter >= via.diameter) return;
    addCopper({ id, label, kind: 'via', net: knownNet(via.net), points: [{ x: via.x, y: via.y }],
      radius: via.diameter / 2, holeRadius: via.drillDiameter / 2, layers: 3 });
  });
  layout.traces.forEach((trace, index) => {
    const id = `trace:${index}`;
    const label = `Trace ${trace.id} (${knownNet(trace.net) ?? 'unassigned'})`;
    if (trace.points.length < 2 || !trace.points.every(finitePoint) ||
        !Number.isFinite(trace.width) || trace.width <= 0 || !['top', 'bottom'].includes(trace.layer)) {
      add('invalid', id, `Invalid copper geometry: ${label}`);
      return;
    }
    if (trace.width < BOARD_RULES.minTraceWidth - EPSILON) {
      add('fabrication', `${id}:width`, `Fabrication violation: ${label} width ${trace.width.toFixed(2)}mm is below ${BOARD_RULES.minTraceWidth.toFixed(2)}mm`, trace.points[0], [id]);
    }
    addCopper({ id, label, kind: 'trace', net: knownNet(trace.net), points: trace.points,
      radius: trace.width / 2, holeRadius: 0, layers: trace.layer === 'top' ? 1 : 2 });
  });

  const connected = new DisjointSet(copper.length);
  for (let i = 0; i < copper.length; i++) {
    for (let j = i + 1; j < copper.length; j++) {
      const a = copper[i];
      const b = copper[j];
      if (!(a.layers & b.layers)) continue;
      const distance = copperDistance(a, b);
      if (a.net && a.net === b.net) {
        if (touchesCopper(a, b, distance)) connected.join(i, j);
      } else if (distance < BOARD_RULES.clearance - EPSILON) {
        add('clearance', `${a.id}:${b.id}`,
          `Clearance violation: ${a.label} to ${b.label} (${distance.toFixed(2)}mm; minimum ${BOARD_RULES.clearance.toFixed(2)}mm)`, a.points[0], [a.id, b.id]);
      }
    }
  }

  // A fill can split into islands after clearance cuts. Only demonstrable paths count.
  (layout.pours ?? []).forEach((pour, index) => {
    const pourId = `pour:${index}`;
    const pourNet = knownNet(pour.net);
    const label = `Pour ${pour.id} (${pourNet ?? 'unassigned'})`;
    if (!validBoard || !Number.isFinite(pour.margin) || pour.margin < 0 ||
        !Number.isFinite(pour.clearance) || pour.clearance <= 0 || !pourNet ||
        !['top', 'bottom'].includes(pour.layer)) {
      add('invalid', pourId, `Invalid pour geometry: ${label}`);
      return;
    }
    if (pour.margin < BOARD_RULES.edgeClearance - EPSILON) {
      add('edge', pourId, `Board edge violation: ${label} margin ${pour.margin.toFixed(2)}mm is below ${BOARD_RULES.edgeClearance.toFixed(2)}mm`, undefined, [pour.id]);
    }
    if (pour.clearance < BOARD_RULES.clearance - EPSILON) {
      add('clearance', pourId, `Clearance violation: ${label} clearance ${pour.clearance.toFixed(2)}mm is below ${BOARD_RULES.clearance.toFixed(2)}mm`, undefined, [pour.id]);
    }
    const region = {
      x0: pour.margin, y0: pour.margin,
      x1: layout.boardWidth - pour.margin, y1: layout.boardHeight - pour.margin,
    };
    if (region.x1 - region.x0 <= EPSILON || region.y1 - region.y0 <= EPSILON) {
      add('invalid', pourId, `Invalid pour geometry: ${label} margin leaves no copper`);
      return;
    }
    const result = verifyPourConnections(copper, { ...pour, net: pourNet }, region);
    for (const group of result.groups) for (const i of group.slice(1)) connected.join(group[0], i);
    if (!result.groups.length) {
      add('unrouted', pourId, `Floating pour ${pour.id}: no verified ${pourNet} copper contact on the ${pour.layer} flood`);
    }
    notices.push(`${label}: connectivity paths checked on a ${result.spacing.toFixed(2)}mm grid. Narrow paths may remain unverified; inspect the exported fill.${result.limited ? ' Check budget reached; unverified connections remain unrouted.' : ''}`);
  });

  // Retain invalid terminals in the denominator so bad geometry cannot make
  // a previously incomplete net appear completely routed.
  const declaredPadCounts = new Map<string, number>();
  layout.footprints.forEach(fp => fp.pads.forEach(pad => {
    const net = knownNet(pad.net);
    if (net) declaredPadCounts.set(net, (declaredPadCounts.get(net) ?? 0) + 1);
  }));
  const byNet = new Map<string, number[]>([...declaredPadCounts.keys()].map(net => [net, []]));
  copper.forEach((item, index) => {
    if (item.kind !== 'pad' || !item.net) return;
    const indices = byNet.get(item.net) ?? [];
    indices.push(index);
    byNet.set(item.net, indices);
  });
  const nets: NetConnectivity[] = [];
  const airwires: Airwire[] = [];
  let neededConnections = 0;
  let madeConnections = 0;
  for (const [net, indices] of byNet) {
    const groups = new Set(indices.map(i => connected.find(i)));
    const padCount = declaredPadCounts.get(net)!;
    const invalidPads = padCount - indices.length;
    const connectedGroups = groups.size + invalidPads;
    nets.push({ net, padCount, connectedGroups, fullyRouted: invalidPads === 0 && groups.size <= 1 });
    neededConnections += Math.max(0, padCount - 1);
    madeConnections += indices.length - groups.size;
    if (connectedGroups > 1 || invalidPads > 0) {
      add('unrouted', net, `Unrouted net ${net}: ${padCount} pads in ${connectedGroups} disconnected copper groups${invalidPads ? ` (${invalidPads} invalid pads)` : ''}`);
      // Prim's tree over actual copper groups: exactly groups-1 visible airwires.
      const visited = new Set<number>(indices.length ? [connected.find(indices[0])] : []);
      while (visited.size < groups.size) {
        let best: { from: number; to: number; length: number } | undefined;
        for (const from of indices) {
          if (!visited.has(connected.find(from))) continue;
          for (const to of indices) {
            if (visited.has(connected.find(to))) continue;
            const a = copper[from].points[0];
            const b = copper[to].points[0];
            const length = Math.hypot(a.x - b.x, a.y - b.y);
            if (!best || length < best.length) best = { from, to, length };
          }
        }
        if (!best) break;
        airwires.push({ net, from: { ...copper[best.from].points[0] }, to: { ...copper[best.to].points[0] } });
        visited.add(connected.find(best.to));
      }
    }
  }
  return { issues, nets, airwires, notices, routingCompletion: neededConnections ? madeConnections / neededConnections * 100 : nets.some(net => !net.fullyRouted) ? 0 : 100 };
}
