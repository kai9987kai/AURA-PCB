import type { Pad, PCBFootprint, PCBLayoutData } from '../types/pcb';

export interface Point { x: number; y: number }
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

export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squaredLength = dx * dx + dy * dy;
  const t = squaredLength === 0 ? 0 : Math.max(0, Math.min(1,
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / squaredLength));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Exact segment intersection plus symmetric endpoint distances, including degeneracy. */
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
      ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

interface Copper {
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
 * are plated through. Decorative pour previews never supply connectivity.
 * Invalid objects are reported and excluded from connectivity.
 */
export function analyzeBoard(layout: PCBLayoutData): BoardAnalysis {
  const issues: BoardIssue[] = [];
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
  return { issues, nets, airwires, routingCompletion: neededConnections ? madeConnections / neededConnections * 100 : nets.some(net => !net.fullyRouted) ? 0 : 100 };
}
