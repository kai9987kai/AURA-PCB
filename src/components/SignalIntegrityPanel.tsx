import React, { useState, useMemo } from 'react';
import type { PCBLayoutData } from '../types/pcb';
import { analyzeTraceSI, hasReferencePlane, simulateReflections } from '../simulation/signalIntegrity';
import { Radio, Zap, BookOpen } from 'lucide-react';

interface SignalIntegrityPanelProps {
  layoutData: PCBLayoutData;
}

export const SignalIntegrityPanel: React.FC<SignalIntegrityPanelProps> = ({
  layoutData
}) => {
  const [selectedTraceId, setSelectedTraceId] = useState<string>('');
  const [riseTime, setRiseTime] = useState('0.5'); // ns
  const [sourceImpedance, setSourceImpedance] = useState('50'); // ohms
  const [loadImpedance, setLoadImpedance] = useState('10000'); // high-z CMOS load
  const [substrateHeight, setSubstrateHeight] = useState('1.6');
  const [dielectricConstant, setDielectricConstant] = useState('4.5');
  const [copperThickness, setCopperThickness] = useState('35');

  const traces = layoutData.traces;
  const activeTraceId = traces.some(t => t.id === selectedTraceId) ? selectedTraceId : traces[0]?.id ?? '';

  const activeTrace = useMemo(() => {
    return traces.find(t => t.id === activeTraceId) || null;
  }, [traces, activeTraceId]);

  // Compute Signal Integrity Report
  const analysis = useMemo(() => {
    if (!activeTrace) return { report: null, error: '' };
    try {
      const values = [substrateHeight, dielectricConstant, copperThickness, riseTime, sourceImpedance, loadImpedance];
      if (values.some(value => value.trim() === '')) throw new Error('Complete every model input to calculate an estimate.');
      const plane = hasReferencePlane(activeTrace, layoutData.pours ?? []);
      return { report: analyzeTraceSI(activeTrace, traces, ...values.map(Number) as [number, number, number, number, number, number], plane), error: '' };
    } catch (error) {
      return { report: null, error: error instanceof Error ? error.message : 'Invalid signal model inputs.' };
    }
  }, [activeTrace, traces, layoutData.pours, riseTime, sourceImpedance, loadImpedance, substrateHeight, dielectricConstant, copperThickness]);
  const siReport = analysis.report;

  // Simulate reflections ringing graph
  const ringingData = useMemo(() => {
    if (!siReport) return null;
    return simulateReflections(siReport, 0.05, 8.0); // stop at 8ns
  }, [siReport]);

  // Rings Scope Dimensions
  const scopeWidth = 600;
  const scopeHeight = 220;
  const padding = 35;

  const scopePath = useMemo(() => {
    if (!ringingData || ringingData.time.length === 0) return '';
    const { time, voltage } = ringingData;

    const tMin = 0;
    const tMax = time[time.length - 1];

    // Find min and max voltages to scale
    let vMin = 0;
    let vMax = 4.0;
    voltage.forEach(v => {
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    });

    const vDiff = vMax - vMin;
    vMin -= vDiff * 0.05;
    vMax += vDiff * 0.05;

    let pathStr = '';
    for (let i = 0; i < time.length; i++) {
      const x = padding + ((time[i] - tMin) / (tMax - tMin)) * (scopeWidth - 2 * padding);
      const y = scopeHeight - padding - ((voltage[i] - vMin) / (vMax - vMin)) * (scopeHeight - 2 * padding);

      if (i === 0) {
        pathStr += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      } else {
        pathStr += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    }

    return { pathStr, vMin, vMax, tMax };
  }, [ringingData]);

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-6 text-zinc-100 overflow-y-auto h-full">
      <div className="text-xs text-zinc-400">Explore a uniform microstrip and a 3.3 V step. Set the distance to the reference plane from your fabricator's stackup; board thickness alone does not establish this distance.</div>
      {/* Parameter Inputs bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Trace Selector */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
            <Radio className="w-4 h-4 text-cyan-400 font-bold" />
            Inspect PCB Trace
          </h3>
          {traces.length === 0 ? (
            <div className="text-zinc-600 text-xs py-4 text-center font-mono">
              No traces routed. Route traces first!
            </div>
          ) : (
            <select
              aria-label="Trace to inspect"
              value={activeTraceId}
              onChange={(e) => setSelectedTraceId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-3 py-2 text-xs font-mono text-zinc-200"
            >
              {traces.map(t => (
                <option key={t.id} value={t.id}>
                  {t.net} ({t.layer.toUpperCase()})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Electrical inputs */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur md:col-span-2">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
            <Zap className="w-4 h-4 text-amber-400" />
            Signal Characteristics
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] text-zinc-500 font-mono">Rise Time tr (ns)</label>
              <input
                aria-label="Rise time (ns)"
                type="text"
                value={riseTime}
                onChange={(e) => setRiseTime(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2.5 py-1 text-xs text-zinc-200 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-zinc-500 font-mono">Source Zs (Ω)</label>
              <input
                aria-label="Source impedance (ohm)"
                type="text"
                value={sourceImpedance}
                onChange={(e) => setSourceImpedance(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2.5 py-1 text-xs text-zinc-200 font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-zinc-500 font-mono">Load Zl (Ω)</label>
              <input
                aria-label="Load impedance (ohm)"
                type="text"
                value={loadImpedance}
                onChange={(e) => setLoadImpedance(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2.5 py-1 text-xs text-zinc-200 font-mono"
              />
            </div>
          </div>
        </div>

        {/* Board Parameters info */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur text-xs font-mono text-zinc-400 space-y-1.5">
          <div className="font-bold text-zinc-300 mb-1">Stackup assumptions</div>
          {[
            { label: 'Plane distance (mm)', value: substrateHeight, set: setSubstrateHeight },
            { label: 'Dielectric constant', value: dielectricConstant, set: setDielectricConstant },
            { label: 'Copper thickness (um)', value: copperThickness, set: setCopperThickness },
          ].map(input => <label key={input.label} className="flex flex-col gap-1">
            {input.label}
            <input aria-label={input.label} type="text" value={input.value} onChange={event => input.set(event.target.value)} className="w-full bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 font-mono" />
          </label>)}
        </div>
      </div>
      {analysis.error && <div role="alert" className="text-xs text-red-400">{analysis.error}</div>}

      {/* Main Analysis grid */}
      {siReport && activeTrace && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Signal Ringing Oscilloscope Simulation */}
          <div className="bg-zinc-900/30 border border-zinc-800/80 rounded-2xl p-5 shadow-xl lg:col-span-2 flex flex-col gap-4">
            <h4 className="text-xs font-bold font-mono tracking-wider text-zinc-300">
              ESTIMATED LOAD STEP RESPONSE
            </h4>
            <div className="bg-[#070709] border border-zinc-850 rounded-xl p-4 flex items-center justify-center">
              <svg viewBox={`0 0 ${scopeWidth} ${scopeHeight}`} style={{ width: '100%', maxWidth: scopeWidth }} className="select-none" role="img" aria-label="Estimated load voltage versus time">
                {/* Horizontal divisions grid */}
                {Array.from({ length: 4 }).map((_, idx) => {
                  const y = padding + ((idx + 1) / 5) * (scopeHeight - 2 * padding);
                  return (
                    <line
                      key={idx}
                      x1={padding}
                      y1={y}
                      x2={scopeWidth - padding}
                      y2={y}
                      stroke="#18181b"
                      strokeWidth="1"
                      strokeDasharray="2 3"
                    />
                  );
                })}
                {/* Vertical divisions grid */}
                {Array.from({ length: 7 }).map((_, idx) => {
                  const x = padding + ((idx + 1) / 8) * (scopeWidth - 2 * padding);
                  return (
                    <line
                      key={idx}
                      x1={x}
                      y1={padding}
                      x2={x}
                      y2={scopeHeight - padding}
                      stroke="#18181b"
                      strokeWidth="1"
                      strokeDasharray="2 3"
                    />
                  );
                })}

                <rect
                  x={padding}
                  y={padding}
                  width={scopeWidth - 2 * padding}
                  height={scopeHeight - 2 * padding}
                  stroke="#27272a"
                  strokeWidth="1.5"
                  fill="none"
                />

                {scopePath && (
                  <path
                    d={scopePath.pathStr}
                    stroke="#ec4899" // hot pink for ringing waveform
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}

                {/* Grid markings */}
                <text x={padding} y={scopeHeight - 10} fill="#52525b" fontSize="9" className="font-mono">
                  0.0 ns
                </text>
                <text x={scopeWidth - padding} y={scopeHeight - 10} textAnchor="end" fill="#52525b" fontSize="9" className="font-mono">
                  {scopePath ? (scopePath.tMax).toFixed(1) : '8.0'} ns
                </text>
                <text x={10} y={padding + 8} fill="#52525b" fontSize="9" className="font-mono">
                  {scopePath ? scopePath.vMax.toFixed(1) : '3.6'}V
                </text>
                <text x={10} y={scopeHeight - padding} fill="#52525b" fontSize="9" className="font-mono">
                  {scopePath ? scopePath.vMin.toFixed(1) : '0.0'}V
                </text>
              </svg>
            </div>
          </div>

          {/* Analysis Report Card */}
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 flex flex-col justify-between">
            <div>
              <h4 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-4 border-b border-zinc-850 pb-2">
                <BookOpen className="w-4 h-4 text-cyan-400" />
                SI Analysis Report
              </h4>
              <div className="space-y-3 font-mono text-xs text-zinc-400">
                <div className="flex justify-between border-b border-zinc-800/40 pb-1.5">
                  <span>Trace Impedance Z0:</span>
                  <span className="text-zinc-200 font-bold">{siReport.impedance.toFixed(1)} Ω</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800/40 pb-1.5">
                  <span>Propagation Delay:</span>
                  <span className="text-zinc-200 font-bold">{(siReport.propagationDelay * 1000).toFixed(0)} ps</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800/40 pb-1.5">
                  <span>Coupling indicator:</span>
                  <span className={siReport.crosstalkPeakVoltage > 150 ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>
                    {siReport.crosstalkPeakVoltage.toFixed(0)} mV
                  </span>
                </div>
                <div className="flex justify-between border-b border-zinc-800/40 pb-1.5">
                  <span>Load Reflection (ΓL):</span>
                  <span className="text-zinc-200 font-bold">{siReport.reflectionCoefficientLoad.toFixed(3)}</span>
                </div>
                {siReport.ringingFrequency && (
                  <div className="flex justify-between border-b border-zinc-800/40 pb-1.5">
                    <span>Round-trip scale:</span>
                    <span className="text-amber-400 font-bold">{(siReport.ringingFrequency).toFixed(2)} GHz</span>
                  </div>
                )}
              </div>
            </div>

            {/* SI Recommendations */}
            <div className="mt-6 space-y-2">
              <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">Design Recommendations</div>
              {siReport.suggestions.map((sug, idx) => (
                <div key={idx} className="p-2.5 bg-zinc-950 border-l-2 border-cyan-500 rounded text-[10px] text-zinc-300 leading-normal font-sans">
                  {sug}
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-zinc-500">{siReport.modelNotes.map(note => <p key={note}>{note}</p>)}</div>
          </div>
        </div>
      )}
    </div>
  );
};
