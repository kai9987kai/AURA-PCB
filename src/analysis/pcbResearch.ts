import type { PCBFootprint, PCBLayoutData, PCBTrace, SchematicData, SimResult } from '../types/pcb';
import { analyzeTraceSI, calculateTraceLength } from '../simulation/signalIntegrity';

type RiskLevel = 'low' | 'medium' | 'high';
type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface ResearchMetric {
  label: string;
  value: string;
  score: number;
  tone: Tone;
  detail: string;
}

export interface NetAnalysis {
  net: string;
  padCount: number;
  traceCount: number;
  traceLengthMm: number;
  impedanceOhms?: number;
  delayPs?: number;
  routed: boolean;
  risk: RiskLevel;
  reason: string;
}

export interface ResearchRecommendation {
  priority: 'P0' | 'P1' | 'P2';
  category: string;
  title: string;
  detail: string;
}

export interface PCBResearchReport {
  overallScore: number;
  routingCompletion: number;
  drcScore: number;
  thermalScore: number;
  siScore: number;
  manufacturabilityScore: number;
  metrics: ResearchMetric[];
  nets: NetAnalysis[];
  recommendations: ResearchRecommendation[];
  manufacturing: {
    componentCount: number;
    traceCount: number;
    viaCount: number;
    totalTraceLengthMm: number;
    copperDensityPct: number;
    boardDensityPct: number;
    minTraceWidthMm: number;
    minDrillMm: number;
    maxPowerW: number;
    totalPowerW: number;
  };
}

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const getPadBoardCoords = (fp: PCBFootprint, padRelX: number, padRelY: number) => {
  const rad = (fp.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: fp.x + padRelX * cos - padRelY * sin,
    y: fp.y + padRelX * sin + padRelY * cos
  };
};

const getTone = (score: number): Tone => {
  if (score >= 82) return 'good';
  if (score >= 58) return 'warn';
  return 'bad';
};

