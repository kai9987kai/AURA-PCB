export type ComponentType =
  | 'resistor'
  | 'capacitor'
  | 'inductor'
  | 'voltage_source'
  | 'gnd'
  | 'diode'
  | 'led'
  | 'transistor_npn'
  | 'opamp'
  | 'timer555'
  | 'mosfet_n'
  | 'zener'
  | 'potentiometer';

export interface Pin {
  id: string; // e.g. "1", "2", "out", "in+", "vcc"
  label: string;
  relX: number; // position relative to component center (schematic coordinate system)
  relY: number;
  net?: string; // name of the net it belongs to
}

export interface SchematicComponent {
  id: string; // unique ID, e.g. "R1", "C2"
  type: ComponentType;
  name: string; // display name, e.g. "R1", "555 Timer"
  value: string; // value string, e.g. "10k", "100n", "5V"
  x: number; // schematic x coordinate
  y: number; // schematic y coordinate
  rotation: number; // 0, 90, 180, 270 degrees
  pins: Pin[];
  params: Record<string, number>; // parsed numeric parameters, e.g. { resistance: 10000 }
}

export interface Wire {
  id: string;
  fromCompId: string;
  fromPinId: string;
  toCompId: string;
  toPinId: string;
  points: { x: number; y: number }[]; // routing corners
  net: string;
}

export interface SchematicData {
  components: SchematicComponent[];
  wires: Wire[];
}

export interface Pad {
  id: string; // matching schematic pin id
  relX: number; // relative to component center in mm
  relY: number;
  diameter: number; // pad diameter in mm
  holeDiameter: number; // hole diameter in mm (0 for SMD)
  net?: string; // net name
}

export interface PCBFootprint {
  id: string; // matches SchematicComponent id (e.g. "R1")
  componentId: string;
  type: ComponentType;
  x: number; // board x in mm
  y: number; // board y in mm
  rotation: number; // degrees
  width: number; // outline width in mm
  height: number; // outline height in mm
  pads: Pad[];
  isPlaced: boolean;
}

export interface PCBTrace {
  id: string;
  net: string;
  points: { x: number; y: number }[]; // trace route in mm
  width: number; // mm
  layer: 'top' | 'bottom';
}

export interface PCBVia {
  id: string;
  x: number;
  y: number;
  net: string;
  diameter: number;
  drillDiameter: number;
}

export interface PCBLayoutData {
  boardWidth: number; // in mm
  boardHeight: number; // in mm
  footprints: PCBFootprint[];
  traces: PCBTrace[];
  vias: PCBVia[];
}

export interface SimResult {
  timepoints: number[];
  nodes: string[];
  voltages: Record<string, number[]>; // nodeName -> voltage values
  currents: Record<string, number[]>; // componentId/branchName -> current values
  powerDissipation: Record<string, number>; // componentId -> average power in Watts
  errorMessage?: string;
}

export interface SimSettings {
  type: 'transient' | 'dc_sweep';
  stopTime: number; // for transient, e.g. 0.05 seconds
  stepTime: number; // e.g. 1e-5 seconds
  sweepSource?: string; // for dc sweep
  sweepStart?: number;
  sweepStop?: number;
  sweepStep?: number;
}

export interface ThermalGrid {
  widthCells: number;
  heightCells: number;
  cellSizeMm: number;
  temperatures: Float32Array; // 1D representation of 2D grid
}

export interface SignalIntegrityReport {
  traceId: string;
  netName: string;
  impedance: number; // ohms
  propagationDelay: number; // ns
  reflectionCoefficientSource: number;
  reflectionCoefficientLoad: number;
  crosstalkPeakVoltage: number; // mV
  ringingFrequency?: number; // GHz
  suggestions: string[];
}

export interface EyeDiagramData {
  timeOffsetNs: number[]; // time modulo 2*bitPeriod
  traces: { timeNs: number[]; voltage: number[] }[];
  bitPeriodNs: number;
  eyeHeightMv: number;
  eyeWidthNs: number;
  jitterPs: number;
  noiseMarginPercent: number;
}

export interface FFTSpectrumData {
  frequenciesHz: number[];
  magnitudesDb: number[];
  fundamentalFreqHz: number;
  peakMagnitudeDb: number;
  thdPercent: number;
}

export interface ThermalProbe {
  id: string;
  x: number;
  y: number;
  tempC: number;
}

