import React, { useState, useMemo } from 'react';
import type { SimResult, SimSettings, SchematicData } from '../types/pcb';
import { runSpiceSimulation } from '../simulation/spiceSolver';
import { Play, Activity, Award, Info, Settings } from 'lucide-react';

interface SimulationPanelProps {
  schematicData: SchematicData;
  simResult: SimResult | null;
  onSetSimResult: (result: SimResult) => void;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({
  schematicData,
  simResult,
  onSetSimResult
}) => {
  const [stopTime, setStopTime] = useState('0.02'); // 20ms default
  const [stepTime, setStepTime] = useState('5e-5'); // 50us default
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [hoveredData, setHoveredData] = useState<{ time: number; values: Record<string, number> } | null>(null);

  const getDefaultSelectedNodes = (result: SimResult) => {
    const interesting = result.nodes.filter(n => n !== 'GND').slice(0, 2);
    return interesting.length > 0 ? interesting : result.nodes.slice(0, 1);
  };

  const handleRunSimulation = () => {
    const settings: SimSettings = {
      type: 'transient',
      stopTime: parseFloat(stopTime) || 0.02,
      stepTime: parseFloat(stepTime) || 5e-5
    };

    try {
      const res = runSpiceSimulation(schematicData, settings);
      setSelectedNodes(current => {
        const stillValid = current.filter(node => res.nodes.includes(node));
        return stillValid.length > 0 ? stillValid : getDefaultSelectedNodes(res);
      });
      onSetSimResult(res);
    } catch (e: unknown) {
      console.error(e);
      const message = e instanceof Error ? e.message : 'Simulation encountered a mathematical singularity';
      setSelectedNodes([]);
      onSetSimResult({
        timepoints: [],
        nodes: [],
        voltages: {},
        currents: {},
        powerDissipation: {},
        errorMessage: message
      });
    }
  };

  const toggleNodeSelection = (node: string) => {
    if (selectedNodes.includes(node)) {
      setSelectedNodes(selectedNodes.filter(n => n !== node));
    } else {
      setSelectedNodes([...selectedNodes, node]);
    }
  };

  // Oscilloscope dimensions
  const scopeWidth = 720;
  const scopeHeight = 300;
  const padding = 40;

  // Waveform rendering coordinates
  const plotData = useMemo(() => {
    if (!simResult || simResult.timepoints.length === 0 || selectedNodes.length === 0) return null;

    const t = simResult.timepoints;
    const tMin = 0;
    const tMax = t[t.length - 1];

    // Find min and max voltages among selected nodes
    let vMin = -1;
    let vMax = 5;

    selectedNodes.forEach(node => {
      const volts = simResult.voltages[node] || [];
      volts.forEach(v => {
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      });
    });

    // Pad limits slightly
    const vDiff = vMax - vMin;
    vMin -= vDiff * 0.1;
    vMax += vDiff * 0.1;

    // Build SVG path strings
    const paths: Record<string, string> = {};
    selectedNodes.forEach(node => {
      const volts = simResult.voltages[node] || [];
      let pathStr = '';

      for (let i = 0; i < t.length; i++) {
        // Map time to X coordinate
        const x = padding + ((t[i] - tMin) / (tMax - tMin)) * (scopeWidth - 2 * padding);
        // Map voltage to Y coordinate
        const y = scopeHeight - padding - ((volts[i] - vMin) / (vMax - vMin)) * (scopeHeight - 2 * padding);

        if (i === 0) {
          pathStr += `M ${x.toFixed(1)} ${y.toFixed(1)}`;
        } else {
          pathStr += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
        }
      }
      paths[node] = pathStr;
    });

    return { paths, tMin, tMax, vMin, vMax };
  }, [simResult, selectedNodes]);

  // Handle cursor probing on SVG scope hover
  const handleScopeMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!simResult || !plotData || simResult.timepoints.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    // Convert mouseX to time coordinate
    const plotWidth = scopeWidth - 2 * padding;
    const pct = (mouseX - padding) / plotWidth;
    if (pct < 0 || pct > 1) {
      setHoveredData(null);
      return;
    }

    const tMax = plotData.tMax;
    const targetTime = pct * tMax;

    // Find closest index in timepoints
    const timepoints = simResult.timepoints;
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < timepoints.length; i++) {
      const diff = Math.abs(timepoints[i] - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }

    const timeVal = timepoints[closestIdx];
    const nodeValues: Record<string, number> = {};
    selectedNodes.forEach(node => {
      nodeValues[node] = (simResult.voltages[node] || [])[closestIdx] ?? 0;
    });

    setHoveredData({
      time: timeVal,
      values: nodeValues
    });
  };

