import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SIGNAL_MODEL } from '../src/project/boardSettings.ts';
import { buildResearchReport } from '../src/analysis/pcbResearch.ts';
import type { PCBLayoutData, SchematicData, SimResult } from '../src/types/pcb.ts';

function fixture(net = 'GND'): { schematic: SchematicData; layout: PCBLayoutData; simulation: SimResult } {
  const schematic: SchematicData = { components: ['R1', 'R2'].map(id => ({ id, type: 'resistor', name: id, value: '1k', x: 0, y: 0, rotation: 0, pins: [{ id: '1', label: '1', relX: 0, relY: 0, net }], params: {} })), wires: [] };
  const layout: PCBLayoutData = { boardWidth: 50, boardHeight: 30, footprints: schematic.components.map((component, index) => ({ id: component.id, componentId: component.id, type: component.type, x: 10 + 20 * index, y: 10, rotation: 0, width: 2, height: 2, isPlaced: true, pads: [{ id: '1', relX: 0, relY: 0, diameter: 1.2, holeDiameter: 0.6, net }] })), traces: [], vias: [], pours: [] };
  const simulation: SimResult = { timepoints: [0], nodes: ['GND'], voltages: { GND: [0] }, currents: { R1: [0], R2: [0] }, powerDissipation: { R1: 0, R2: 0 } };
  return { schematic, layout, simulation };
}

test('empty report cannot appear ready or fabricate thermal evidence', () => {
  const report = buildResearchReport({ components: [], wires: [] }, { boardWidth: 50, boardHeight: 30, footprints: [], traces: [], vias: [], pours: [] }, null, []);
  assert.equal(report.status, 'empty');
  assert.equal(report.overallScore, 0);
  assert.equal(report.simulationAvailable, false);
  assert.equal(report.thermalScore, 0);
});

test('a trace on a net is not sufficient for closure, including ground', () => {
  const { schematic, layout } = fixture();
  layout.traces.push({ id: 'stub', net: 'GND', layer: 'top', width: 0.3, points: [{ x: 10, y: 10 }, { x: 15, y: 10 }] });
  const report = buildResearchReport(schematic, layout, null, []);
  assert.equal(report.nets[0].net, 'GND');
  assert.equal(report.nets[0].routed, false);
  assert.equal(report.routingCompletion, 0);
  assert.equal(report.status, 'blocked');
  assert.ok(report.issues.length > 0);
  assert.ok(report.overallScore <= 49);
});

test('connected design requires successful simulation and labels coverage honestly', () => {
  const { schematic, layout, simulation } = fixture();
  layout.traces.push({ id: 'route', net: 'GND', layer: 'top', width: 0.3, points: [{ x: 10, y: 10 }, { x: 30, y: 10 }] });
  const incomplete = buildResearchReport(schematic, layout, null, []);
  assert.equal(incomplete.routingCompletion, 100);
  assert.equal(incomplete.status, 'incomplete');
  const report = buildResearchReport(schematic, layout, simulation, []);
  assert.equal(report.status, 'review');
  assert.equal(report.simulationAvailable, true);
  assert.ok(report.metrics.find(metric => metric.label === 'Power evidence')?.detail.includes('temperature margin is not evaluated'));
  assert.equal(buildResearchReport(schematic, layout, { ...simulation, errorMessage: 'not converged' }, []).simulationAvailable, false);
  assert.equal(buildResearchReport(schematic, layout, { ...simulation, powerDissipation: { R1: 0 } }, []).simulationAvailable, false);
});

test('missing footprint and pad net mismatch are visible without cached DRC input', () => {
  const { schematic, layout } = fixture();
  layout.footprints[0].pads[0].net = 'OTHER';
  layout.footprints.pop();
  const report = buildResearchReport(schematic, layout, null, []);
  assert.ok(report.issues.some(issue => issue.includes('Missing PCB footprints: R2')));
  assert.ok(report.issues.some(issue => issue.includes('Schematic/PCB mismatch at R1:1')));
  assert.equal(report.status, 'blocked');
  assert.ok(report.sources.every(source => source.url.startsWith('https://')));
});


test('saved plane geometry changes report impedance and records its assumptions', () => {
  const { schematic, layout } = fixture('SIGNAL');
  layout.traces.push({ id: 'route', net: 'SIGNAL', layer: 'top', width: 0.3, points: [{ x: 10, y: 10 }, { x: 30, y: 10 }] });
  const baseline = buildResearchReport(schematic, layout, null, []);
  layout.signalModel = { ...DEFAULT_SIGNAL_MODEL, substrateHeightMm: 0.2, riseTimeNs: 1.2 };
  const changed = buildResearchReport(schematic, layout, null, []);
  assert.ok(changed.nets[0].impedanceOhms! < baseline.nets[0].impedanceOhms!);
  assert.ok(changed.recommendations.some(r => r.detail.includes('0.2 mm plane distance') && r.detail.includes('1.2 ns')));
});
