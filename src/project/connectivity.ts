import type { PCBLayoutData, SchematicData } from '../types/pcb';

/** Stable, pin-derived net names avoid renumbering unrelated copper after edits. */
export function applyConnectivityNets(schematic: SchematicData, pcbLayout: PCBLayoutData) {
  const parents = new Map<string, string>();
  const key = (component: string, pin: string) => `${component}:${pin}`;
  for (const c of schematic.components) for (const p of c.pins) parents.set(key(c.id, p.id), key(c.id, p.id));
  const find = (id: string): string => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root)!;
    while (id !== root) { const next = parents.get(id)!; parents.set(id, root); id = next; }
    return root;
  };
  const join = (a: string, b: string) => {
    if (parents.has(a) && parents.has(b)) parents.set(find(a), find(b));
  };
  const grounds = schematic.components.filter(c => c.type === 'gnd').flatMap(c => c.pins.map(p => key(c.id, p.id)));
  for (const ground of grounds.slice(1)) join(grounds[0], ground);
  for (const w of schematic.wires) join(key(w.fromCompId, w.fromPinId), key(w.toCompId, w.toPinId));
  const groups = new Map<string, string[]>();
  for (const id of parents.keys()) { const root = find(id); groups.set(root, [...(groups.get(root) ?? []), id]); }
  const names = new Map<string, string>();
  for (const pins of groups.values()) {
    const name = pins.some(p => grounds.includes(p)) ? 'GND' : `N_${pins.sort()[0]}`;
    for (const pin of pins) names.set(pin, name);
  }
  return {
    schematic: {
      ...schematic,
      components: schematic.components.map(c => ({ ...c, pins: c.pins.map(p => ({ ...p, net: names.get(key(c.id, p.id)) })) })),
      wires: schematic.wires.map(w => ({ ...w, net: names.get(key(w.fromCompId, w.fromPinId)) ?? '' })),
    },
    pcbLayout: {
      ...pcbLayout,
      footprints: pcbLayout.footprints.map(f => ({ ...f, pads: f.pads.map(p => ({ ...p, net: names.get(key(f.componentId, p.id)) })) })),
    },
  };
}

/** Merges can rename copper; split nets discard ambiguous routes instead of silently shorting new nets. */
export function reconcileCopper(previous: SchematicData, schematic: SchematicData, layout: PCBLayoutData) {
  const next = applyConnectivityNets(schematic, layout);
  const pinNets = new Map(next.schematic.components.flatMap(c => c.pins.map(p => [`${c.id}:${p.id}`, p.net!] as const)));
  const replacements = new Map<string, Set<string>>();
  for (const c of previous.components) for (const p of c.pins) {
    if (!p.net) continue;
    const set = replacements.get(p.net) ?? new Set<string>();
    const newNet = pinNets.get(`${c.id}:${p.id}`);
    if (newNet) set.add(newNet);
    replacements.set(p.net, set);
  }
  const mapNet = (net: string) => {
    const targets = replacements.get(net);
    return targets ? (targets.size === 1 ? [...targets][0] : null) : net;
  };
  next.pcbLayout.traces = layout.traces.flatMap(t => { const net = mapNet(t.net); return net ? [{ ...t, net }] : []; });
  next.pcbLayout.vias = layout.vias.flatMap(v => { const net = mapNet(v.net); return net ? [{ ...v, net }] : []; });
  return next;
}

export function electricalSignature(schematic: SchematicData) {
  return JSON.stringify(schematic.components.map(c => ({ id: c.id, type: c.type, value: c.value, params: c.params, pins: c.pins.map(p => [p.id, p.net]) })));
}

export function nextComponentId(prefix: string, schematic: SchematicData) {
  const ids = new Set(schematic.components.map(c => c.id));
  let index = 1;
  while (ids.has(`${prefix}${index}`)) index++;
  return `${prefix}${index}`;
}
