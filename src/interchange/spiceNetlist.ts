import type { ComponentType, SchematicComponent, SchematicData, SimSettings, Wire } from '../types/pcb';
import { parseValue } from '../simulation/spiceSolver';
import { applyConnectivityNets } from '../project/connectivity';
import { PARTS, partPins } from '../project/parts';

export interface SpiceExport {
  netlist: string;
  /** Everything that did not survive the translation exactly, for the caller to surface. */
  caveats: string[];
}

const EMPTY_LAYOUT = { boardWidth: 0, boardHeight: 0, footprints: [], traces: [], vias: [], pours: [] };
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
    diode: 'D', led: 'D', zener: 'D', transistor_npn: 'Q', mosfet_n: 'M',
    potentiometer: 'R', opamp: 'X', timer555: 'X',
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
  /** For parts that need more than one card, so the extra names cannot collide with a device. */
  const claimRef = (base: string) => {
    let name = base;
    for (let n = 2; claimed.has(name.toUpperCase()); n++) name = `${base}_${n}`;
    claimed.add(name.toUpperCase());
    return name;
  };

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
    transistor_npn: ['b', 'c', 'e'], zener: ['a', 'c'], mosfet_n: ['g', 'd', 's'],
    potentiometer: ['1', '2', '3'],
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
      case 'zener': {
        // The solver reads the breakdown voltage off the value string and falls back to 5.1 V.
        const stated = parseValue(component.value);
        const breakdown = Number.isFinite(stated) && stated > 0 ? stated : 5.1;
        const model = `AURA_ZD_${numeric(breakdown).replace(/[^0-9]+/g, '_')}`;
        models.add(`.model ${model} D(IS=1e-14 N=1 BV=${numeric(breakdown)})`);
        cards.push(`${ref(component)} ${nodeOf(component, 'a')} ${nodeOf(component, 'c')} ${model}`);
        break;
      }
      case 'mosfet_n': {
        const threshold = component.params.vth ?? 2;
        const transconductance = component.params.kn ?? 0.05;
        const model = `AURA_NMOS_${`${numeric(threshold)}_${numeric(transconductance)}`.replace(/[^0-9]+/g, '_')}`;
        models.add(`.model ${model} NMOS(VTO=${numeric(threshold)} KP=${numeric(transconductance)})`);
        // A SPICE MOSFET takes four nodes. This model carries no separate bulk, so it ties to
        // the source, which is what a discrete part does anyway.
        const source = nodeOf(component, 's');
        cards.push(`${ref(component)} ${nodeOf(component, 'd')} ${nodeOf(component, 'g')} ${source} ${source} ${model}`);
        break;
      }
      case 'potentiometer': {
        const stated = parseValue(component.value);
        const track = Number.isFinite(stated) && stated > 0 ? stated : 10000;
        const wiper = Math.max(0.01, Math.min(0.99, (component.params.position ?? 50) / 100));
        // One track split at the wiper into two resistors, exactly as the solver stamps it.
        cards.push(`${claimRef(`${ref(component)}A`)} ${nodeOf(component, '1')} ${nodeOf(component, '2')} ${numeric(Math.max(0.1, track * wiper))}`);
        cards.push(`${claimRef(`${ref(component)}B`)} ${nodeOf(component, '2')} ${nodeOf(component, '3')} ${numeric(Math.max(0.1, track * (1 - wiper)))}`);
        break;
      }
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

// --- Import ----------------------------------------------------------------

export interface SpiceImport {
  schematic: SchematicData;
  /** Everything skipped or approximated, so nothing is lost without being said. */
  warnings: string[];
}

