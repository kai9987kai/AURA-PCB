import type { ComponentType, Pad, Pin } from '../types/pcb';

export type PartCategory = 'passives' | 'actives' | 'ics' | 'sources';

export interface PartDefinition {
  label: string;
  description: string;
  symbol: string;
  category: PartCategory;
  /** Reference designator prefix: R1, C2, RV1. */
  prefix: string;
  /** Default value string, interpreted by the solver's own parseValue. */
  value: string;
  params: Record<string, number>;
  /** Schematic terminals. Ids must match the solver's requiredPins for the type. */
  pins: Pin[];
  /** Footprint lands, one per pin, with matching ids. */
  pads: Pad[];
  /** Footprint body outline in mm. */
  body: { width: number; height: number };
}

const pin = (id: string, label: string, relX: number, relY: number): Pin => ({ id, label, relX, relY });
const pad = (id: string, relX: number, relY: number, diameter: number, holeDiameter: number): Pad =>
  ({ id, relX, relY, diameter, holeDiameter });
/** Two terminals on a horizontal axis: the shape shared by every passive and every two-pin part. */
const axial = (a: string, aLabel: string, b: string, bLabel: string) => [pin(a, aLabel, -30, 0), pin(b, bLabel, 30, 0)];
const axialPads = (a: string, b: string, spacing: number, diameter = 1.6, drill = 0.8) =>
  [pad(a, -spacing, 0, diameter, drill), pad(b, spacing, 0, diameter, drill)];
/** TO-92 style: three lands on a 2.54mm row with the control terminal in the middle. */
const to92Pads = (left: string, middle: string, right: string) =>
  [pad(left, -1.27, -1.27, 1.4, 0.7), pad(middle, 0, 1.27, 1.4, 0.7), pad(right, 1.27, -1.27, 1.4, 0.7)];
const dipPad = (id: string, relX: number, relY: number) => pad(id, relX, relY, 1.5, 0.8);

/**
 * Every per-type fact about a part lives here: what the library shows, what it is called, what
 * it is worth, where its terminals are, and what it solders to. Six switch statements used to
 * hold these separately, which is how three component types ended up understood by the solver
 * but impossible to place on a board.
 *
 * Pin ids are load-bearing: they must match `requiredPins` in the SPICE solver, and every pin
 * needs a pad of the same id or the project validator rejects the footprint.
 */
