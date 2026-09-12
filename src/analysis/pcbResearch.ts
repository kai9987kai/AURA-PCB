import type { PCBLayoutData, SchematicData, SimResult } from '../types/pcb';
import { analyzeTraceSI, calculateTraceLength, hasReferencePlane } from '../simulation/signalIntegrity';
import { analyzeBoard } from './boardChecks';
import { signalModelFor } from '../project/boardSettings';

type RiskLevel = 'low' | 'medium' | 'high';
type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export interface ResearchMetric { label: string; value: string; score: number; tone: Tone; detail: string }
export interface NetAnalysis {
  net: string; padCount: number; traceCount: number; traceLengthMm: number;
  impedanceOhms?: number; delayPs?: number; routed: boolean; risk: RiskLevel; reason: string;
}
export interface ResearchRecommendation { priority: 'P0' | 'P1' | 'P2'; category: string; title: string; detail: string }
export const RESEARCH_SOURCES = [
  { title: 'PCBWorld: engine-checked routing evaluation', date: '2026-09-03', url: 'https://arxiv.org/abs/2607.05915', implication: 'Measure connectivity and design-rule violations on the resulting board.' },
  { title: 'OmniRouting: geometry, rules, and electrical connectivity', date: '2026-08-05', url: 'https://arxiv.org/abs/2608.04434', implication: 'Treat a valid geometric route and preserved electrical connectivity as separate checks.' },
  { title: 'KiCad 10 PCB design-rule checking', date: 'Documentation', url: 'https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#design-rules-checking', implication: 'Check copper, unconnected items, and schematic parity before fabrication.' },
  { title: 'TI: IBIS models and signal integrity', date: '2011', url: 'https://www.ti.com/lit/an/slyt413/slyt413.pdf', implication: 'Use the actual edge rate and driver/load characteristics when assessing termination.' },
  { title: 'Qucs: microstrip model equations', date: 'Technical reference', url: 'https://qucs.sourceforge.net/tech/node75.html', implication: 'Use a documented quasi-static model and expose its stackup assumptions.' },
  { title: 'Analog Devices AN-1604: thermal paths', date: 'Application note', url: 'https://www.analog.com/en/resources/app-notes/an-1604.html', implication: 'Temperature estimates depend on package, copper, vias, and the full heat path.' },
] as const;

export interface PCBResearchReport {
  schemaVersion: 1;
  status: 'empty' | 'blocked' | 'incomplete' | 'review';
  statusLabel: string;
  overallScore: number;
  routingCompletion: number;
  drcScore: number;
  thermalScore: number;
  siScore: number;
  manufacturabilityScore: number;
  simulationAvailable: boolean;
  issues: string[];
  assumptions: string[];
  sources: typeof RESEARCH_SOURCES;
  metrics: ResearchMetric[];
  nets: NetAnalysis[];
  recommendations: ResearchRecommendation[];
  manufacturing: {
    componentCount: number; traceCount: number; viaCount: number; totalTraceLengthMm: number;
    copperDensityPct: number; boardDensityPct: number; minTraceWidthMm: number; minDrillMm: number;
    maxPowerW: number; totalPowerW: number;
  };
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));
const finite = (value: number) => Number.isFinite(value) ? value : 0;

