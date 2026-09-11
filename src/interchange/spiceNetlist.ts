import type { SchematicComponent, SchematicData, SimSettings } from '../types/pcb';
import { parseValue } from '../simulation/spiceSolver';
import { applyConnectivityNets } from '../project/connectivity';

export interface SpiceExport {
  netlist: string;
  /** Everything that did not survive the translation exactly, for the caller to surface. */
  caveats: string[];
}

const EMPTY_LAYOUT = { boardWidth: 0, boardHeight: 0, footprints: [], traces: [], vias: [] };
const GROUND_NODE = '0';

/** SPICE identifiers are far narrower than this project's net and reference names. */
const scrub = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '') || 'N';

/**
 * Two distinct nets must never collapse onto one node just because scrubbing made them
 * look alike, so every claimed name is recorded and a counter breaks ties.
 */
function uniqueNames(values: string[]): Map<string, string> {
  const taken = new Set<string>([GROUND_NODE]);
  const names = new Map<string, string>();
  for (const value of values) {
    const wanted = scrub(value);
    let name = wanted;
    for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${wanted}_${n}`;
    taken.add(name.toUpperCase());
    names.set(value, name);
  }
  return names;
}

/** SPICE infers the device from the first letter, so a reference must carry the right one. */
const withPrefix = (letter: string) => (scrubbed: string) =>
  scrubbed.toUpperCase().startsWith(letter) ? scrubbed : letter + scrubbed;

const numeric = (value: number) => String(Number(value.toPrecision(12)));

/** AURA accepts sin(offset, amplitude, frequency) and pulse(low, high, frequency) only. */
function sourceCard(component: SchematicComponent, caveats: string[]): string {
  const waveform = component.value.trim().match(/^(sin|pulse)\(([^)]+)\)$/i);
  if (!waveform) {
    const dc = parseValue(component.value);
    if (!Number.isFinite(dc)) {
      caveats.push(`${component.id}: "${component.value}" is not a voltage this exporter understands; written as 0 V DC.`);
      return 'DC 0';
    }
    return `DC ${numeric(dc)}`;
  }
  const parts = waveform[2].split(/[\s,]+/).filter(Boolean).map(parseValue);
  if (parts.length !== 3 || parts.some(value => !Number.isFinite(value)) || parts[2] <= 0) {
    caveats.push(`${component.id}: "${component.value}" is not a valid waveform; written as 0 V DC.`);
    return 'DC 0';
  }
  const [first, second, frequency] = parts;
  if (waveform[1].toLowerCase() === 'sin') return `SIN(${numeric(first)} ${numeric(second)} ${numeric(frequency)})`;
  // AURA's pulse is an ideal 50% square wave. SPICE needs explicit timing, and a zero
  // edge is a convergence hazard, so the edges become 0.1% of the period.
  const period = 1 / frequency;
  caveats.push(`${component.id}: the ideal square wave became a SPICE PULSE with ${numeric(period / 1000)} s edges and 50% duty.`);
  return `PULSE(${numeric(first)} ${numeric(second)} 0 ${numeric(period / 1000)} ${numeric(period / 1000)} ${numeric(period / 2)} ${numeric(period)})`;
}

const OPAMP_SUBCKT = [
  '.subckt AURA_OPAMP inp inn out vpos vneg',
  '* AURA models the op-amp as an ideal differential amplifier of gain 1e5 whose output is',
  '* clamped to its supply pins. This subcircuit reproduces the gain but NOT the clamp, so a',
  '* saturating stage will swing past its rails here. The supply pins are tied off only to',
  '* keep them from floating.',
  'Eideal out 0 inp inn 1e5',
  'Rvpos vpos 0 1e12',
  'Rvneg vneg 0 1e12',
  '.ends AURA_OPAMP',
];

const TIMER_SUBCKT = [
  '.subckt AURA_555 gnd trig out rst ctrl thr dis vcc',
  '* PLACEHOLDER. AURA models the 555 behaviourally rather than structurally, and there is no',
  '* faithful short equivalent. This stub does nothing: it will not oscillate, and any timing',
  '* you obtain from it is meaningless. Replace it with a vendor 555 macromodel before',
  '* simulating this deck anywhere else.',
  'Rstub vcc gnd 1e12',
  '.ends AURA_555',
];

/**
 * Translate a captured schematic into a SPICE deck, reporting whatever could not be carried
 * across exactly. Values follow the built-in solver's own interpretation so the deck and the
 * in-app simulation describe the same circuit.
 */
export function exportSpiceNetlist(
  schematic: SchematicData,
  settings?: SimSettings,
  title = 'AURA-PCB circuit',
): SpiceExport {
  const caveats: string[] = [];
  // Recompute connectivity rather than trust whatever nets the caller happens to hold.
  const { schematic: resolved } = applyConnectivityNets(schematic, EMPTY_LAYOUT);
  const parts = resolved.components.filter(component => component.type !== 'gnd');

  const nets = [...new Set(resolved.components.flatMap(c => c.pins.map(p => p.net ?? '')))].filter(net => net && net !== 'GND');
  const nodes = uniqueNames(nets.sort());
  const nodeOf = (component: SchematicComponent, pinId: string) => {
    const net = component.pins.find(pin => pin.id === pinId)?.net;
    return !net || net === 'GND' ? GROUND_NODE : nodes.get(net) ?? GROUND_NODE;
  };

  const LETTERS: Partial<Record<SchematicComponent['type'], string>> = {
    resistor: 'R', capacitor: 'C', inductor: 'L', voltage_source: 'V',
    diode: 'D', led: 'D', transistor_npn: 'Q', opamp: 'X', timer555: 'X',
  };
  const claimed = new Set<string>();
  const references = new Map<string, string>();
  for (const component of parts) {
    const wanted = withPrefix(LETTERS[component.type] ?? 'X')(scrub(component.id));
    let name = wanted;
    for (let n = 2; claimed.has(name.toUpperCase()); n++) name = `${wanted}_${n}`;
    claimed.add(name.toUpperCase());
    references.set(component.id, name);
  }
  const ref = (component: SchematicComponent) => references.get(component.id) ?? scrub(component.id);

  const passive = (component: SchematicComponent, a: string, b: string) => {
    const value = parseValue(component.value);
    if (!Number.isFinite(value)) {
      caveats.push(`${component.id}: "${component.value}" is not a value this exporter understands; written as 0.`);
    }
    return `${ref(component)} ${nodeOf(component, a)} ${nodeOf(component, b)} ${Number.isFinite(value) ? numeric(value) : '0'}`;
  };

  // A missing pin would otherwise resolve to ground and silently short the device, so a
  // component that does not carry the pins its card needs is dropped and reported instead.
  const REQUIRED: Partial<Record<SchematicComponent['type'], string[]>> = {
    resistor: ['1', '2'], capacitor: ['1', '2'], inductor: ['1', '2'],
    voltage_source: ['p', 'n'], diode: ['a', 'c'], led: ['a', 'c'],
    transistor_npn: ['b', 'c', 'e'],
    opamp: ['in+', 'in-', 'out', 'v+', 'v-'],
    timer555: ['1', '2', '3', '4', '5', '6', '7', '8'],
  };

  const cards: string[] = [];
  const models = new Set<string>();
  const subcircuits = new Set<string>();

  for (const component of parts) {
    const absent = (REQUIRED[component.type] ?? []).filter(pinId => !component.pins.some(pin => pin.id === pinId));
    if (absent.length) {
      caveats.push(`${component.id}: pin(s) ${absent.join(', ')} are missing, so it was omitted rather than exported with those ends tied to ground.`);
      continue;
    }
    switch (component.type) {
      case 'resistor': case 'capacitor': case 'inductor':
        cards.push(passive(component, '1', '2'));
        break;
      case 'voltage_source':
        cards.push(`${ref(component)} ${nodeOf(component, 'p')} ${nodeOf(component, 'n')} ${sourceCard(component, caveats)}`);
        break;
      case 'diode':
        models.add('.model AURA_D D(IS=1e-14 N=1)');
        cards.push(`${ref(component)} ${nodeOf(component, 'a')} ${nodeOf(component, 'c')} AURA_D`);
        break;
      case 'led':
        // The solver runs the LED at Is=1e-18 and Vt=0.052, which is an ideality factor of 2.
        models.add('.model AURA_LED D(IS=1e-18 N=2)');
        cards.push(`${ref(component)} ${nodeOf(component, 'a')} ${nodeOf(component, 'c')} AURA_LED`);
        break;
      case 'transistor_npn':
        // The solver uses a fixed forward beta of 100 regardless of the stored parameter.
        models.add('.model AURA_NPN NPN(IS=1e-14 BF=100)');
        cards.push(`${ref(component)} ${nodeOf(component, 'c')} ${nodeOf(component, 'b')} ${nodeOf(component, 'e')} AURA_NPN`);
        break;
      case 'opamp':
        subcircuits.add('opamp');
        caveats.push(`${component.id}: the op-amp is behavioural in AURA. The exported subcircuit keeps the 1e5 gain but not the supply clamp.`);
        cards.push(`${ref(component)} ${['in+', 'in-', 'out', 'v+', 'v-'].map(pin => nodeOf(component, pin)).join(' ')} AURA_OPAMP`);
        break;
      case 'timer555':
        subcircuits.add('timer');
        caveats.push(`${component.id}: the 555 is behavioural in AURA and has no faithful equivalent. It is exported as an inert placeholder that will not oscillate.`);
        cards.push(`${ref(component)} ${['1', '2', '3', '4', '5', '6', '7', '8'].map(pin => nodeOf(component, pin)).join(' ')} AURA_555`);
        break;
      default:
        caveats.push(`${component.id}: "${component.type}" has no SPICE card in this exporter and was omitted.`);
    }
  }

  const dangling = resolved.components
    .flatMap(component => component.pins.map(pin => ({ component, pin })))
    .filter(({ pin }) => pin.net && pin.net !== 'GND' &&
      resolved.components.flatMap(c => c.pins).filter(other => other.net === pin.net).length < 2);
  if (dangling.length) {
    caveats.push(`${dangling.length} pin(s) connect to nothing else; SPICE will report them as floating nodes.`);
  }
  if (!resolved.components.some(component => component.type === 'gnd')) {
    caveats.push('This circuit has no ground. SPICE needs node 0 and will refuse a deck without it.');
  }

  const step = settings?.stepTime;
  const stop = settings?.stopTime;
  const analysis = Number.isFinite(step) && Number.isFinite(stop) && step! > 0 && stop! > 0
    ? `.tran ${numeric(step!)} ${numeric(stop!)}`
    : '.tran 1e-5 0.02';

  const netlist = [
    title,
    '* Generated by AURA-PCB. Device values follow the built-in solver, so this deck and the',
    '* in-app simulation describe the same circuit. Models below are AURA\'s own approximations,',
    '* not vendor parts; substitute real models before you rely on the result.',
    ...(caveats.length ? ['*', '* Translation notes:', ...caveats.map(note => `*   - ${note}`)] : []),
    '*',
    ...cards,
    ...(models.size ? ['', ...[...models].sort()] : []),
    ...(subcircuits.has('opamp') ? ['', ...OPAMP_SUBCKT] : []),
    ...(subcircuits.has('timer') ? ['', ...TIMER_SUBCKT] : []),
    '',
    analysis,
    '.end',
    '',
  ].join('\n');

  return { netlist, caveats };
}