export const PARTS: Record<ComponentType, PartDefinition> = {
  resistor: {
    label: 'Resistor', description: 'Passive resistor (R)', symbol: '电阻 R', category: 'passives',
    prefix: 'R', value: '10k', params: { resistance: 10000 },
    pins: axial('1', '1', '2', '2'), pads: axialPads('1', '2', 5.08), body: { width: 12, height: 4 },
  },
  capacitor: {
    label: 'Capacitor', description: 'Decoupling/Filter (C)', symbol: '电容 C', category: 'passives',
    prefix: 'C', value: '100n', params: { capacitance: 1e-7 },
    pins: axial('1', '1', '2', '2'), pads: axialPads('1', '2', 2.54), body: { width: 6, height: 6 },
  },
  inductor: {
    label: 'Inductor', description: 'Energy storage (L)', symbol: '电感 L', category: 'passives',
    prefix: 'L', value: '1m', params: { inductance: 1e-3 },
    pins: axial('1', '1', '2', '2'), pads: axialPads('1', '2', 5.08), body: { width: 12, height: 4 },
  },
  potentiometer: {
    label: 'Potentiometer', description: 'Adjustable divider (RV)', symbol: '电位器 RV', category: 'passives',
    prefix: 'RV', value: '10k', params: { resistance: 10000, position: 50 },
    // Pin 2 is the wiper, which the solver splits the track at.
    pins: [pin('1', '1', -30, 0), pin('2', 'W', 0, -25), pin('3', '3', 30, 0)],
    pads: [pad('1', -2.54, 0, 1.6, 0.8), pad('2', 0, 2.54, 1.6, 0.8), pad('3', 2.54, 0, 1.6, 0.8)],
    body: { width: 9, height: 8 },
  },
  voltage_source: {
    label: 'Voltage Source', description: 'DC/AC Power', symbol: '电源 Vcc', category: 'sources',
    prefix: 'V', value: '5V', params: {},
    pins: [pin('p', '+', -22, 0), pin('n', '-', 22, 0)],
    pads: axialPads('p', 'n', 2.54, 1.8, 0.9), body: { width: 6, height: 6 },
  },
  gnd: {
    label: 'Ground', description: 'Reference Node (0V)', symbol: '地 GND', category: 'sources',
    prefix: 'GND', value: 'GND', params: {},
    pins: [pin('gnd', 'GND', 0, 0)], pads: [pad('gnd', 0, 0, 1.8, 0.9)], body: { width: 6, height: 6 },
  },
  diode: {
    label: 'Diode', description: 'Silicon Diode (D)', symbol: '二极管 D', category: 'actives',
    prefix: 'D', value: '1N4148', params: {},
    pins: axial('a', 'A', 'c', 'C'), pads: axialPads('a', 'c', 3.81), body: { width: 9, height: 4 },
  },
  zener: {
    label: 'Zener Diode', description: 'Voltage reference (D)', symbol: '稳压管 ZD', category: 'actives',
    // The solver reads the breakdown voltage straight off the value string.
    prefix: 'D', value: '5.1V', params: {},
    pins: axial('a', 'A', 'c', 'C'), pads: axialPads('a', 'c', 3.81), body: { width: 9, height: 4 },
  },
  led: {
    label: 'LED', description: 'Light Emitting Diode', symbol: '发光二极管 LED', category: 'actives',
    prefix: 'LED', value: 'Red', params: {},
    pins: axial('a', 'A', 'c', 'C'), pads: axialPads('a', 'c', 3.81), body: { width: 9, height: 4 },
  },
  transistor_npn: {
    label: 'NPN Transistor', description: 'BJT Transistor (Q)', symbol: '三极管 NPN', category: 'actives',
    prefix: 'Q', value: 'BC547', params: {},
    pins: [pin('b', 'B', -30, 0), pin('c', 'C', 20, 15), pin('e', 'E', 20, -15)],
    pads: to92Pads('e', 'b', 'c'), body: { width: 5, height: 5 },
  },
  mosfet_n: {
    label: 'N-MOSFET', description: 'Enhancement mode (M)', symbol: '场效应管 MOS', category: 'actives',
    prefix: 'M', value: '2N7000', params: { vth: 2, kn: 0.05 },
    pins: [pin('g', 'G', -30, 0), pin('d', 'D', 20, -20), pin('s', 'S', 20, 20)],
    // TO-92 MOSFETs put the gate in the middle, between source and drain.
    pads: to92Pads('s', 'g', 'd'), body: { width: 5, height: 5 },
  },
  opamp: {
    label: 'Op-Amp', description: 'Operational Amplifier (U)', symbol: '运放 Op-Amp', category: 'ics',
    prefix: 'U', value: 'LM358', params: {},
    pins: [pin('in-', 'IN-', -40, -15), pin('in+', 'IN+', -40, 15), pin('out', 'OUT', 40, 0),
      pin('v+', 'V+', 0, -25), pin('v-', 'V-', 0, 25)],
    pads: [dipPad('in-', -3.81, -1.27), dipPad('in+', -3.81, 1.27), dipPad('v-', -3.81, 3.81),
      dipPad('out', 3.81, -1.27), dipPad('v+', 3.81, 3.81)],
    body: { width: 10, height: 10 },
  },
  timer555: {
    label: '555 Timer', description: 'Mixed-Signal Astable (IC)', symbol: '555 定时器', category: 'ics',
    prefix: 'IC', value: '555', params: {},
    pins: [pin('1', 'GND', -50, -30), pin('2', 'TRIG', -50, -10), pin('3', 'OUT', 50, -30),
      pin('4', 'RST', -50, 10), pin('5', 'CTRL', -50, 30), pin('6', 'THR', 50, -10),
      pin('7', 'DIS', 50, 10), pin('8', 'VCC', 50, 30)],
    pads: [dipPad('1', -3.81, -3.81), dipPad('2', -3.81, -1.27), dipPad('3', -3.81, 1.27),
      dipPad('4', -3.81, 3.81), dipPad('5', 3.81, 3.81), dipPad('6', 3.81, 1.27),
      dipPad('7', 3.81, -1.27), dipPad('8', 3.81, -3.81)],
    body: { width: 10, height: 10 },
  },
};

/** Library order, which is the order these are declared above. */
export const PART_TYPES = Object.keys(PARTS) as ComponentType[];

// Fresh copies: a placed component must never alias the table it came from.
export const partPins = (type: ComponentType): Pin[] => PARTS[type].pins.map(source => ({ ...source }));
export const partPads = (type: ComponentType): Pad[] => PARTS[type].pads.map(source => ({ ...source }));
export const partBody = (type: ComponentType) => ({ ...PARTS[type].body });