const MAX_NETLIST_BYTES = 512_000;
const MAX_LINE_LENGTH = 4096;
const MAX_DEVICES = 128;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** Device letter to the part this project models, and how many nodes its card carries. */
const CARDS: Record<string, { type: ComponentType; nodes: number }> = {
  R: { type: 'resistor', nodes: 2 }, C: { type: 'capacitor', nodes: 2 }, L: { type: 'inductor', nodes: 2 },
  V: { type: 'voltage_source', nodes: 2 }, D: { type: 'diode', nodes: 2 },
  Q: { type: 'transistor_npn', nodes: 3 }, M: { type: 'mosfet_n', nodes: 4 },
};
/** Subcircuits this project emits itself, so its own decks come back whole. */
const SUBCIRCUITS: Record<string, { type: ComponentType; pins: string[] }> = {
  AURA_OPAMP: { type: 'opamp', pins: ['in+', 'in-', 'out', 'v+', 'v-'] },
  AURA_555: { type: 'timer555', pins: ['1', '2', '3', '4', '5', '6', '7', '8'] },
};

const identifier = (raw: string, fallback: string) => {
  const cleaned = raw.replace(/[^\w.+-]/g, '_').slice(0, 60);
  return cleaned && !RESERVED.has(cleaned) ? cleaned : fallback;
};

/** A SPICE source carries more than this project models; name whatever is dropped. */
function readSource(rest: string[], name: string, warnings: string[]): string {
  const text = rest.join(' ').trim();
  const wave = /^(SIN|PULSE)\s*\(([^)]*)\)$/i.exec(text);
  if (wave) {
    const args = wave[2].split(/[\s,]+/).filter(Boolean).map(parseValue);
    if (!args.length || args.some(value => !Number.isFinite(value))) {
      warnings.push(`${name}: could not read "${text}"; imported as 0 V DC.`);
      return '0';
    }
    if (wave[1].toUpperCase() === 'SIN') {
      if (args.length < 3) {
        warnings.push(`${name}: SIN needs an offset, amplitude and frequency; imported as 0 V DC.`);
        return '0';
      }
      if (args.length > 3) warnings.push(`${name}: SIN delay, damping and phase are not modelled and were dropped.`);
      return `sin(${numeric(args[0])},${numeric(args[1])},${numeric(args[2])})`;
    }
    // PULSE(v1 v2 td tr tf pw per). This project models an ideal 50% square at one frequency.
    if (args.length < 7 || !(args[6] > 0)) {
      warnings.push(`${name}: PULSE needs a period to become a frequency; imported as 0 V DC.`);
      return '0';
    }
    warnings.push(`${name}: PULSE delay, edge rates and duty are not modelled; imported as an ideal 50% square wave.`);
    return `pulse(${numeric(args[0])},${numeric(args[1])},${numeric(1 / args[6])})`;
  }
  if (/^AC\b/i.test(text)) warnings.push(`${name}: AC analysis is not supported; only the DC level was kept.`);
  const dc = text.replace(/^DC\s+/i, '').split(/\s+/)[0] ?? '';
  if (!Number.isFinite(parseValue(dc))) {
    warnings.push(`${name}: "${text}" is not a source this project models; imported as 0 V DC.`);
    return '0';
  }
  return dc;
}

/** Fold comments and continuations away, leaving one card per entry. */
function logicalLines(text: string): { text: string; line: number }[] {
  const lines: { text: string; line: number }[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.length > MAX_LINE_LENGTH) throw new Error(`Line ${index + 1} exceeds ${MAX_LINE_LENGTH} characters.`);
    const stripped = raw.replace(/;.*$/, '').trim();
    if (!stripped || stripped.startsWith('*')) return;
    if (stripped.startsWith('+') && lines.length) {
      lines[lines.length - 1].text += ` ${stripped.slice(1).trim()}`;
      return;
    }
    lines.push({ text: stripped, line: index + 1 });
  });
  return lines;
}

