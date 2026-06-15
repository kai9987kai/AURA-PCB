import { useState, useMemo } from 'react';
import type { SchematicData, PCBLayoutData, SimResult, SchematicComponent, Wire, ComponentType, Pin, Pad, PCBFootprint } from './types/pcb';
import { Sidebar } from './components/Sidebar';
import { SchematicEditor } from './components/SchematicEditor';
import { LayoutEditor } from './components/LayoutEditor';
import { SimulationPanel } from './components/SimulationPanel';
import { ThermalPanel } from './components/ThermalPanel';
import { SignalIntegrityPanel } from './components/SignalIntegrityPanel';
import { ThreeDPCBViewer } from './components/ThreeDPCBViewer';
import { ResearchPanel } from './components/ResearchPanel';
import { Activity, Edit3, Compass, Cpu, Thermometer, Zap } from 'lucide-react';

// Default pins configuration for components
const getPinsForType = (type: ComponentType): Pin[] => {
  switch (type) {
    case 'resistor':
    case 'capacitor':
    case 'inductor':
      return [
        { id: '1', label: '1', relX: -30, relY: 0 },
        { id: '2', label: '2', relX: 30, relY: 0 }
      ];
    case 'diode':
    case 'led':
      return [
        { id: 'a', label: 'A', relX: -30, relY: 0 },
        { id: 'c', label: 'C', relX: 30, relY: 0 }
      ];
    case 'voltage_source':
      return [
        { id: 'p', label: '+', relX: -22, relY: 0 },
        { id: 'n', label: '-', relX: 22, relY: 0 }
      ];
    case 'gnd':
      return [
        { id: 'gnd', label: 'GND', relX: 0, relY: 0 }
      ];
    case 'transistor_npn':
      return [
        { id: 'b', label: 'B', relX: -30, relY: 0 },
        { id: 'c', label: 'C', relX: 20, relY: 15 },
        { id: 'e', label: 'E', relX: 20, relY: -15 }
      ];
    case 'opamp':
      return [
        { id: 'in-', label: 'IN-', relX: -40, relY: -15 },
        { id: 'in+', label: 'IN+', relX: -40, relY: 15 },
        { id: 'out', label: 'OUT', relX: 40, relY: 0 },
        { id: 'v+', label: 'V+', relX: 0, relY: -25 },
        { id: 'v-', label: 'V-', relX: 0, relY: 25 }
      ];
    case 'timer555':
      return [
        { id: '1', label: 'GND', relX: -50, relY: -30 },
        { id: '2', label: 'TRIG', relX: -50, relY: -10 },
        { id: '3', label: 'OUT', relX: 50, relY: -30 },
        { id: '4', label: 'RST', relX: -50, relY: 10 },
        { id: '5', label: 'CTRL', relX: -50, relY: 30 },
        { id: '6', label: 'THR', relX: 50, relY: -10 },
        { id: '7', label: 'DIS', relX: 50, relY: 10 },
        { id: '8', label: 'VCC', relX: 50, relY: 30 }
      ];
    default:
      return [];
  }
};

// Default pads configuration for PCB layout footprints
const getPadsForType = (type: ComponentType): Pad[] => {
  switch (type) {
    case 'resistor':
    case 'inductor':
      return [
        { id: '1', relX: -5.08, relY: 0, diameter: 1.6, holeDiameter: 0.8 },
        { id: '2', relX: 5.08, relY: 0, diameter: 1.6, holeDiameter: 0.8 }
      ];
    case 'capacitor':
      return [
        { id: '1', relX: -2.54, relY: 0, diameter: 1.6, holeDiameter: 0.8 },
        { id: '2', relX: 2.54, relY: 0, diameter: 1.6, holeDiameter: 0.8 }
      ];
    case 'diode':
    case 'led':
      return [
        { id: 'a', relX: -3.81, relY: 0, diameter: 1.6, holeDiameter: 0.8 },
        { id: 'c', relX: 3.81, relY: 0, diameter: 1.6, holeDiameter: 0.8 }
      ];
    case 'voltage_source':
      return [
        { id: 'p', relX: -2.54, relY: 0, diameter: 1.8, holeDiameter: 0.9 },
        { id: 'n', relX: 2.54, relY: 0, diameter: 1.8, holeDiameter: 0.9 }
      ];
    case 'gnd':
      return [
        { id: 'gnd', relX: 0, relY: 0, diameter: 1.8, holeDiameter: 0.9 }
      ];
    case 'transistor_npn':
      return [
        { id: 'e', relX: -1.27, relY: -1.27, diameter: 1.4, holeDiameter: 0.7 },
        { id: 'b', relX: 0, relY: 1.27, diameter: 1.4, holeDiameter: 0.7 },
        { id: 'c', relX: 1.27, relY: -1.27, diameter: 1.4, holeDiameter: 0.7 }
      ];
    case 'opamp':
      return [
        { id: 'in-', relX: -3.81, relY: -1.27, diameter: 1.5, holeDiameter: 0.8 }, // pin 2
        { id: 'in+', relX: -3.81, relY: 1.27, diameter: 1.5, holeDiameter: 0.8 },  // pin 3
        { id: 'v-', relX: -3.81, relY: 3.81, diameter: 1.5, holeDiameter: 0.8 },   // pin 4
        { id: 'out', relX: 3.81, relY: -1.27, diameter: 1.5, holeDiameter: 0.8 },  // pin 6
        { id: 'v+', relX: 3.81, relY: 3.81, diameter: 1.5, holeDiameter: 0.8 }     // pin 7
      ];
    case 'timer555':
      return [
        { id: '1', relX: -3.81, relY: -3.81, diameter: 1.5, holeDiameter: 0.8 },
        { id: '2', relX: -3.81, relY: -1.27, diameter: 1.5, holeDiameter: 0.8 },
        { id: '3', relX: -3.81, relY: 1.27, diameter: 1.5, holeDiameter: 0.8 },
        { id: '4', relX: -3.81, relY: 3.81, diameter: 1.5, holeDiameter: 0.8 },
        { id: '5', relX: 3.81, relY: 3.81, diameter: 1.5, holeDiameter: 0.8 },
        { id: '6', relX: 3.81, relY: 1.27, diameter: 1.5, holeDiameter: 0.8 },
        { id: '7', relX: 3.81, relY: -1.27, diameter: 1.5, holeDiameter: 0.8 },
        { id: '8', relX: 3.81, relY: -3.81, diameter: 1.5, holeDiameter: 0.8 }
      ];
    default:
      return [];
  }
};

