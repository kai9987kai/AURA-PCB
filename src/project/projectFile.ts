import type { ComponentType, PCBLayoutData, SchematicData } from '../types/pcb';
import { reconcileCopper } from './connectivity';

export interface Project { name: string; schematic: SchematicData; pcbLayout: PCBLayoutData }
export const MAX_FILE_BYTES = 2_000_000;
export const STORAGE_KEY = 'aura-pcb.project.v1';
export const emptyProject = (): Project => ({ name: 'Untitled board', schematic: { components: [], wires: [] }, pcbLayout: { boardWidth: 80, boardHeight: 55, footprints: [], traces: [], vias: [] } });
const types = new Set<ComponentType>(['resistor', 'capacitor', 'inductor', 'voltage_source', 'gnd', 'diode', 'led', 'transistor_npn', 'opamp', 'timer555']);
const fail = (field: string): never => { throw new Error(`Invalid project: ${field}.`); };
const object = (v: unknown, field: string): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(field);
const text = (v: unknown, field: string, max = 120): string => typeof v === 'string' && v.length <= max ? v : fail(field);
const id = (v: unknown, field: string) => {
  const s = text(v, field, 80);
  return /^[\w.+-]+$/.test(s) && !['__proto__', 'constructor', 'prototype'].includes(s) ? s : fail(field);
};
const number = (v: unknown, field: string, min = -10000, max = 10000): number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(field);
const list = (v: unknown, field: string, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : fail(`${field} (limit ${max})`);
const unique = <T extends { id: string }>(items: T[], field: string): T[] => new Set(items.map(x => x.id)).size === items.length ? items : fail(`duplicate ${field}`);
const point = (v: unknown) => { const p = object(v, 'point'); return { x: number(p.x, 'x'), y: number(p.y, 'y') }; };
const net = (v: unknown): string | undefined => v === undefined ? undefined : text(v, 'net', 200);
const kind = (v: unknown) => types.has(v as ComponentType) ? v as ComponentType : fail('component type');

/** Decode a bounded, versioned document and reconstruct only supported fields. */
export function parseProject(contents: string): Project {
  if (new TextEncoder().encode(contents).length > MAX_FILE_BYTES) fail('file exceeds 2 MB');
  let value: unknown;
  try { value = JSON.parse(contents); } catch { return fail('JSON syntax'); }
  const doc = object(value, 'document');
  if (doc.format !== 'aura-pcb' || doc.version !== 1) fail('unsupported file format or version');
  const data = object(doc.project, 'project');
  const sch = object(data.schematic, 'schematic');
  const pcb = object(data.pcbLayout, 'layout');
  const components = unique(list(sch.components, 'components', 128).map(v => {
    const c = object(v, 'component');
    const params = Object.fromEntries(Object.entries(object(c.params, 'parameters')).map(([k, value]) => [id(k, 'parameter'), number(value, 'parameter value', -1e15, 1e15)]));
    const pins = unique(list(c.pins, 'pins', 32).map(v => { const p = object(v, 'pin'); return { id: id(p.id, 'pin id'), label: text(p.label, 'pin label'), relX: number(p.relX, 'pin x'), relY: number(p.relY, 'pin y'), net: net(p.net) }; }), 'pin id');
    if (!pins.length) fail('component needs pins');
    return { id: id(c.id, 'component id'), type: kind(c.type), name: text(c.name, 'name'), value: text(c.value, 'value'), x: number(c.x, 'x'), y: number(c.y, 'y'), rotation: number(c.rotation, 'rotation', 0, 360), pins, params };
  }), 'component id');
  const pinExists = (comp: string, pin: string) => components.some(c => c.id === comp && c.pins.some(p => p.id === pin));
  const wires = unique(list(sch.wires, 'wires', 512).map(v => {
    const w = object(v, 'wire');
    const fromCompId = id(w.fromCompId, 'wire component'); const toCompId = id(w.toCompId, 'wire component');
    const fromPinId = id(w.fromPinId, 'wire pin'); const toPinId = id(w.toPinId, 'wire pin');
    if (!pinExists(fromCompId, fromPinId) || !pinExists(toCompId, toPinId)) fail('wire references a missing pin');
    return { id: id(w.id, 'wire id'), fromCompId, fromPinId, toCompId, toPinId, points: list(w.points, 'wire points', 128).map(point), net: net(w.net) ?? '' };
  }), 'wire id');
  const footprints = unique(list(pcb.footprints, 'footprints', 128).map(v => {
    const f = object(v, 'footprint'); const componentId = id(f.componentId, 'footprint component');
    const component = components.find(c => c.id === componentId);
    if (!component || component.type !== f.type || f.id !== componentId) fail('footprint/component mismatch');
    const pads = unique(list(f.pads, 'pads', 32).map(v => {
      const p = object(v, 'pad'); const padId = id(p.id, 'pad id');
      if (!pinExists(componentId, padId)) fail('pad references missing pin');
      const diameter = number(p.diameter, 'pad diameter', 0.01, 100);
      return { id: padId, relX: number(p.relX, 'pad x'), relY: number(p.relY, 'pad y'), diameter, holeDiameter: number(p.holeDiameter, 'pad drill', 0, diameter), net: net(p.net) };
    }), 'pad id');
    if (pads.length !== component!.pins.length) fail('footprint must represent every component pin');
    if (typeof f.isPlaced !== 'boolean') fail('placement flag');
    return { id: id(f.id, 'footprint id'), componentId, type: kind(f.type), x: number(f.x, 'x'), y: number(f.y, 'y'), rotation: number(f.rotation, 'rotation', 0, 360), width: number(f.width, 'footprint width', 0.01, 500), height: number(f.height, 'footprint height', 0.01, 500), pads, isPlaced: f.isPlaced as boolean };
  }), 'footprint id');
  if (footprints.length !== components.length) fail('every component needs a footprint');
  const traces = unique(list(pcb.traces, 'traces', 512).map(v => {
    const t = object(v, 'trace');
    if (t.layer !== 'top' && t.layer !== 'bottom') fail('trace layer');
    const points = list(t.points, 'trace points', 128).map(point);
    if (points.length < 2) fail('trace needs two points');
    return { id: id(t.id, 'trace id'), net: net(t.net) ?? '', points, width: number(t.width, 'trace width', 0.01, 20), layer: t.layer as 'top' | 'bottom' };
  }), 'trace id');
  if (traces.reduce((n, t) => n + t.points.length, 0) > 4096) fail('trace geometry exceeds 4096 points');
  const vias = unique(list(pcb.vias, 'vias', 256).map(v => {
    const p = object(v, 'via'); const diameter = number(p.diameter, 'via diameter', 0.01, 20);
    return { id: id(p.id, 'via id'), x: number(p.x, 'x'), y: number(p.y, 'y'), net: net(p.net) ?? '', diameter, drillDiameter: number(p.drillDiameter, 'via drill', 0.01, diameter) };
  }), 'via id');
  const schematic = { components, wires };
  const layout = { boardWidth: number(pcb.boardWidth, 'board width', 10, 500), boardHeight: number(pcb.boardHeight, 'board height', 10, 500), footprints, traces, vias };
  return { name: text(data.name, 'project name', 80), ...reconcileCopper(schematic, schematic, layout) };
}

export function serializeProject(project: Project) {
  return JSON.stringify({ format: 'aura-pcb', version: 1, project }, null, 2);
}

export function downloadText(filename: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function buildBomCsv(project: Project) {
  const csv = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? "'" : '') + s.replaceAll('"', '""')}"`;
  return ['Reference,Label,Type,Value', ...project.schematic.components.filter(c => c.type !== 'gnd').map(c => [c.id, c.name, c.type, c.value].map(csv).join(','))].join('\r\n');
}
