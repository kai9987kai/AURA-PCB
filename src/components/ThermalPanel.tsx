import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { PCBLayoutData, SimResult, ThermalGrid } from '../types/pcb';
import { createThermalGrid, computeConductivityGrid, solveThermalStep } from '../simulation/thermalSolver';
import type { ThermalSource } from '../simulation/thermalSolver';
import { Flame, Fan, Thermometer, Info } from 'lucide-react';

interface ThermalPanelProps {
  layoutData: PCBLayoutData;
  simResult: SimResult | null;
}

export const ThermalPanel: React.FC<ThermalPanelProps> = ({
  layoutData,
  simResult
}) => {
  const [ambientTemp, setAmbientTemp] = useState('25.0');
  const [convectionCoeff, setConvectionCoeff] = useState('15.0'); // 15 W/m^2K natural air cooling
  const [isPlaying, setIsPlaying] = useState(true);
  const [hoveredTemp, setHoveredTemp] = useState<{ x: number; y: number; temp: number } | null>(null);
  const [maxTemp, setMaxTemp] = useState(25.0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridRef = useRef<ThermalGrid | null>(null);
  const conductivityRef = useRef<Float32Array | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const cellSizeMm = 1.5; // grid cell size
  const SCALE = 8; // canvas scaling factor (matching layout editor)

  const boardWidthPx = layoutData.boardWidth * SCALE;
  const boardHeightPx = layoutData.boardHeight * SCALE;

  // Set up the sources from simulation results power dissipation
  const thermalSources = React.useMemo(() => {
    const sources: ThermalSource[] = [];
    layoutData.footprints.forEach(fp => {
      // Find average power dissipation for this component from simulation results
      const power = simResult?.powerDissipation[fp.id] || 0.0;
      
      // Only include as heat source if dissipating measurable power
      if (power > 0.001) {
        sources.push({
          x: fp.x,
          y: fp.y,
          power: power * 10, // scale up by 10 for dramatic visualization purposes
          radius: Math.max(fp.width, fp.height) / 2
        });
      }
    });
    return sources;
  }, [layoutData, simResult]);

  // Map temperatures to colors: Blue (cold) -> Green -> Yellow -> Red -> White (hot)
  const getTemperatureColor = useCallback((temp: number) => {
    // Range: 25C (cold) to 85C (hot)
    const tMin = 25.0;
    const tMax = 85.0;
    const pct = Math.max(0, Math.min(1, (temp - tMin) / (tMax - tMin)));

    // Thermal color spectrum: Blue -> Cyan -> Green -> Yellow -> Red
    let r = 0;
    let g: number;
    let b = 0;

    if (pct < 0.25) {
      // Blue to Cyan
      b = 255;
      g = Math.floor((pct / 0.25) * 255);
    } else if (pct < 0.5) {
      // Cyan to Green
      g = 255;
      b = Math.floor((1 - (pct - 0.25) / 0.25) * 255);
    } else if (pct < 0.75) {
      // Green to Yellow
      g = 255;
      r = Math.floor(((pct - 0.5) / 0.25) * 255);
    } else {
      // Yellow to Red
      r = 255;
      g = Math.floor((1 - (pct - 0.75) / 0.25) * 255);
    }

    // Add glowing alpha based on heat
    const a = 0.4 + pct * 0.5;

    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }, []);

  const drawThermalMap = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gridRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { widthCells, heightCells, temperatures } = gridRef.current;

    // Clear canvas
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, boardWidthPx, boardHeightPx);

    // 1. Draw diffused thermal cells
    const cellW = cellSizeMm * SCALE;
    const cellH = cellSizeMm * SCALE;

    for (let r = 0; r < heightCells; r++) {
      for (let c = 0; c < widthCells; c++) {
        const temp = temperatures[r * widthCells + c];
        ctx.fillStyle = getTemperatureColor(temp);
        ctx.fillRect(c * cellW, r * cellH, cellW + 0.5, cellH + 0.5); // overlapping cell edges to remove artifacts
      }
    }

    // 2. Draw footprint outlines in translucent white so we see where components are
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;

    layoutData.footprints.forEach(fp => {
      ctx.save();
      ctx.translate(fp.x * SCALE, fp.y * SCALE);
      ctx.rotate((fp.rotation * Math.PI) / 180);
      ctx.strokeRect(
        (-fp.width / 2) * SCALE,
        (-fp.height / 2) * SCALE,
        fp.width * SCALE,
        fp.height * SCALE
      );

      // Name designator
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(fp.id, 0, (-fp.height / 2 - 1.5) * SCALE);

      ctx.restore();
    });
  }, [SCALE, boardHeightPx, boardWidthPx, cellSizeMm, getTemperatureColor, layoutData.footprints]);

  // Reset/Initialize grid when layout changes
  useEffect(() => {
    const wCells = Math.ceil(layoutData.boardWidth / cellSizeMm);
    const hCells = Math.ceil(layoutData.boardHeight / cellSizeMm);
    
    gridRef.current = createThermalGrid(layoutData.boardWidth, layoutData.boardHeight, cellSizeMm);
    conductivityRef.current = computeConductivityGrid(layoutData, wCells, hCells, cellSizeMm);
  }, [layoutData]);

  // Solver animation loop
  useEffect(() => {
    if (!isPlaying) {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      return;
    }

    const runLoop = () => {
      if (gridRef.current && conductivityRef.current) {
        // Run thermal steps
        const nextGrid = solveThermalStep(
          gridRef.current,
          conductivityRef.current,
          thermalSources,
          parseFloat(ambientTemp) || 25.0,
          parseFloat(convectionCoeff) || 15.0,
          10 // iterations per frame for smooth speed
        );
        gridRef.current = nextGrid;

        let nextMax = parseFloat(ambientTemp) || 25.0;
        nextGrid.temperatures.forEach(temp => {
          if (temp > nextMax) nextMax = temp;
        });
        setMaxTemp(current => (Math.abs(current - nextMax) > 0.05 ? nextMax : current));

        // Draw matrix on canvas
        drawThermalMap();
      }

      animationFrameRef.current = requestAnimationFrame(runLoop);
    };

    animationFrameRef.current = requestAnimationFrame(runLoop);

    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [thermalSources, ambientTemp, convectionCoeff, isPlaying, drawThermalMap]);

  // Probing temperature on hover
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !gridRef.current) return;
    const rect = canvas.getBoundingClientRect();

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const mmX = mouseX / SCALE;
    const mmY = mouseY / SCALE;

    const col = Math.floor(mmX / cellSizeMm);
    const row = Math.floor(mmY / cellSizeMm);

    const { widthCells, heightCells, temperatures } = gridRef.current;

    if (col >= 0 && col < widthCells && row >= 0 && row < heightCells) {
      const temp = temperatures[row * widthCells + col];
      setHoveredTemp({
        x: mmX,
        y: mmY,
        temp
      });
    }
  };

  const handleMouseLeave = () => {
    setHoveredTemp(null);
  };

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-6 text-zinc-100 overflow-y-auto h-full">
      {/* Parameters Header */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
              <Thermometer className="w-4 h-4 text-cyan-400" />
              Thermal Substrate
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-zinc-500 font-mono">Ambient Temp (°C)</span>
                <input
                  type="text"
                  value={ambientTemp}
                  onChange={(e) => setAmbientTemp(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2 py-1 text-right w-20 text-zinc-200 font-mono"
                />
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-zinc-500 font-mono">Convection (W/m²·K)</span>
                <input
                  type="text"
                  value={convectionCoeff}
                  onChange={(e) => setConvectionCoeff(e.target.value)}
                  className="bg-zinc-950 border border-zinc-800 focus:border-cyan-500 focus:outline-none rounded px-2 py-1 text-right w-20 text-zinc-200 font-mono"
                />
              </div>
            </div>
          </div>
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className={`w-full mt-4 flex items-center justify-center gap-2 font-mono text-xs py-2 px-4 rounded-lg border transition-all ${
              isPlaying
                ? 'bg-zinc-900/60 border-cyan-800 text-cyan-400'
                : 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
            }`}
          >
            {isPlaying ? 'Pause Solver' : 'Resume Solver'}
          </button>
        </div>

        {/* Heat Sources Summary */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
            <Flame className="w-4 h-4 text-orange-500" />
            Heat Sources (SPICE Sync)
          </h3>
          <div className="max-h-28 overflow-y-auto pr-2 custom-scrollbar space-y-2">
            {thermalSources.length === 0 ? (
              <div className="text-zinc-600 text-xs py-4 text-center font-mono">
                No active high-power components. Run simulation first!
              </div>
            ) : (
              thermalSources.map((src, idx) => {
                const fp = layoutData.footprints.find(f => Math.abs(f.x - src.x) < 1 && Math.abs(f.y - src.y) < 1);
                return (
                  <div key={idx} className="flex justify-between items-center text-[11px] font-mono border-b border-zinc-800/40 pb-1.5">
                    <span className="text-zinc-300 font-bold">{fp?.id || 'IC'}</span>
                    <span className="text-zinc-500">Power: <span className="text-orange-400">{(src.power / 10).toFixed(3)} W</span></span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Max board stats */}
        <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5 backdrop-blur flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5 mb-3">
              <Fan className="w-4 h-4 text-emerald-400" />
              Thermal Status
            </h3>
            <div className="space-y-1.5 text-xs font-mono text-zinc-400">
              <div>Peak Temperature: <span className={maxTemp > 65.0 ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>{maxTemp.toFixed(1)} °C</span></div>
              <div>Substrate: <span className="text-zinc-300">FR4 standard (1.6mm)</span></div>
              <div>Thermal vias: <span className="text-zinc-300">{layoutData.vias.length} vias</span></div>
            </div>
          </div>
          {maxTemp > 65.0 && (
            <div className="text-[10px] text-red-400 font-mono mt-3 leading-relaxed flex gap-1 items-start bg-red-950/20 p-2 border border-red-900/40 rounded">
              <Info className="w-3.5 h-3.5 shrink-0" />
              <span>Warning: Transistor/IC temperature exceeds safe operating boundary. Add thermal vias or widening copper pads!</span>
            </div>
          )}
        </div>
      </div>

      {/* Renders Heat Map */}
      <div className="bg-zinc-900/30 border border-zinc-800/80 rounded-2xl p-5 flex flex-col gap-4 shadow-xl">
        <div className="flex items-center justify-between text-sm">
          <span className="font-bold tracking-wider text-zinc-300 font-mono">
            LIVE PCB THERMAL GRADIENT SCANNER
          </span>
          {hoveredTemp && (
            <div className="text-xs font-mono bg-zinc-900 border border-zinc-850 px-3 py-1 rounded-lg">
              Coordinates: <span className="text-zinc-400">({hoveredTemp.x.toFixed(1)}mm, {hoveredTemp.y.toFixed(1)}mm)</span> Temp: <span className="text-orange-400 font-bold">{hoveredTemp.temp.toFixed(2)} °C</span>
            </div>
          )}
        </div>

        <div className="flex justify-center bg-[#070709] border border-zinc-850 rounded-xl p-4 overflow-hidden relative">
          <canvas
            ref={canvasRef}
            width={boardWidthPx}
            height={boardHeightPx}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            className="border border-zinc-800 rounded shadow-inner cursor-crosshair max-w-full"
          />

          {/* Color bar Legend on the right */}
          <div className="absolute bottom-6 right-6 bg-zinc-900/90 border border-zinc-800 rounded px-2.5 py-2 flex flex-col gap-1.5 font-mono text-[9px]">
            <div className="text-center font-bold mb-1 text-zinc-400">TEMP</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[rgba(255,0,0,0.8)] rounded"></span> 85°C+</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[rgba(255,255,0,0.8)] rounded"></span> 70°C</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[rgba(0,255,0,0.8)] rounded"></span> 50°C</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[rgba(0,255,255,0.8)] rounded"></span> 35°C</div>
            <div className="flex items-center gap-1.5"><span className="w-3 h-3 bg-[rgba(0,0,255,0.8)] rounded"></span> 25°C</div>
          </div>
        </div>
      </div>
    </div>
  );
};