const getFootprintDimensions = (type: ComponentType) => {
  switch (type) {
    case 'timer555':
    case 'opamp':
      return { width: 10.0, height: 10.0 };
    case 'resistor':
    case 'inductor':
      return { width: 12.0, height: 4.0 };
    case 'capacitor':
      return { width: 6.0, height: 6.0 };
    case 'diode':
    case 'led':
      return { width: 9.0, height: 4.0 };
    case 'transistor_npn':
      return { width: 5.0, height: 5.0 };
    case 'voltage_source':
    case 'gnd':
      return { width: 6.0, height: 6.0 };
    default:
      return { width: 8.0, height: 8.0 };
  }
};

const applyConnectivityNets = (
  schematicData: SchematicData,
  layoutData: PCBLayoutData
): { schematic: SchematicData; pcbLayout: PCBLayoutData } => {
  const pinToParent: Record<string, string> = {};
  const allPins: string[] = [];

  schematicData.components.forEach(comp => {
    comp.pins.forEach(pin => {
      const pinKey = `${comp.id}:${pin.id}`;
      pinToParent[pinKey] = pinKey;
      allPins.push(pinKey);
    });
  });

  const find = (pinKey: string): string => {
    if (!pinToParent[pinKey]) return pinKey;
    if (pinToParent[pinKey] === pinKey) return pinKey;
    pinToParent[pinKey] = find(pinToParent[pinKey]);
    return pinToParent[pinKey];
  };

  const union = (pinKey1: string, pinKey2: string) => {
    const root1 = find(pinKey1);
    const root2 = find(pinKey2);
    if (root1 !== root2) {
      pinToParent[root1] = root2;
    }
  };

  schematicData.wires.forEach(wire => {
    union(`${wire.fromCompId}:${wire.fromPinId}`, `${wire.toCompId}:${wire.toPinId}`);
  });

  const netGroups: Record<string, string[]> = {};
  allPins.forEach(pinKey => {
    const root = find(pinKey);
    if (!netGroups[root]) netGroups[root] = [];
    netGroups[root].push(pinKey);
  });

  let groundRoot: string | null = null;
  schematicData.components.forEach(comp => {
    if (comp.type === 'gnd') {
      groundRoot = find(`${comp.id}:gnd`);
    }
  });

  const pinToNetName: Record<string, string> = {};
  let netIdx = 1;
  Object.keys(netGroups).forEach(root => {
    const isGnd = root === groundRoot || netGroups[root].some(pinKey => pinKey.endsWith(':gnd'));
    const netName = isGnd ? 'GND' : `NET_${netIdx++}`;
    netGroups[root].forEach(pinKey => {
      pinToNetName[pinKey] = netName;
    });
  });

  return {
    schematic: {
      ...schematicData,
      components: schematicData.components.map(comp => ({
        ...comp,
        pins: comp.pins.map(pin => ({
          ...pin,
          net: pinToNetName[`${comp.id}:${pin.id}`]
        }))
      })),
      wires: schematicData.wires.map(wire => ({
        ...wire,
        net: pinToNetName[`${wire.fromCompId}:${wire.fromPinId}`] || 'GND'
      }))
    },
    pcbLayout: {
      ...layoutData,
      footprints: layoutData.footprints.map(fp => ({
        ...fp,
        pads: fp.pads.map(pad => ({
          ...pad,
          net: pinToNetName[`${fp.id}:${pad.id}`]
        }))
      }))
    }
  };
};

