import type { CopperPour } from '../types/pcb';
import type { Copper } from './boardChecks';
import { segmentDistance, type Point } from './geometry';

interface Region { x0: number; y0: number; x1: number; y1: number }
interface Obstacle extends Region { a: Point; b: Point; radius: number }
const EPS = 1e-7;
const MAX_NODES = 16_000;
const MAX_CHECKS = 500_000;

/**
 * Conservative connectivity proof for a rectangular fill minus circular/capsule clearances.
 * Every graph edge is checked against exact obstacles, including between sample points, so
 * undersampling may miss a narrow connection but cannot bridge a clearance cut. The graph
 * does not replace the exported geometry and makes no claim to identify every copper island.
 */
export function verifyPourConnections(items: Copper[], pour: CopperPour, region: Region): {
  groups: number[][]; spacing: number; limited: boolean;
} {
  const side = pour.layer === 'top' ? 1 : 2;
  const eligible = items.flatMap((item, i) => item.net === pour.net && (item.layers & side) ? [i] : []);
  const width = region.x1 - region.x0;
  const height = region.y1 - region.y0;
  const spacing = Math.max(0.5, Math.sqrt(width * height / MAX_NODES));
  // A bounded number of graph vertices, including on very long, thin regions.
  const cols = Math.max(1, Math.floor(width / spacing));
  const rows = Math.max(1, Math.min(Math.floor(height / spacing), Math.floor(MAX_NODES / (cols + 1)) - 1));
  const dx = width / cols;
  const dy = height / rows;
  if (!eligible.length) return { groups: [], spacing: Math.max(dx, dy), limited: false };
  const obstacles: Obstacle[] = [];
  const addObstacle = (a: Point, b: Point, radius: number) => {
    const bounds = { x0: Math.min(a.x, b.x) - radius, y0: Math.min(a.y, b.y) - radius,
      x1: Math.max(a.x, b.x) + radius, y1: Math.max(a.y, b.y) + radius };
    if (bounds.x1 < region.x0 || bounds.y1 < region.y0 || bounds.x0 > region.x1 || bounds.y0 > region.y1) return;
    obstacles.push({ a, b, radius, ...bounds });
  };
  for (const item of items) {
    if (!(item.layers & side)) continue;
    if (item.net !== pour.net) {
      const pairs = item.points.length === 1 ? [[item.points[0], item.points[0]]] :
        item.points.slice(1).map((p, i) => [item.points[i], p]);
      for (const [a, b] of pairs) addObstacle(a, b, item.radius + pour.clearance);
    } else if (item.holeRadius) {
      addObstacle(item.points[0], item.points[0], item.holeRadius);
    }
  }
  // Spatial buckets keep the cost proportional to nearby obstacles, not every board item.
  const bucketSize = Math.max(2, spacing * 2);
  const buckets = new Map<string, number[]>();
  const bucketRange = (bounds: Region) => ({
    x0: Math.floor(Math.max(region.x0, bounds.x0) / bucketSize),
    x1: Math.floor(Math.min(region.x1, bounds.x1) / bucketSize),
    y0: Math.floor(Math.max(region.y0, bounds.y0) / bucketSize),
    y1: Math.floor(Math.min(region.y1, bounds.y1) / bucketSize),
  });
  for (let i = 0; i < obstacles.length; i++) {
    const range = bucketRange(obstacles[i]);
    for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) {
      const key = `${x}:${y}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(i);
      buckets.set(key, bucket);
    }
  }
  let checks = 0;
  let limited = false;
  const inside = (p: Point) => p.x >= region.x0 && p.x <= region.x1 && p.y >= region.y0 && p.y <= region.y1;
  const clear = (a: Point, b: Point): boolean => {
    if (!inside(a) || !inside(b) || limited) return false;
    const bounds = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const range = bucketRange(bounds);
    const seen = new Set<number>();
    for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) {
      for (const i of buckets.get(`${x}:${y}`) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        const obstacle = obstacles[i];
        if (bounds.x1 < obstacle.x0 || bounds.y1 < obstacle.y0 || bounds.x0 > obstacle.x1 || bounds.y0 > obstacle.y1) continue;
        if (++checks > MAX_CHECKS) { limited = true; return false; }
        if (segmentDistance(a, b, obstacle.a, obstacle.b) <= obstacle.radius + EPS) return false;
      }
    }
    return true;
  };
  const count = (cols + 1) * (rows + 1);
  const parent = Int32Array.from({ length: count + items.length }, (_, i) => i);
  const find = (i: number): number => {
    while (i !== parent[i]) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const point = (c: number, r: number): Point => ({ x: region.x0 + c * dx, y: region.y0 + r * dy });
  const valid = new Uint8Array(count);
  for (let r = 0; r <= rows && !limited; r++) for (let c = 0; c <= cols && !limited; c++) {
    const i = r * (cols + 1) + c;
    const p = point(c, r);
    if (!clear(p, p)) continue;
    valid[i] = 1;
    if (c && valid[i - 1] && clear(p, point(c - 1, r))) join(i, i - 1);
    if (r && valid[i - cols - 1] && clear(p, point(c, r - 1))) join(i, i - cols - 1);
  }
  const touched = new Set<number>();
  const attach = (itemIndex: number, p: Point) => {
    if (!inside(p)) return;
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor((p.x - region.x0) / dx)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor((p.y - region.y0) / dy)));
    for (const c of [c0, c0 + 1]) for (const r of [r0, r0 + 1]) {
      const i = r * (cols + 1) + c;
      if (valid[i] && clear(p, point(c, r))) { join(count + itemIndex, i); touched.add(itemIndex); }
    }
  };
  for (const i of eligible) {
    if (limited) break;
    const item = items[i];
    if (item.points.length === 1) {
      const centre = item.points[0];
      // Points on the actual annulus, never at the centre of a plated drill hole.
      if (!item.holeRadius) attach(i, centre);
      const radius = (item.radius + item.holeRadius) / 2;
      for (let direction = 0; direction < 16; direction++) {
        const angle = direction * Math.PI / 8;
        attach(i, { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
      }
    } else {
      for (let j = 1; j < item.points.length && !limited; j++) {
        const a = item.points[j - 1];
        const b = item.points[j];
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.min(2_000, Math.max(1, Math.ceil(length / spacing)));
        for (let k = 0; k <= steps && !limited; k++) attach(i,
          { x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of touched) {
    const key = find(count + i);
    const group = groups.get(key) ?? [];
    group.push(i);
    groups.set(key, group);
  }
  return { groups: [...groups.values()], spacing: Math.max(dx, dy), limited };
}