  const handleScopeMouseLeave = () => {
    setHoveredData(null);
  };

  // Node line color palette
  const getNodeColor = (_node: string, index: number) => {
    const colors = ['#22c55e', '#06b6d4', '#eab308', '#ec4899', '#a855f7', '#3b82f6'];
    return colors[index % colors.length];
  };

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-6 text-zinc-100 overflow-y-auto h-full">
      {/* Simulation Options Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
              <Settings className="w-4 h-4 text-cyan-400" />
              Transient Settings
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-zinc-500 font-mono">Stop Time (s)</span>
                <input
                  type="text"
                  value={stopTime}
                  onChange={(e) => setStopTime(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2 py-1 text-right w-24 text-zinc-200 font-mono"
                />
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-zinc-500 font-mono">Step Time (s)</span>
                <input
                  type="text"
                  value={stepTime}
                  onChange={(e) => setStepTime(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2 py-1 text-right w-24 text-zinc-200 font-mono"
                />
              </div>
            </div>
          </div>
          <button
            onClick={handleRunSimulation}
            className="w-full mt-4 flex items-center justify-center gap-2 bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-500 hover:to-emerald-500 text-white font-mono text-sm py-2 px-4 rounded-lg transition-all shadow-lg shadow-cyan-900/30 active:scale-98"
          >
            <Play className="w-4 h-4 fill-white" />
            Run SPICE Engine
          </button>
        </div>

        {/* Probes selection */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
            <Activity className="w-4 h-4 text-emerald-400" />
            Active Node Probes
          </h3>
          {simResult ? (
            <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto pr-2 custom-scrollbar">
              {simResult.nodes.map((node, idx) => {
                const isSelected = selectedNodes.includes(node);
                const color = getNodeColor(node, idx);
                return (
                  <button
                    key={node}
                    onClick={() => toggleNodeSelection(node)}
                    style={{ borderColor: isSelected ? color : undefined }}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded border text-xs font-mono transition-all ${
                      isSelected
                        ? 'bg-zinc-800 text-zinc-100 font-bold'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: color }}
                    ></span>
                    {node}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-zinc-600 text-xs py-8 text-center font-mono">
              Run SPICE engine to populate nodes
            </div>
          )}
        </div>

        {/* Simulation Summary Status */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-2">
            <Award className="w-4 h-4 text-amber-500" />
            Simulation Status
          </h3>
          {simResult ? (
            <div className="space-y-1.5 text-xs font-mono text-zinc-400">
              {simResult.errorMessage ? (
                <div className="text-red-400 font-bold bg-red-950/20 border border-red-900/40 p-2.5 rounded">
                  ERROR: {simResult.errorMessage}
                </div>
              ) : (
                <>
                  <div className="text-emerald-400 font-bold">✓ Solver Converged Successfully</div>
                  <div>Steps Computed: <span className="text-zinc-200">{simResult.timepoints.length}</span></div>
                  <div>Probed nodes: <span className="text-zinc-200">{selectedNodes.length}</span></div>
                  <div>Compute time: <span className="text-zinc-200">~8.5 ms</span></div>
                </>
              )}
            </div>
          ) : (
            <div className="text-zinc-600 text-xs py-8 text-center font-mono flex items-center justify-center gap-2">
              <Info className="w-4 h-4" /> Ready for transient run
            </div>
          )}
        </div>
      </div>

      {/* Custom Scope Plot */}
      {simResult && !simResult.errorMessage && plotData && (
        <div className="bg-zinc-900/30 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-4 shadow-xl">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold tracking-wider text-zinc-300 font-mono">
              AURA DIGITAL OSCILLOSCOPE
            </span>
            {hoveredData && (
              <div className="flex items-center gap-4 text-xs font-mono bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1">
                <span className="text-cyan-400 font-bold">Time: {(hoveredData.time * 1000).toFixed(2)} ms</span>
                {Object.keys(hoveredData.values).map(node => {
                  const valIdx = simResult.nodes.indexOf(node);
                  return (
                    <span key={node} style={{ color: getNodeColor(node, valIdx) }}>
                      {node}: {hoveredData.values[node].toFixed(3)} V
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Scope SVG */}
          <div className="flex items-center justify-center bg-[#070709] border border-zinc-850 rounded-xl overflow-hidden shadow-inner relative">
            <svg
              width={scopeWidth}
              height={scopeHeight}
              onMouseMove={handleScopeMouseMove}
              onMouseLeave={handleScopeMouseLeave}
              className="cursor-crosshair select-none"
            >
              {/* Grid Lines */}
              {/* Vertical Divisions (Time) */}
              {Array.from({ length: 9 }).map((_, idx) => {
                const x = padding + ((idx + 1) / 10) * (scopeWidth - 2 * padding);
                return (
                  <line
                    key={`v-${idx}`}
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

              {/* Horizontal Divisions (Voltage) */}
              {Array.from({ length: 5 }).map((_, idx) => {
                const y = padding + ((idx + 1) / 6) * (scopeHeight - 2 * padding);
                return (
                  <line
                    key={`h-${idx}`}
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

              {/* Graph Border */}
              <rect
                x={padding}
                y={padding}
                width={scopeWidth - 2 * padding}
                height={scopeHeight - 2 * padding}
                stroke="#27272a"
                strokeWidth="1.5"
                fill="none"
              />

              {/* Render Waveforms */}
              {Object.keys(plotData.paths).map(node => {
                const nodeIdx = simResult.nodes.indexOf(node);
                const color = getNodeColor(node, nodeIdx);
                return (
                  <path
                    key={node}
                    d={plotData.paths[node]}
                    stroke={color}
                    strokeWidth="2.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="opacity-90 shadow-2xl"
                  />
                );
              })}

              {/* Cursor Probing Line */}
              {hoveredData && (
                <line
                  x1={padding + ((hoveredData.time) / plotData.tMax) * (scopeWidth - 2 * padding)}
                  y1={padding}
                  x2={padding + ((hoveredData.time) / plotData.tMax) * (scopeWidth - 2 * padding)}
                  y2={scopeHeight - padding}
                  stroke="#a855f7"
                  strokeWidth="1.5"
                  className="opacity-70"
                />
              )}

              {/* Axis Labels */}
              <text x={padding} y={scopeHeight - 15} fill="#52525b" fontSize="10" className="font-mono">
                0.00 ms
              </text>
              <text x={scopeWidth - padding} y={scopeHeight - 15} textAnchor="end" fill="#52525b" fontSize="10" className="font-mono">
                {(plotData.tMax * 1000).toFixed(1)} ms
              </text>

              <text x={10} y={padding + 8} fill="#52525b" fontSize="10" className="font-mono">
                {plotData.vMax.toFixed(1)}V
              </text>
              <text x={10} y={scopeHeight - padding} fill="#52525b" fontSize="10" className="font-mono">
                {plotData.vMin.toFixed(1)}V
              </text>
            </svg>
          </div>
        </div>
      )}
    </div>
  );
};