function App() {
  const [activeView, setActiveView] = useState<'schematic' | 'layout2d' | 'layout3d' | 'simulation' | 'thermal' | 'si' | 'research'>('schematic');
  
  // Schematic State
  const [schematic, setSchematic] = useState<SchematicData>({
    components: [],
    wires: []
  });

  // PCB Layout State
  const [pcbLayout, setPcbLayout] = useState<PCBLayoutData>({
    boardWidth: 80.0, // mm
    boardHeight: 55.0, // mm
    footprints: [],
    traces: [],
    vias: []
  });

  const [selectedCompId, setSelectedCompId] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [drcErrors, setDrcErrors] = useState<string[]>([]);
  const [placedOffset, setPlacedOffset] = useState(0);

  const { schematic: schematicWithNets, pcbLayout: pcbLayoutWithNets } = useMemo(
    () => applyConnectivityNets(schematic, pcbLayout),
    [schematic, pcbLayout]
  );

  // Parse selected component from components list
  const selectedComponent = schematicWithNets.components.find(c => c.id === selectedCompId) || null;

  // Load a preset design circuit
  const handleLoadPreset = (presetName: string) => {
    setSimResult(null);
    setSelectedCompId(null);

    // Preset configurations
    if (presetName === 'astable555') {
      const comps: SchematicComponent[] = [
        { id: 'U1', type: 'timer555', name: '555 Timer', value: 'IC', x: 450, y: 240, rotation: 0, pins: getPinsForType('timer555'), params: {} },
        { id: 'R1', type: 'resistor', name: 'R1', value: '1k', x: 340, y: 120, rotation: 90, pins: getPinsForType('resistor'), params: { resistance: 1000 } },
        { id: 'R2', type: 'resistor', name: 'R2', value: '10k', x: 450, y: 120, rotation: 90, pins: getPinsForType('resistor'), params: { resistance: 10000 } },
        { id: 'C1', type: 'capacitor', name: 'C1', value: '10u', x: 570, y: 240, rotation: 90, pins: getPinsForType('capacitor'), params: { capacitance: 10e-6 } },
        { id: 'C2', type: 'capacitor', name: 'C2', value: '10n', x: 450, y: 410, rotation: 90, pins: getPinsForType('capacitor'), params: { capacitance: 10e-9 } },
        { id: 'V1', type: 'voltage_source', name: 'Vcc', value: '5V', x: 200, y: 240, rotation: 270, pins: getPinsForType('voltage_source'), params: { voltage: 5 } },
        { id: 'G1', type: 'gnd', name: 'GND1', value: 'GND', x: 200, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} },
        { id: 'G2', type: 'gnd', name: 'GND2', value: 'GND', x: 570, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} },
        { id: 'G3', type: 'gnd', name: 'GND3', value: 'GND', x: 450, y: 500, rotation: 0, pins: getPinsForType('gnd'), params: {} }
      ];

      const wires: Wire[] = [
        // Source connection: V1(+) to R1(1) and U1(8)
        { id: 'w1', fromCompId: 'V1', fromPinId: 'p', toCompId: 'R1', toPinId: '1', points: [{ x: 200, y: 218 }, { x: 200, y: 70 }, { x: 340, y: 70 }, { x: 340, y: 90 }], net: '' },
        { id: 'w2', fromCompId: 'R1', fromPinId: '1', toCompId: 'U1', toPinId: '8', points: [{ x: 340, y: 90 }, { x: 340, y: 70 }, { x: 500, y: 70 }, { x: 500, y: 210 }], net: '' },
        // R1(2) connects to U1(7) and R2(1)
        { id: 'w3', fromCompId: 'R1', fromPinId: '2', toCompId: 'R2', toPinId: '1', points: [{ x: 340, y: 150 }, { x: 340, y: 170 }, { x: 450, y: 170 }, { x: 450, y: 90 }], net: '' },
        { id: 'w4', fromCompId: 'R2', fromPinId: '1', toCompId: 'U1', toPinId: '7', points: [{ x: 450, y: 90 }, { x: 500, y: 90 }, { x: 500, y: 250 }], net: '' },
        // R2(2) connects to U1(6), U1(2), and C1(1)
        { id: 'w5', fromCompId: 'R2', fromPinId: '2', toCompId: 'C1', toPinId: '1', points: [{ x: 450, y: 150 }, { x: 450, y: 190 }, { x: 570, y: 190 }, { x: 570, y: 210 }], net: '' },
        { id: 'w6', fromCompId: 'C1', fromPinId: '1', toCompId: 'U1', toPinId: '6', points: [{ x: 570, y: 210 }, { x: 570, y: 190 }, { x: 500, y: 190 }, { x: 500, y: 230 }], net: '' },
        { id: 'w7', fromCompId: 'U1', fromPinId: '6', toCompId: 'U1', toPinId: '2', points: [{ x: 500, y: 230 }, { x: 360, y: 230 }, { x: 360, y: 230 }, { x: 400, y: 230 }], net: '' },
        // Control capacitor C2(1) to U1(5)
        { id: 'w8', fromCompId: 'C2', fromPinId: '1', toCompId: 'U1', toPinId: '5', points: [{ x: 450, y: 380 }, { x: 400, y: 380 }, { x: 400, y: 270 }], net: '' },
        // Ground connections
        { id: 'w9', fromCompId: 'V1', fromPinId: 'n', toCompId: 'G1', toPinId: 'gnd', points: [{ x: 200, y: 262 }, { x: 200, y: 380 }], net: '' },
        { id: 'w10', fromCompId: 'C1', fromPinId: '2', toCompId: 'G2', toPinId: 'gnd', points: [{ x: 570, y: 270 }, { x: 570, y: 380 }], net: '' },
        { id: 'w11', fromCompId: 'C2', fromPinId: '2', toCompId: 'G3', toPinId: 'gnd', points: [{ x: 450, y: 440 }, { x: 450, y: 500 }], net: '' },
        { id: 'w12', fromCompId: 'U1', fromPinId: '1', toCompId: 'G1', toPinId: 'gnd', points: [{ x: 400, y: 210 }, { x: 360, y: 210 }, { x: 360, y: 380 }, { x: 200, y: 380 }], net: '' },
        // Pull reset U1(4) high to Vcc
        { id: 'w13', fromCompId: 'U1', fromPinId: '4', toCompId: 'R1', toPinId: '1', points: [{ x: 400, y: 250 }, { x: 340, y: 250 }, { x: 340, y: 90 }], net: '' }
      ];

      // PCB Footprints positioned cleanly on a 80x55 board
      const footprints: PCBFootprint[] = [
        { id: 'U1', componentId: 'U1', type: 'timer555', x: 40.0, y: 28.0, rotation: 0, ...getFootprintDimensions('timer555'), pads: getPadsForType('timer555'), isPlaced: true },
        { id: 'R1', componentId: 'R1', type: 'resistor', x: 20.0, y: 15.0, rotation: 90, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'R2', componentId: 'R2', type: 'resistor', x: 40.0, y: 12.0, rotation: 0, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'C1', componentId: 'C1', type: 'capacitor', x: 60.0, y: 25.0, rotation: 90, ...getFootprintDimensions('capacitor'), pads: getPadsForType('capacitor'), isPlaced: true },
        { id: 'C2', componentId: 'C2', type: 'capacitor', x: 40.0, y: 45.0, rotation: 0, ...getFootprintDimensions('capacitor'), pads: getPadsForType('capacitor'), isPlaced: true },
        { id: 'V1', componentId: 'V1', type: 'voltage_source', x: 12.0, y: 35.0, rotation: 0, ...getFootprintDimensions('voltage_source'), pads: getPadsForType('voltage_source'), isPlaced: true },
        { id: 'G1', componentId: 'G1', type: 'gnd', x: 68.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true },
        { id: 'G2', componentId: 'G2', type: 'gnd', x: 68.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true },
        { id: 'G3', componentId: 'G3', type: 'gnd', x: 68.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true }
      ];

      setSchematic({ components: comps, wires });
      setPcbLayout({ boardWidth: 80, boardHeight: 55, footprints, traces: [], vias: [] });

    } else if (presetName === 'ledFlasher') {
      // BJT LED Astable Multivibrator or simple Transistor Switch Flasher
      const comps: SchematicComponent[] = [
        { id: 'Q1', type: 'transistor_npn', name: 'Q1', value: '2N2222', x: 450, y: 250, rotation: 0, pins: getPinsForType('transistor_npn'), params: { beta: 100 } },
        { id: 'R1', type: 'resistor', name: 'R_base', value: '4.7k', x: 320, y: 250, rotation: 0, pins: getPinsForType('resistor'), params: { resistance: 4700 } },
        { id: 'R2', type: 'resistor', name: 'R_limit', value: '330', x: 450, y: 120, rotation: 90, pins: getPinsForType('resistor'), params: { resistance: 330 } },
        { id: 'LED1', type: 'led', name: 'LED1', value: 'Red', x: 550, y: 120, rotation: 90, pins: getPinsForType('led'), params: {} },
        { id: 'V1', type: 'voltage_source', name: 'Vcc', value: 'pulse(0,5,2)', x: 180, y: 200, rotation: 270, pins: getPinsForType('voltage_source'), params: { voltage: 5 } },
        { id: 'G1', type: 'gnd', name: 'GND1', value: 'GND', x: 180, y: 350, rotation: 0, pins: getPinsForType('gnd'), params: {} },
        { id: 'G2', type: 'gnd', name: 'GND2', value: 'GND', x: 450, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} }
      ];

      const wires: Wire[] = [
        // V1(+) to R1(1) and LED1(a)
        { id: 'w1', fromCompId: 'V1', fromPinId: 'p', toCompId: 'R1', toPinId: '1', points: [{ x: 180, y: 178 }, { x: 180, y: 80 }, { x: 290, y: 80 }, { x: 290, y: 250 }], net: '' },
        { id: 'w2', fromCompId: 'R1', fromPinId: '1', toCompId: 'LED1', toPinId: 'a', points: [{ x: 290, y: 250 }, { x: 290, y: 80 }, { x: 550, y: 80 }, { x: 550, y: 90 }], net: '' },
        // R1(2) to Q1(b)
        { id: 'w3', fromCompId: 'R1', fromPinId: '2', toCompId: 'Q1', toPinId: 'b', points: [{ x: 350, y: 250 }, { x: 420, y: 250 }], net: '' },
        // LED1(c) to R2(1)
        { id: 'w4', fromCompId: 'LED1', fromPinId: 'c', toCompId: 'R2', toPinId: '1', points: [{ x: 550, y: 150 }, { x: 550, y: 180 }, { x: 450, y: 180 }, { x: 450, y: 90 }], net: '' },
        // R2(2) to Q1(c)
        { id: 'w5', fromCompId: 'R2', fromPinId: '2', toCompId: 'Q1', toPinId: 'c', points: [{ x: 450, y: 150 }, { x: 470, y: 150 }, { x: 470, y: 265 }], net: '' },
        // Q1(e) to GND
        { id: 'w6', fromCompId: 'Q1', fromPinId: 'e', toCompId: 'G2', toPinId: 'gnd', points: [{ x: 470, y: 235 }, { x: 470, y: 350 }, { x: 450, y: 350 }, { x: 450, y: 380 }], net: '' },
        // V1(n) to GND
        { id: 'w7', fromCompId: 'V1', fromPinId: 'n', toCompId: 'G1', toPinId: 'gnd', points: [{ x: 180, y: 222 }, { x: 180, y: 350 }], net: '' }
      ];

      const footprints: PCBFootprint[] = [
        { id: 'Q1', componentId: 'Q1', type: 'transistor_npn', x: 40.0, y: 30.0, rotation: 0, ...getFootprintDimensions('transistor_npn'), pads: getPadsForType('transistor_npn'), isPlaced: true },
        { id: 'R1', componentId: 'R1', type: 'resistor', x: 22.0, y: 18.0, rotation: 0, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'R2', componentId: 'R2', type: 'resistor', x: 40.0, y: 12.0, rotation: 90, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'LED1', componentId: 'LED1', type: 'led', x: 58.0, y: 20.0, rotation: 90, ...getFootprintDimensions('led'), pads: getPadsForType('led'), isPlaced: true },
        { id: 'V1', componentId: 'V1', type: 'voltage_source', x: 12.0, y: 38.0, rotation: 0, ...getFootprintDimensions('voltage_source'), pads: getPadsForType('voltage_source'), isPlaced: true },
        { id: 'G1', componentId: 'G1', type: 'gnd', x: 68.0, y: 40.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true },
        { id: 'G2', componentId: 'G2', type: 'gnd', x: 68.0, y: 40.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true }
      ];

      setSchematic({ components: comps, wires });
      setPcbLayout({ boardWidth: 80, boardHeight: 55, footprints, traces: [], vias: [] });

    } else if (presetName === 'bandpassFilter') {
      // Opamp Active Bandpass Filter
      const comps: SchematicComponent[] = [
        { id: 'U1', type: 'opamp', name: 'LM741', value: 'OPAMP', x: 450, y: 250, rotation: 0, pins: getPinsForType('opamp'), params: {} },
        { id: 'R1', type: 'resistor', name: 'R_in', value: '10k', x: 300, y: 180, rotation: 0, pins: getPinsForType('resistor'), params: { resistance: 10000 } },
        { id: 'R2', type: 'resistor', name: 'R_feedback', value: '100k', x: 450, y: 100, rotation: 0, pins: getPinsForType('resistor'), params: { resistance: 100000 } },
        { id: 'C1', type: 'capacitor', name: 'C_in', value: '10n', x: 300, y: 260, rotation: 0, pins: getPinsForType('capacitor'), params: { capacitance: 1e-8 } },
        { id: 'V1', type: 'voltage_source', name: 'Vin', value: 'sin(0,1,1k)', x: 180, y: 220, rotation: 270, pins: getPinsForType('voltage_source'), params: {} },
        { id: 'G1', type: 'gnd', name: 'GND', value: 'GND', x: 180, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} }
      ];

      const wires: Wire[] = [
        { id: 'w1', fromCompId: 'V1', fromPinId: 'p', toCompId: 'R1', toPinId: '1', points: [{ x: 180, y: 198 }, { x: 180, y: 180 }, { x: 270, y: 180 }], net: '' },
        { id: 'w2', fromCompId: 'R1', fromPinId: '2', toCompId: 'U1', toPinId: 'in-', points: [{ x: 330, y: 180 }, { x: 370, y: 180 }, { x: 370, y: 235 }, { x: 410, y: 235 }], net: '' },
        { id: 'w3', fromCompId: 'U1', fromPinId: 'in+', toCompId: 'G1', toPinId: 'gnd', points: [{ x: 410, y: 265 }, { x: 350, y: 265 }, { x: 350, y: 380 }, { x: 180, y: 380 }], net: '' }
      ];

      const footprints: PCBFootprint[] = [
        { id: 'U1', componentId: 'U1', type: 'opamp', x: 40.0, y: 28.0, rotation: 0, ...getFootprintDimensions('opamp'), pads: getPadsForType('opamp'), isPlaced: true },
        { id: 'R1', componentId: 'R1', type: 'resistor', x: 20.0, y: 15.0, rotation: 0, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'R2', componentId: 'R2', type: 'resistor', x: 40.0, y: 12.0, rotation: 0, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'C1', componentId: 'C1', type: 'capacitor', x: 60.0, y: 25.0, rotation: 90, ...getFootprintDimensions('capacitor'), pads: getPadsForType('capacitor'), isPlaced: true },
        { id: 'V1', componentId: 'V1', type: 'voltage_source', x: 12.0, y: 35.0, rotation: 0, ...getFootprintDimensions('voltage_source'), pads: getPadsForType('voltage_source'), isPlaced: true },
        { id: 'G1', componentId: 'G1', type: 'gnd', x: 68.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true }
      ];

      setSchematic({ components: comps, wires });
      setPcbLayout({ boardWidth: 80, boardHeight: 55, footprints, traces: [], vias: [] });

    } else if (presetName === 'rlcResonant') {
      // Passive RLC Resonant circuit
      const comps: SchematicComponent[] = [
        { id: 'V1', type: 'voltage_source', name: 'Vin', value: 'sin(0,5,10k)', x: 180, y: 240, rotation: 270, pins: getPinsForType('voltage_source'), params: {} },
        { id: 'R1', type: 'resistor', name: 'R_series', value: '10', x: 300, y: 140, rotation: 0, pins: getPinsForType('resistor'), params: { resistance: 10 } },
        { id: 'L1', type: 'inductor', name: 'L_series', value: '1m', x: 450, y: 140, rotation: 0, pins: getPinsForType('inductor'), params: { inductance: 1e-3 } },
        { id: 'C1', type: 'capacitor', name: 'C_shunt', value: '0.22u', x: 550, y: 240, rotation: 90, pins: getPinsForType('capacitor'), params: { capacitance: 0.22e-6 } },
        { id: 'G1', type: 'gnd', name: 'GND1', value: 'GND', x: 180, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} },
        { id: 'G2', type: 'gnd', name: 'GND2', value: 'GND', x: 550, y: 380, rotation: 0, pins: getPinsForType('gnd'), params: {} }
      ];

      const wires: Wire[] = [
        // V1(+) to R1(1)
        { id: 'w1', fromCompId: 'V1', fromPinId: 'p', toCompId: 'R1', toPinId: '1', points: [{ x: 180, y: 218 }, { x: 180, y: 140 }, { x: 270, y: 140 }], net: '' },
        // R1(2) to L1(1)
        { id: 'w2', fromCompId: 'R1', fromPinId: '2', toCompId: 'L1', toPinId: '1', points: [{ x: 330, y: 140 }, { x: 420, y: 140 }], net: '' },
        // L1(2) to C1(1)
        { id: 'w3', fromCompId: 'L1', fromPinId: '2', toCompId: 'C1', toPinId: '1', points: [{ x: 480, y: 140 }, { x: 550, y: 140 }, { x: 550, y: 210 }], net: '' },
        // GND wiring
        { id: 'w4', fromCompId: 'V1', fromPinId: 'n', toCompId: 'G1', toPinId: 'gnd', points: [{ x: 180, y: 262 }, { x: 180, y: 380 }], net: '' },
        { id: 'w5', fromCompId: 'C1', fromPinId: '2', toCompId: 'G2', toPinId: 'gnd', points: [{ x: 550, y: 270 }, { x: 550, y: 380 }], net: '' }
      ];

      const footprints: PCBFootprint[] = [
        { id: 'V1', componentId: 'V1', type: 'voltage_source', x: 12.0, y: 28.0, rotation: 0, ...getFootprintDimensions('voltage_source'), pads: getPadsForType('voltage_source'), isPlaced: true },
        { id: 'R1', componentId: 'R1', type: 'resistor', x: 30.0, y: 15.0, rotation: 0, ...getFootprintDimensions('resistor'), pads: getPadsForType('resistor'), isPlaced: true },
        { id: 'L1', componentId: 'L1', type: 'inductor', x: 50.0, y: 15.0, rotation: 0, ...getFootprintDimensions('inductor'), pads: getPadsForType('inductor'), isPlaced: true },
        { id: 'C1', componentId: 'C1', type: 'capacitor', x: 42.0, y: 32.0, rotation: 90, ...getFootprintDimensions('capacitor'), pads: getPadsForType('capacitor'), isPlaced: true },
        { id: 'G1', componentId: 'G1', type: 'gnd', x: 25.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true },
        { id: 'G2', componentId: 'G2', type: 'gnd', x: 60.0, y: 45.0, rotation: 0, ...getFootprintDimensions('gnd'), pads: getPadsForType('gnd'), isPlaced: true }
      ];

      setSchematic({ components: comps, wires });
      setPcbLayout({ boardWidth: 80, boardHeight: 55, footprints, traces: [], vias: [] });
    }
  };

  // Add a component to the schematic
  const handleAddComponent = (type: ComponentType) => {
    // Unique ID based on type count
    const count = schematic.components.filter(c => c.type === type).length + 1;
    let label = '';
    switch (type) {
      case 'resistor': label = 'R'; break;
      case 'capacitor': label = 'C'; break;
      case 'inductor': label = 'L'; break;
      case 'voltage_source': label = 'V'; break;
      case 'gnd': label = 'GND'; break;
      case 'diode': label = 'D'; break;
      case 'led': label = 'LED'; break;
      case 'transistor_npn': label = 'Q'; break;
      case 'opamp': label = 'U'; break;
      case 'timer555': label = 'IC'; break;
    }
    const id = `${label}${count}`;

    let val = '10k';
    if (type === 'capacitor') val = '100n';
    if (type === 'inductor') val = '1m';
    if (type === 'voltage_source') val = '5V';
    if (type === 'gnd') val = 'GND';
    if (type === 'diode') val = '1N4148';
    if (type === 'led') val = 'Red';
    if (type === 'transistor_npn') val = 'BC547';
    if (type === 'opamp') val = 'LM358';
    if (type === 'timer555') val = '555';

    // Parse numeric params
    const params: Record<string, number> = {};
    if (type === 'resistor') params.resistance = 10000;
    if (type === 'capacitor') params.capacitance = 1e-7;
    if (type === 'inductor') params.inductance = 1e-3;

    // Place at center with slight offset
    const newOffset = (placedOffset + 15) % 120;
    setPlacedOffset(newOffset);

    const newComp: SchematicComponent = {
      id,
      type,
      name: id,
      value: val,
      x: 350 + newOffset,
      y: 200 + newOffset,
      rotation: 0,
      pins: getPinsForType(type),
      params
    };

    // Add footprint to PCB Layout
    const dim = getFootprintDimensions(type);
    const newFootprint: PCBFootprint = {
      id,
      componentId: id,
      type,
      x: 15.0 + newOffset / 4,
      y: 15.0 + newOffset / 4,
      rotation: 0,
      width: dim.width,
      height: dim.height,
      pads: getPadsForType(type),
      isPlaced: true
    };

    setSchematic(prev => ({
      ...prev,
      components: [...prev.components, newComp]
    }));

    setPcbLayout(prev => ({
      ...prev,
      footprints: [...prev.footprints, newFootprint]
    }));

    setSelectedCompId(id);
  };

  const handleUpdateComponent = (updated: SchematicComponent) => {
    // Parse numeric values if changed
    if (updated.type === 'resistor') {
      const match = updated.value.trim().match(/^([0-9.-]+)\s*([a-zA-Z]*)$/);
      if (match) {
        let num = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit === 'k') num *= 1000;
        updated.params.resistance = num;
      }
    }

    setSchematic(prev => ({
      ...prev,
      components: prev.components.map(c => (c.id === updated.id ? updated : c))
    }));

    // Update footprint rotation in layout
    setPcbLayout(prev => ({
      ...prev,
      footprints: prev.footprints.map(fp => {
        if (fp.id === updated.id) {
          return {
            ...fp,
            rotation: updated.rotation
          };
        }
        return fp;
      })
    }));
  };

  const handleDeleteComponent = (id: string) => {
    const footprint = pcbLayoutWithNets.footprints.find(f => f.id === id);
    const netsToDelete = new Set(footprint?.pads.map(p => p.net).filter(Boolean) || []);

    setSchematic(prev => ({
      components: prev.components.filter(c => c.id !== id),
      wires: prev.wires.filter(w => w.fromCompId !== id && w.toCompId !== id)
    }));

    setPcbLayout(prev => ({
      ...prev,
      footprints: prev.footprints.filter(fp => fp.id !== id),
      // remove traces connected to this footprint's nets
      traces: prev.traces.filter(t => !netsToDelete.has(t.net))
    }));

    setSelectedCompId(null);
  };

  const handleAddWire = (wire: Wire) => {
    setSchematic(prev => ({
      ...prev,
      wires: [...prev.wires, wire]
    }));
  };

  const handleDeleteWire = (id: string) => {
    // Find net name associated with the wire to delete trace
    const wire = schematicWithNets.wires.find(w => w.id === id);
    const netToDelete = wire?.net;

    setSchematic(prev => ({
      ...prev,
      wires: prev.wires.filter(w => w.id !== id)
    }));

    if (netToDelete) {
      setPcbLayout(prev => ({
        ...prev,
        traces: prev.traces.filter(t => t.net !== netToDelete)
      }));
    }
    setSelectedCompId(null);
  };

  // Helper to get active voltage and current values for current time
  const simVoltages = useMemo(() => {
    if (!simResult || simResult.timepoints.length === 0) return undefined;
    
    // Find voltages at the end of the simulation transient sweep for static display
    const lastIdx = simResult.timepoints.length - 1;
    const res: Record<string, number> = {};
    simResult.nodes.forEach(n => {
      res[n] = simResult.voltages[n][lastIdx];
    });
    return res;
  }, [simResult]);

  const simCurrents = useMemo(() => {
    if (!simResult || simResult.timepoints.length === 0) return undefined;
    const lastIdx = simResult.timepoints.length - 1;
    const res: Record<string, number> = {};
    schematicWithNets.components.forEach(c => {
      if (c.type !== 'gnd' && simResult.currents[c.id]) {
        res[c.id] = simResult.currents[c.id][lastIdx];
      }
    });
    return res;
  }, [simResult, schematicWithNets.components]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100 font-sans">
      {/* Sidebar Panel */}
      <Sidebar
        selectedComponent={selectedComponent}
        onUpdateComponent={handleUpdateComponent}
        onDeleteComponent={handleDeleteComponent}
        onAddComponent={handleAddComponent}
        onLoadPreset={handleLoadPreset}
        drcErrors={drcErrors}
      />

      {/* Main View Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Navigation Tab Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 bg-zinc-900/20 backdrop-blur-md">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setActiveView('schematic')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'schematic'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Edit3 className="w-3.5 h-3.5" />
              Schematic Capture
            </button>
            <button
              onClick={() => setActiveView('layout2d')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'layout2d'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              2D PCB Layout
            </button>
            <button
              onClick={() => setActiveView('layout3d')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'layout3d'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              3D PCB View
            </button>
            <div className="h-4 w-px bg-zinc-800 mx-2" />
            <button
              onClick={() => setActiveView('simulation')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'simulation'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              SPICE Scope
            </button>
            <button
              onClick={() => setActiveView('thermal')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'thermal'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Thermometer className="w-3.5 h-3.5" />
              Thermal Solver
            </button>
            <button
              onClick={() => setActiveView('si')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'si'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-purple-400" />
              Signal Integrity
            </button>
            <button
              onClick={() => setActiveView('research')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeView === 'research'
                  ? 'bg-zinc-800 text-cyan-400 border border-zinc-700 shadow-md shadow-black/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              Research Lab
            </button>
          </div>
          
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
            <span>Grid: <span className="text-zinc-400">0.5 mm</span></span>
            <span>•</span>
            <span>Design: <span className="text-cyan-400">Prototype_1</span></span>
          </div>
        </div>

        {/* Dynamic Display Panel */}
        <div className="flex-1 min-h-0 relative">
          {activeView === 'schematic' && (
            <SchematicEditor
              data={schematicWithNets}
              selectedComponent={selectedComponent}
              onSelectComponent={(c) => setSelectedCompId(c ? c.id : null)}
              onUpdateComponent={handleUpdateComponent}
              onAddWire={handleAddWire}
              onDeleteWire={handleDeleteWire}
              simVoltages={simVoltages}
              simCurrents={simCurrents}
            />
          )}

          {activeView === 'layout2d' && (
            <LayoutEditor
              layoutData={pcbLayoutWithNets}
              selectedCompId={selectedCompId}
              onSelectComponent={setSelectedCompId}
              onUpdateLayout={setPcbLayout}
              drcErrors={drcErrors}
              setDrcErrors={setDrcErrors}
            />
          )}

          {activeView === 'layout3d' && (
            <ThreeDPCBViewer
              layoutData={pcbLayoutWithNets}
              simResult={simResult}
            />
          )}

          {activeView === 'simulation' && (
            <SimulationPanel
              schematicData={schematicWithNets}
              simResult={simResult}
              onSetSimResult={setSimResult}
            />
          )}

          {activeView === 'thermal' && (
            <ThermalPanel
              layoutData={pcbLayoutWithNets}
              simResult={simResult}
            />
          )}

          {activeView === 'si' && (
            <SignalIntegrityPanel
              layoutData={pcbLayoutWithNets}
            />
          )}

          {activeView === 'research' && (
            <ResearchPanel
              schematicData={schematicWithNets}
              layoutData={pcbLayoutWithNets}
              simResult={simResult}
              drcErrors={drcErrors}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