/** Definition bodies and simulator commands are not top-level devices. */
function topLevelLines(lines: ReturnType<typeof logicalLines>, warnings: string[]) {
  const top: typeof lines = [];
  let subcircuitDepth = 0;
  let controlLine = 0;
  for (const card of lines) {
    const command = card.text.split(/\s+/)[0].toLowerCase();
    if (controlLine) {
      if (command === '.endc') controlLine = 0;
      continue;
    }
    if (command === '.control') {
      controlLine = card.line;
      warnings.push(`Line ${card.line}: .control commands are not executed and the entire block was skipped.`);
      continue;
    }
    if (command === '.subckt') {
      subcircuitDepth++;
      const name = card.text.split(/\s+/)[1] ?? '(unnamed)';
      if (!Object.hasOwn(SUBCIRCUITS, name.toUpperCase())) {
        warnings.push(`Line ${card.line}: subcircuit definition "${name}" is not evaluated; its body was skipped.`);
      }
      continue;
    }
    if (command === '.ends') {
      if (!subcircuitDepth) throw new Error(`Line ${card.line}: .ends has no matching .subckt.`);
      subcircuitDepth--;
      continue;
    }
    if (command === '.end') break;
    if (!subcircuitDepth) top.push(card);
  }
  if (subcircuitDepth) throw new Error('Unterminated .subckt definition. No partial circuit was imported.');
  if (controlLine) throw new Error(`Unterminated .control block at line ${controlLine}.`);
  return top;
}

/**
 * Read a SPICE deck back into a schematic this project can edit and simulate.
 *
 * The input is treated as hostile: it is bounded, every name is scrubbed before it reaches an
 * object key, and anything not understood is reported rather than guessed at. Devices this
 * project has no model for are skipped with a warning instead of being approximated into
 * something that would simulate but mean nothing.
 */
