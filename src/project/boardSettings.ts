import type { PCBLayoutData, SignalModelSettings } from '../types/pcb';

export const DEFAULT_SIGNAL_MODEL: Readonly<SignalModelSettings> = Object.freeze({
  substrateHeightMm: 1.6, dielectricConstant: 4.5, copperThicknessUm: 35,
  riseTimeNs: 0.5, sourceImpedanceOhms: 50, loadImpedanceOhms: 10000,
});

export const SIGNAL_FIELDS = [
  { key: 'substrateHeightMm', label: 'Plane distance (mm)', min: 0.01, max: 10 },
  { key: 'dielectricConstant', label: 'Dielectric constant', min: 1, max: 20 },
  { key: 'copperThicknessUm', label: 'Copper thickness (um)', min: 0, max: 200 },
  { key: 'riseTimeNs', label: 'Rise time (ns)', min: 0.001, max: 1000 },
  { key: 'sourceImpedanceOhms', label: 'Source impedance (ohm)', min: 0, max: 1e6 },
  { key: 'loadImpedanceOhms', label: 'Load impedance (ohm)', min: 0.001, max: 1e9 },
] as const;

export function parseSignalModel(input: unknown): SignalModelSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Signal model must contain all six numeric inputs.');
  const values = input as Record<string, unknown>;
  const result = {} as SignalModelSettings;
  for (const field of SIGNAL_FIELDS) {
    const value = values[field.key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) {
      throw new Error(`${field.label} must be between ${field.min} and ${field.max}.`);
    }
    result[field.key] = value;
  }
  return result;
}

export function signalModelFor(layout: PCBLayoutData): SignalModelSettings {
  return layout.signalModel ? parseSignalModel(layout.signalModel) : { ...DEFAULT_SIGNAL_MODEL };
}

export function resizeBoard(layout: PCBLayoutData, width: number, height: number): PCBLayoutData {
  for (const [label, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isFinite(value) || value < 10 || value > 500) throw new Error(`Board ${label} must be between 10 and 500 mm.`);
  }
  return { ...layout, boardWidth: width, boardHeight: height };
}