export function buildResearchReport(
  schematic: SchematicData,
  layout: PCBLayoutData,
  simResult: SimResult | null,
  drcErrors: string[],
): PCBResearchReport {
  const board = analyzeBoard(layout);
  const model = signalModelFor(layout);
  const issues = [...new Set([...board.issues.map(issue => issue.message), ...drcErrors])];
  const physicalComponents = schematic.components.filter(component => component.type !== 'gnd');
  const missing = physicalComponents.filter(component => !layout.footprints.some(fp => fp.componentId === component.id));
  if (missing.length) issues.push(`Missing PCB footprints: ${missing.map(component => component.id).join(', ')}.`);
  for (const footprint of layout.footprints) {
    const component = schematic.components.find(item => item.id === footprint.componentId);
    if (!component) { issues.push(`Footprint ${footprint.id} has no schematic component.`); continue; }
    for (const pin of component.pins) {
      const pad = footprint.pads.find(item => item.id === pin.id);
      if (!pad || (pin.net && pad.net !== pin.net)) issues.push(`Schematic/PCB mismatch at ${component.id}:${pin.id}. Refresh the PCB netlist.`);
    }
  }
  const hasDesign = physicalComponents.length > 0 && layout.footprints.length > 0;
  const simulationAvailable = Boolean(simResult && !simResult.errorMessage && simResult.timepoints.length &&
    physicalComponents.every(component => Number.isFinite(simResult.powerDissipation[component.id]) && simResult.powerDissipation[component.id] >= 0));
  const powers = simulationAvailable && simResult ? Object.values(simResult.powerDissipation).filter(value => Number.isFinite(value) && value >= 0) : [];
  const totalPowerW = powers.reduce((sum, value) => sum + value, 0);
  const maxPowerW = Math.max(0, ...powers);
  let analyzedTraces = 0;
  const nets: NetAnalysis[] = board.nets.filter(net => net.padCount > 1).map(net => {
    const traces = layout.traces.filter(trace => trace.net === net.net);
    const lengths = traces.map(trace => finite(calculateTraceLength(trace.points)));
    let impedanceOhms: number | undefined;
    let delayPs: number | undefined;
    let risk: RiskLevel = net.fullyRouted ? 'low' : 'high';
    let reason = net.fullyRouted ? 'All pads share a copper connection. SI still requires the actual stackup and signal model.' : `${net.connectedGroups} disconnected pad groups remain; copper continuity is incomplete.`;
    for (const trace of traces) {
      try {
        const estimate = analyzeTraceSI(trace, layout.traces, model.substrateHeightMm, model.dielectricConstant, model.copperThicknessUm,
          model.riseTimeNs, model.sourceImpedanceOhms, model.loadImpedanceOhms, hasReferencePlane(trace, layout.pours ?? []));
        analyzedTraces++;
        if (delayPs === undefined || estimate.propagationDelay * 1000 > delayPs) {
          delayPs = estimate.propagationDelay * 1000;
          impedanceOhms = estimate.impedance;
        }
        if (net.fullyRouted && (estimate.electricallyLong || estimate.crosstalkPeakVoltage > 150)) {
          risk = 'medium';
          reason = 'Connected; saved edge/stackup assumptions flag this net for SI review.';
        }
      } catch {
        risk = 'high'; reason = 'Invalid trace geometry prevents SI screening; resolve the board findings.';
      }
    }
    return { net: net.net, padCount: net.padCount, traceCount: traces.length, traceLengthMm: lengths.reduce((sum, value) => sum + value, 0), impedanceOhms, delayPs, routed: net.fullyRouted, risk, reason };
  });
  const routingCompletion = hasDesign && nets.length ? board.routingCompletion : 0;
  const drcScore = hasDesign ? clamp(100 - issues.length * 14) : 0;
  const thermalScore = simulationAvailable ? 100 : 0; // Evidence availability, never a temperature margin.
  const siScore = layout.traces.length ? analyzedTraces / layout.traces.length * 100 : 0;
  const manufacturabilityScore = hasDesign ? clamp(100 - issues.length * 14) : 0;
  const status = !physicalComponents.length ? 'empty' : issues.length || nets.some(net => !net.routed) ? 'blocked' : !simulationAvailable || !nets.length ? 'incomplete' : 'review';
  const statusLabel = { empty: 'Start with a circuit', blocked: 'Board findings need attention', incomplete: 'Evidence incomplete', review: 'Ready for engineering review' }[status];
  const rawScore = routingCompletion * 0.4 + drcScore * 0.3 + thermalScore * 0.15 + siScore * 0.15;
  const overallScore = status === 'empty' ? 0 : Math.min(rawScore, status === 'blocked' ? 49 : status === 'incomplete' ? 79 : 100);
  const lengths = layout.traces.map(trace => finite(calculateTraceLength(trace.points)));
  const totalTraceLengthMm = lengths.reduce((sum, value) => sum + value, 0);
  const area = Math.max(1, finite(layout.boardWidth * layout.boardHeight));
  const copperDensityPct = clamp(layout.traces.reduce((sum, trace, index) => sum + finite(trace.width) * lengths[index], 0) / area * 100);
  const boardDensityPct = clamp(layout.footprints.reduce((sum, fp) => sum + finite(fp.width * fp.height), 0) / area * 100);
  const recommendations: ResearchRecommendation[] = [];
  if (!physicalComponents.length) recommendations.push({ priority: 'P0', category: 'Workflow', title: 'Load or capture a circuit', detail: 'A design and its matching PCB footprints are needed before these checks have meaning.' });
  if (issues.length) recommendations.push({ priority: 'P0', category: 'Board checks', title: `Resolve ${issues.length} board finding(s)`, detail: issues.slice(0, 3).join(' ') });
  const unrouted = nets.filter(net => !net.routed);
  if (unrouted.length) recommendations.push({ priority: 'P0', category: 'Connectivity', title: 'Complete copper connectivity', detail: `${unrouted.map(net => net.net).join(', ')} have disconnected pads. Ground needs a real connection too: route it, or flood the layer with a pour on that net.` });
  if (!simulationAvailable) recommendations.push({ priority: 'P1', category: 'Simulation', title: 'Obtain a successful simulation', detail: simResult?.errorMessage || 'Run the current circuit. Missing or invalid power results do not count as thermal evidence.' });
  if (maxPowerW > 0.2) recommendations.push({ priority: 'P1', category: 'Thermal', title: 'Review device power and heat paths', detail: `Peak modeled device dissipation is ${maxPowerW.toFixed(2)} W. Use the actual package and board thermal data to assess temperature.` });
  if (layout.traces.length) recommendations.push({ priority: 'P1', category: 'Signal integrity', title: 'Set the actual signal and stackup', detail: `The net table uses saved inputs: ${model.riseTimeNs} ns, er ${model.dielectricConstant}, ${model.substrateHeightMm} mm plane distance, ${model.copperThicknessUm} um copper, source ${model.sourceImpedanceOhms} ohm and load ${model.loadImpedanceOhms} ohm. Table delay describes the longest trace object, not end-to-end net delay.` });
  recommendations.push({ priority: 'P2', category: 'Engineering review', title: 'Confirm footprints and fabrication requirements', detail: 'These checks cover a limited two-layer model. Confirm package land patterns, return paths, fabrication rules, and measured prototype behavior.' });
  const metrics: ResearchMetric[] = [
    { label: 'Copper connectivity', value: nets.length ? `${routingCompletion.toFixed(0)}%` : 'No nets', score: routingCompletion, tone: routingCompletion === 100 ? 'good' : 'warn', detail: `${nets.filter(net => net.routed).length}/${nets.length} multi-pad nets fully connected, including ground.` },
    { label: 'Board checks', value: hasDesign ? `${issues.length} finding(s)` : 'No board', score: drcScore, tone: !hasDesign ? 'neutral' : issues.length ? 'bad' : 'good', detail: 'Live geometry, connectivity, and basic schematic/PCB parity checks.' },
    { label: 'Power evidence', value: simulationAvailable ? `${maxPowerW.toFixed(3)} W peak` : 'Missing', score: thermalScore, tone: simulationAvailable ? 'neutral' : 'warn', detail: simulationAvailable ? `${totalPowerW.toFixed(3)} W modeled total; temperature margin is not evaluated.` : 'Requires a successful current-circuit simulation.' },
    { label: 'SI screening coverage', value: `${analyzedTraces}/${layout.traces.length}`, score: siScore, tone: 'neutral', detail: 'Trace objects evaluated with declared assumptions; not a signal-quality score.' },
  ];
  return {
    schemaVersion: 1, status, statusLabel, overallScore, routingCompletion, drcScore, thermalScore, siScore, manufacturabilityScore,
    simulationAvailable, issues, metrics, nets, recommendations, sources: RESEARCH_SOURCES,
    assumptions: [
      'The checklist score is a workflow aid, not a certification or predicted fabrication yield.',
      'Connectivity uses the stored pad and trace nets; only actual modeled copper connects layers. A pour joins same-net items only through paths verified clear of other-net cutouts; fine connections can remain unverified; no plane is inferred where none is drawn.',
      'SI estimates assume a uniform microstrip over a continuous reference plane. A pour on the opposite layer indicates only that a possible reference exists; its continuity beneath a given trace is not checked. Copper area is trace length times width and double-counts overlap, and excludes pour area.',
      'Simulation and thermal views are simplified models; component power alone cannot establish junction temperature or thermal margin.',
    ],
    manufacturing: {
      componentCount: layout.footprints.length, traceCount: layout.traces.length, viaCount: layout.vias.length,
      totalTraceLengthMm, copperDensityPct, boardDensityPct,
      minTraceWidthMm: layout.traces.length ? Math.min(...layout.traces.map(trace => finite(trace.width))) : 0,
      minDrillMm: layout.vias.length ? Math.min(...layout.vias.map(via => finite(via.drillDiameter))) : 0,
      maxPowerW, totalPowerW,
    },
  };
}
