import React, { useMemo } from 'react';
import type { PCBLayoutData, SchematicData, SimResult } from '../types/pcb';
import { buildResearchReport } from '../analysis/pcbResearch';
import { Activity, AlertTriangle, CheckCircle, Cpu, Radio, Thermometer, Zap } from 'lucide-react';

interface ResearchPanelProps {
  schematicData: SchematicData;
  layoutData: PCBLayoutData;
  simResult: SimResult | null;
  drcErrors: string[];
}

const toneColor = (tone: 'good' | 'warn' | 'bad' | 'neutral') => {
  if (tone === 'good') return '#34d399';
  if (tone === 'warn') return '#f59e0b';
  if (tone === 'bad') return '#f87171';
  return '#a1a1aa';
};

const riskColor = (risk: 'low' | 'medium' | 'high') => {
  if (risk === 'low') return '#34d399';
  if (risk === 'medium') return '#f59e0b';
  return '#f87171';
};

export const ResearchPanel: React.FC<ResearchPanelProps> = ({
  schematicData,
  layoutData,
  simResult,
  drcErrors
}) => {
  const report = useMemo(
    () => buildResearchReport(schematicData, layoutData, simResult, drcErrors),
    [schematicData, layoutData, simResult, drcErrors]
  );

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-6 text-zinc-100 overflow-y-auto h-full">
      <div
        className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-5"
        style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.7fr) minmax(300px, 1.3fr)', gap: '1.25rem' }}
      >
        <div className="flex flex-col justify-between gap-4">
          <div>
            <div className="text-xs font-mono text-zinc-500 uppercase tracking-wider">Research readiness</div>
            <div className="flex items-center gap-3 mt-3">
              <Cpu className="w-12 h-12 text-cyan-400" />
              <div>
                <div className="text-lg font-bold text-zinc-100">{report.overallScore.toFixed(0)} / 100</div>
                <div className="text-xs text-zinc-500 font-mono">physics-informed prototype score</div>
              </div>
            </div>
          </div>
          <div style={{ height: 8, background: '#27272a', borderRadius: 999 }}>
            <div
              style={{
                width: `${report.overallScore}%`,
                height: '100%',
                borderRadius: 999,
                background: report.overallScore >= 82 ? '#34d399' : report.overallScore >= 58 ? '#f59e0b' : '#f87171'
              }}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem' }}>
          {report.metrics.map(metric => (
            <div key={metric.label} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-zinc-400 font-mono">{metric.label}</div>
                <span style={{ color: toneColor(metric.tone) }} className="text-xs font-bold font-mono">
                  {metric.value}
                </span>
              </div>
              <div className="mt-3" style={{ height: 5, background: '#27272a', borderRadius: 999 }}>
                <div
                  style={{
                    width: `${metric.score}%`,
                    height: '100%',
                    borderRadius: 999,
                    background: toneColor(metric.tone)
                  }}
                />
              </div>
              <div className="text-[10px] text-zinc-500 mt-3">{metric.detail}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 1.1fr) minmax(300px, 0.9fr)', gap: '1.5rem' }}>
        <div className="bg-zinc-900/30 border border-zinc-800 rounded-lg p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <Radio className="w-4 h-4 text-purple-400" />
              Net Physics Table
            </h3>
            <span className="text-xs text-zinc-500 font-mono">{report.nets.length} signal net(s)</span>
          </div>

          {report.nets.length === 0 ? (
            <div className="text-zinc-600 text-xs py-8 text-center font-mono">
              No multi-pad signal nets yet. Add or load a circuit to start net analysis.
            </div>
          ) : (
            <div className="space-y-2">
              {report.nets.map(net => (
                <div
                  key={net.net}
                  className="bg-zinc-950 border border-zinc-800 rounded-lg p-3"
                  style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '0.75rem', alignItems: 'center' }}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      {net.routed ? (
                        <CheckCircle className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-red-400" />
                      )}
                      <span className="text-sm font-bold font-mono text-zinc-200">{net.net}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">{net.padCount} pads</span>
                    </div>
                    <div className="text-[10px] text-zinc-500 mt-1">{net.reason}</div>
                  </div>
                  <div className="text-right font-mono text-[11px] space-y-1">
                    <div style={{ color: riskColor(net.risk) }}>{net.risk.toUpperCase()}</div>
                    <div className="text-zinc-400">{net.traceLengthMm.toFixed(1)} mm</div>
                    <div className="text-zinc-500">
                      {net.impedanceOhms ? `${net.impedanceOhms.toFixed(0)} ohm` : 'unrouted'}
                      {net.delayPs ? ` / ${net.delayPs.toFixed(0)} ps` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-cyan-400" />
              Optimization Queue
            </h3>
            <div className="space-y-2">
              {report.recommendations.map(item => (
                <div key={`${item.priority}-${item.title}`} className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-bold text-zinc-200">{item.title}</div>
                    <span
                      className="text-[10px] font-mono"
                      style={{ color: item.priority === 'P0' ? '#f87171' : item.priority === 'P1' ? '#f59e0b' : '#34d399' }}
                    >
                      {item.priority}
                    </span>
                  </div>
                  <div className="text-[10px] text-cyan-400 font-mono mt-1">{item.category}</div>
                  <div className="text-[11px] text-zinc-500 mt-2">{item.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-emerald-400" />
              Manufacturing Snapshot
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Components</div>
                <div className="text-zinc-200 font-bold mt-1">{report.manufacturing.componentCount}</div>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Traces / vias</div>
                <div className="text-zinc-200 font-bold mt-1">
                  {report.manufacturing.traceCount} / {report.manufacturing.viaCount}
                </div>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Copper length</div>
                <div className="text-zinc-200 font-bold mt-1">{report.manufacturing.totalTraceLengthMm.toFixed(1)} mm</div>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Copper density</div>
                <div className="text-zinc-200 font-bold mt-1">{report.manufacturing.copperDensityPct.toFixed(1)}%</div>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Min trace</div>
                <div className="text-zinc-200 font-bold mt-1">
                  {report.manufacturing.minTraceWidthMm > 0 ? `${report.manufacturing.minTraceWidthMm.toFixed(2)} mm` : 'none'}
                </div>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3">
                <div className="text-zinc-500">Min drill</div>
                <div className="text-zinc-200 font-bold mt-1">
                  {report.manufacturing.minDrillMm > 0 ? `${report.manufacturing.minDrillMm.toFixed(2)} mm` : 'none'}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2 mb-3">
              <Thermometer className="w-4 h-4 text-orange-400" />
              Simulation Coupling
            </h3>
            <div className="text-xs text-zinc-500 font-mono space-y-2">
              <div>SPICE transient: <span className="text-zinc-200">{simResult ? 'available' : 'not run'}</span></div>
              <div>Power total: <span className="text-zinc-200">{report.manufacturing.totalPowerW.toFixed(3)} W</span></div>
              <div>Peak device: <span className="text-zinc-200">{report.manufacturing.maxPowerW.toFixed(3)} W</span></div>
              <div>Route closure: <span className="text-zinc-200">{report.routingCompletion.toFixed(0)}%</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