export function importSpiceNetlist(text: string): SpiceImport {
  if (new TextEncoder().encode(text).length > MAX_NETLIST_BYTES) {
    throw new Error(`Netlists are limited to ${MAX_NETLIST_BYTES / 1000} KB.`);
  }
  const warnings: string[] = [];
  const lines = topLevelLines(logicalLines(text), warnings);
  if (!lines.length) throw new Error('That file contains no SPICE cards.');

  // Models are read first because a device card can reference one declared after it.
  const models = new Map<string, { kind: string; params: Map<string, number> }>();
  for (const { text: line } of lines) {
    const model = /^\.model\s+(\S+)\s+([A-Za-z]+)\s*(.*)$/i.exec(line);
    if (!model) continue;
    const params = new Map<string, number>();
    for (const [, key, value] of model[3].matchAll(/([A-Za-z]+)\s*=\s*([^\s,()]+)/g)) {
      const parsed = parseValue(value);
      if (Number.isFinite(parsed)) params.set(key.toUpperCase(), parsed);
    }
    models.set(model[1].toUpperCase(), { kind: model[2].toUpperCase(), params });
  }

  interface Device { id: string; type: ComponentType; value: string; params: Record<string, number>; nodes: string[]; pins: string[] }
  const devices: Device[] = [];
  const usedIds = new Set<string>();
  const claim = (raw: string, fallback: string) => {
    const base = identifier(raw, fallback);
    let id = base;
    for (let n = 2; usedIds.has(id.toUpperCase()); n++) id = `${base}_${n}`;
    usedIds.add(id.toUpperCase());
    return id;
  };

  lines.forEach(({ text: line, line: lineNumber }, index) => {
    if (line.startsWith('.')) {
      if (/^\.(model|tran|title|options|option|op|probe|print|plot|width|temp)\b/i.test(line)) return;
      warnings.push(`Line ${lineNumber}: "${line.split(/\s+/)[0]}" is not supported and was ignored.`);
      return;
    }
    const parts = line.split(/\s+/);
    const name = parts[0];
    const letter = name[0]?.toUpperCase() ?? '';
    const rest = parts.slice(1);
    const shape = CARDS[letter];

    // SPICE reads the first line of a deck as its title, whatever it says, and so does this.
    // The one concession is that a first line which validates strictly as an R, C, L or V
    // card is kept, since those can be checked numerically. Prose beginning with a device
    // letter ("RC filter", "Voltage divider", "Common emitter") is far too common to warn on.
    if (index === 0) {
      const tail = shape ? rest.slice(shape.nodes) : [];
      const strict = letter === 'X'
        ? rest.length >= 2 && Object.hasOwn(SUBCIRCUITS, rest.at(-1)?.toUpperCase() ?? '')
        : Boolean(shape) && rest.length > (shape?.nodes ?? 0) && (
          'RCL'.includes(letter) ? Number.isFinite(parseValue(tail[0] ?? ''))
            : letter === 'V' ? /^(DC\b|AC\b|SIN\b|PULSE\b|[+-]?[\d.])/i.test(tail.join(' '))
              : false);
      if (!strict) return;
    }

    if (letter === 'X') {
      const subcircuitName = rest.at(-1)?.toUpperCase() ?? '';
      const subcircuit = Object.hasOwn(SUBCIRCUITS, subcircuitName) ? SUBCIRCUITS[subcircuitName] : undefined;
      if (!subcircuit) {
        warnings.push(`Line ${lineNumber}: subcircuit "${rest.at(-1) ?? name}" has no model here and was skipped.`);
        return;
      }
      const nodes = rest.slice(0, -1).map(node => node.toUpperCase());
      if (nodes.length !== subcircuit.pins.length) {
        warnings.push(`Line ${lineNumber}: ${name} has ${nodes.length} nodes, expected ${subcircuit.pins.length}; skipped.`);
        return;
      }
      warnings.push(`${name}: imported as AURA's built-in ${subcircuit.type} behaviour; the subcircuit implementation is not evaluated.`);
      devices.push({ id: claim(name, `X${devices.length + 1}`), type: subcircuit.type, value: PARTS[subcircuit.type].value, params: {}, nodes, pins: subcircuit.pins });
      return;
    }

    if (!shape) {
      warnings.push(`Line ${lineNumber}: "${name}" is not a device this project models and was skipped.`);
      return;
    }
    if (rest.length < shape.nodes) {
      warnings.push(`Line ${lineNumber}: ${name} needs ${shape.nodes} nodes; skipped.`);
      return;
    }
    const nodes = rest.slice(0, shape.nodes).map(node => node.toUpperCase());
    const tail = rest.slice(shape.nodes);
    let type = shape.type;
    let value = PARTS[type].value;
    const params: Record<string, number> = { ...PARTS[type].params };

    if ('DQM'.includes(letter)) {
      const modelName = tail[0]?.toUpperCase() ?? '';
      const model = models.get(modelName);
      const expected = letter === 'D' ? 'D' : letter === 'Q' ? 'NPN' : 'NMOS';
      if (!model || model.kind !== expected) {
        warnings.push(`Line ${lineNumber}: ${name} model "${tail[0] ?? '(missing)'}" ${model ? `is ${model.kind}, which this device importer does not model` : 'is not defined'}; skipped.`);
        return;
      }
      if (!modelName.startsWith('AURA_')) {
        warnings.push(`${name}: imported with AURA's simplified ${expected} approximation; vendor model behaviour and unsupported parameters are not preserved.`);
      }
    }

    if (letter === 'R' || letter === 'C' || letter === 'L') {
      const parsed = parseValue(tail[0] ?? '');
      if (!Number.isFinite(parsed) || parsed <= 0) {
        warnings.push(`Line ${lineNumber}: ${name} has no readable value; imported as ${value}.`);
      } else {
        value = tail[0];
      }
    } else if (letter === 'V') {
      value = readSource(tail, name, warnings);
    } else if (letter === 'D') {
      const modelName = tail[0]?.toUpperCase() ?? '';
      const breakdown = models.get(modelName)?.params.get('BV');
      // A diode with a breakdown voltage is a zener, which this project models separately.
      if (breakdown && breakdown > 0) { type = 'zener'; value = `${numeric(breakdown)}V`; }
      else if (modelName === 'AURA_LED') { type = 'led'; value = PARTS.led.value; }
      // This project's own model names describe its solver, not a part, so they are not values.
      else if (tail[0] && !modelName.startsWith('AURA_')) value = tail[0];
    } else if (letter === 'Q') {
      if (tail[0] && !tail[0].toUpperCase().startsWith('AURA_')) value = tail[0];
    } else if (letter === 'M') {
      const model = models.get(tail[0]?.toUpperCase() ?? '');
      if (tail[0] && !tail[0].toUpperCase().startsWith('AURA_')) value = tail[0];
      const threshold = model?.params.get('VTO');
      const transconductance = model?.params.get('KP');
      if (threshold !== undefined) params.vth = threshold;
      if (transconductance !== undefined) params.kn = transconductance;
      // A SPICE MOSFET has a bulk node this project does not model.
      if (nodes[3] !== nodes[2]) warnings.push(`${name}: the bulk node is not modelled and was tied to the source.`);
    }

    // Card order is the SPICE convention: Q is collector, base, emitter; M is drain, gate,
    // source, bulk. Every other part reads its nodes in the order the library lists its pins.
    const pins = letter === 'Q' ? ['c', 'b', 'e'] : letter === 'M' ? ['d', 'g', 's'] : PARTS[type].pins.map(pin => pin.id);
    devices.push({ id: claim(name, `${letter}${devices.length + 1}`), type, value, params, nodes: nodes.slice(0, pins.length), pins });
  });

  if (!devices.length) throw new Error('No devices in that netlist could be imported.');
  if (devices.length > MAX_DEVICES) throw new Error(`Netlists are limited to ${MAX_DEVICES} devices.`);

  // Lay the circuit out on a readable grid; the user can arrange it properly afterwards.
  const COLUMNS = 6;
  const SPACING_X = 170;
  const SPACING_Y = 150;
  const components: SchematicComponent[] = devices.map((device, index) => ({
    id: device.id, type: device.type, name: device.id, value: device.value,
    x: 140 + (index % COLUMNS) * SPACING_X,
    y: 140 + Math.floor(index / COLUMNS) * SPACING_Y,
    rotation: 0, pins: partPins(device.type), params: device.params,
  }));

  const wires: Wire[] = [];
  const byNode = new Map<string, { compId: string; pinId: string }[]>();
  devices.forEach(device => device.pins.forEach((pinId, position) => {
    const node = device.nodes[position];
    if (node === undefined) return;
    byNode.set(node, [...(byNode.get(node) ?? []), { compId: device.id, pinId }]);
  }));

  let grounds = 0;
  for (const [node, terminals] of byNode) {
    if (node === '0') {
      // Every grounded terminal gets its own symbol, the way the reference circuits are drawn.
      for (const terminal of terminals) {
        const owner = components.find(component => component.id === terminal.compId);
        const id = claim(`GND${++grounds}`, `GND_${grounds}`);
        components.push({
          id, type: 'gnd', name: id, value: PARTS.gnd.value,
          x: owner ? owner.x : 140, y: owner ? owner.y + 90 : 140,
          rotation: 0, pins: partPins('gnd'), params: {},
        });
        wires.push({ id: `w${wires.length + 1}`, fromCompId: terminal.compId, fromPinId: terminal.pinId, toCompId: id, toPinId: 'gnd', points: [], net: '' });
      }
      continue;
    }
    // A star from the first terminal is the fewest wires that put a whole node on one net.
    for (const terminal of terminals.slice(1)) {
      wires.push({ id: `w${wires.length + 1}`, fromCompId: terminals[0].compId, fromPinId: terminals[0].pinId, toCompId: terminal.compId, toPinId: terminal.pinId, points: [], net: '' });
    }
  }

  if (!grounds) warnings.push('This deck has no node 0, so no ground was created. Simulation needs one.');

  // Give every wire the same orthogonal route the editor draws by hand, so the imported
  // schematic is readable at once rather than a web of diagonals.
  const pinAt = (componentId: string, pinId: string) => {
    const component = components.find(candidate => candidate.id === componentId);
    const pin = component?.pins.find(candidate => candidate.id === pinId);
    return component && pin ? { x: component.x + pin.relX, y: component.y + pin.relY } : null;
  };
  for (const link of wires) {
    const start = pinAt(link.fromCompId, link.fromPinId);
    const end = pinAt(link.toCompId, link.toPinId);
    if (start && end) link.points = [start, { x: end.x, y: start.y }, end];
  }
  return { schematic: { components, wires }, warnings };
}