export function buildResearchReport(
  schematic: SchematicData,
  layout: PCBLayoutData,
  simResult: SimResult | null,
  drcErrors: string[]
): PCBResearchReport {
  const netToPads: Record<string, { fpId: string; x: number; y: number }[]> = {};

  layout.footprints.forEach(fp => {
    fp.pads.forEach(pad => {
      if (!pad.net) return;
      if (!netToPads[pad.net]) netToPads[pad.net] = [];
      const coords = getPadBoardCoords(fp, pad.relX, pad.relY);
      netToPads[pad.net].push({ fpId: fp.id, x: coords.x, y: coords.y });
    });
  });

  const signalNets = Object.keys(netToPads).filter(net => net !== 'GND' && netToPads[net].length > 1);
  const tracesByNet: Record<string, PCBTrace[]> = {};
  layout.traces.forEach(trace => {
    if (!tracesByNet[trace.net]) tracesByNet[trace.net] = [];
    tracesByNet[trace.net].push(trace);
  });

  const routedNets = signalNets.filter(net => (tracesByNet[net]?.length || 0) > 0);
  const routingCompletion = signalNets.length === 0 ? 100 : (routedNets.length / signalNets.length) * 100;

  const traceLengths = layout.traces.map(trace => calculateTraceLength(trace.points));
  const totalTraceLengthMm = traceLengths.reduce((sum, len) => sum + len, 0);
  const copperAreaMm2 = layout.traces.reduce((sum, trace, idx) => sum + trace.width * traceLengths[idx], 0);
  const boardAreaMm2 = Math.max(1, layout.boardWidth * layout.boardHeight);
  const copperDensityPct = clamp((copperAreaMm2 / boardAreaMm2) * 100, 0, 100);
  const boardDensityPct = clamp(
    (layout.footprints.reduce((sum, fp) => sum + fp.width * fp.height, 0) / boardAreaMm2) * 100,
    0,
    100
  );

  const minTraceWidthMm = layout.traces.length > 0 ? Math.min(...layout.traces.map(t => t.width)) : 0;
  const minDrillMm = layout.vias.length > 0 ? Math.min(...layout.vias.map(v => v.drillDiameter)) : 0;
  const totalPowerW = simResult
    ? Object.values(simResult.powerDissipation).reduce((sum, value) => sum + value, 0)
    : 0;
  const maxPowerW = simResult
    ? Math.max(0, ...Object.values(simResult.powerDissipation))
    : 0;

  const netAnalyses: NetAnalysis[] = signalNets.map(net => {
    const netTraces = tracesByNet[net] || [];
    const traceLengthMm = netTraces.reduce((sum, trace) => sum + calculateTraceLength(trace.points), 0);
    let impedanceOhms: number | undefined;
    let delayPs: number | undefined;
    let risk: RiskLevel = 'low';
    let reason = 'Routed with low estimated physical risk.';

    if (netTraces.length === 0) {
      risk = 'high';
      reason = 'Pads are connected in the schematic but no PCB copper route exists.';
    } else {
      const report = analyzeTraceSI(netTraces[0], layout.traces);
      impedanceOhms = report.impedance;
      delayPs = report.propagationDelay * 1000;
      const offTarget = Math.abs(report.impedance - 50);
      if (report.crosstalkPeakVoltage > 150 || offTarget > 25) {
        risk = 'high';
        reason = 'Estimated impedance or crosstalk is outside a conservative prototype range.';
      } else if (report.crosstalkPeakVoltage > 80 || offTarget > 15) {
        risk = 'medium';
        reason = 'Estimated SI is workable but should be reviewed before high-speed use.';
      }
    }

    return {
      net,
      padCount: netToPads[net].length,
      traceCount: netTraces.length,
      traceLengthMm,
      impedanceOhms,
      delayPs,
      routed: netTraces.length > 0,
      risk,
      reason
    };
  });

  const highSiRisks = netAnalyses.filter(net => net.risk === 'high').length;
  const mediumSiRisks = netAnalyses.filter(net => net.risk === 'medium').length;
  const siScore = clamp(100 - highSiRisks * 18 - mediumSiRisks * 8);
  const drcScore = clamp(100 - drcErrors.length * 14);
  const thermalScore = !simResult ? 72 : clamp(100 - maxPowerW * 80 - totalPowerW * 12);

  let manufacturabilityScore = 100;
  if (minTraceWidthMm > 0 && minTraceWidthMm < 0.2) manufacturabilityScore -= 25;
  if (layout.vias.some(via => via.drillDiameter < 0.35)) manufacturabilityScore -= 18;
  if (boardDensityPct > 42) manufacturabilityScore -= 16;
  if (copperDensityPct < 0.4 && layout.traces.length > 0) manufacturabilityScore -= 8;
  manufacturabilityScore = clamp(manufacturabilityScore - drcErrors.length * 8);

  const overallScore = clamp(
    routingCompletion * 0.23 +
      drcScore * 0.25 +
      thermalScore * 0.18 +
      siScore * 0.18 +
      manufacturabilityScore * 0.16
  );

  const recommendations: ResearchRecommendation[] = [];
  if (schematic.components.length === 0) {
    recommendations.push({
      priority: 'P0',
      category: 'Workflow',
      title: 'Load or capture a circuit',
      detail: 'The research checks become meaningful after a schematic netlist exists.'
    });
  }
  if (signalNets.length > routedNets.length) {
    recommendations.push({
      priority: 'P0',
      category: 'Routing',
      title: 'Complete unrouted signal nets',
      detail: `${signalNets.length - routedNets.length} schematic net(s) still rely on ratsnest airwires. Run the autorouter or route them manually.`
    });
  }
  if (drcErrors.length > 0) {
    recommendations.push({
      priority: 'P0',
      category: 'DFM',
      title: 'Resolve clearance errors',
      detail: `The board currently reports ${drcErrors.length} DRC issue(s). Fix these before trusting SI or thermal results.`
    });
  }
  if (!simResult) {
    recommendations.push({
      priority: 'P1',
      category: 'Simulation',
      title: 'Run the transient solver',
      detail: 'Power dissipation and thermal hotspot ranking will use real component currents after SPICE simulation.'
    });
  }
  if (maxPowerW > 0.2) {
    recommendations.push({
      priority: 'P1',
      category: 'Thermal',
      title: 'Add thermal spreading for hot devices',
      detail: `A component is dissipating about ${maxPowerW.toFixed(2)} W. Add copper area, thermal vias, or move it away from heat-sensitive parts.`
    });
  }
  if (netAnalyses.some(net => net.impedanceOhms && Math.abs(net.impedanceOhms - 50) > 20)) {
    recommendations.push({
      priority: 'P1',
      category: 'Signal integrity',
      title: 'Tune high-speed trace geometry',
      detail: 'One or more routed traces are far from a 50 ohm microstrip estimate. Adjust width or stackup before fast edge-rate use.'
    });
  }
  if (boardDensityPct > 42) {
    recommendations.push({
      priority: 'P2',
      category: 'Placement',
      title: 'Reduce placement density',
      detail: 'Component bodies occupy a large part of the board. More spread improves routing, inspection, and heat dissipation.'
    });
  }
  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'P2',
      category: 'Review',
      title: 'Prototype checks look balanced',
      detail: 'The current layout has no major automated findings. Next review footprints, connector orientation, and real part tolerances.'
    });
  }

  const metrics: ResearchMetric[] = [
    {
      label: 'Route closure',
      value: `${routingCompletion.toFixed(0)}%`,
      score: routingCompletion,
      tone: getTone(routingCompletion),
      detail: `${routedNets.length}/${signalNets.length || 0} signal nets have copper routes.`
    },
    {
      label: 'DRC quality',
      value: drcErrors.length === 0 ? 'Clean' : `${drcErrors.length} issue(s)`,
      score: drcScore,
      tone: getTone(drcScore),
      detail: 'Clearance and basic fabrication checks.'
    },
    {
      label: 'Thermal margin',
      value: simResult ? `${maxPowerW.toFixed(2)} W peak` : 'No run',
      score: thermalScore,
      tone: getTone(thermalScore),
      detail: simResult ? `${totalPowerW.toFixed(2)} W total simulated dissipation.` : 'Run SPICE to populate power data.'
    },
    {
      label: 'SI estimate',
      value: `${siScore.toFixed(0)}%`,
      score: siScore,
      tone: getTone(siScore),
      detail: `${highSiRisks} high-risk and ${mediumSiRisks} medium-risk routed net estimate(s).`
    },
    {
      label: 'DFM readiness',
      value: `${manufacturabilityScore.toFixed(0)}%`,
      score: manufacturabilityScore,
      tone: getTone(manufacturabilityScore),
      detail: 'Trace width, drill size, density, and DRC-derived manufacturing risk.'
    }
  ];

  return {
    overallScore,
    routingCompletion,
    drcScore,
    thermalScore,
    siScore,
    manufacturabilityScore,
    metrics,
    nets: netAnalyses,
    recommendations,
    manufacturing: {
      componentCount: layout.footprints.length,
      traceCount: layout.traces.length,
      viaCount: layout.vias.length,
      totalTraceLengthMm,
      copperDensityPct,
      boardDensityPct,
      minTraceWidthMm,
      minDrillMm,
      maxPowerW,
      totalPowerW
    }
  };
}
