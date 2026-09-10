import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { PCBLayoutData } from '../types/pcb';
import { buildFabricationPackage } from '../export/gerber';
import type { FabricationFile } from '../export/gerber';
import { downloadText } from '../project/projectFile';
import { X, Download, Layers, ZoomIn, ZoomOut, RotateCcw, Check, Eye } from 'lucide-react';
import { getPadBoardCoords } from '../analysis/boardChecks';

interface GerberViewerModalProps {
  layout: PCBLayoutData;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const GerberViewerModal: React.FC<GerberViewerModalProps> = ({
  layout,
  projectName,
  isOpen,
  onClose
}) => {
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    topCopper: true,
    bottomCopper: true,
    topMask: true,
    topSilk: true,
    outline: true,
    drills: true,
  });

  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [mouseMm, setMouseMm] = useState({ x: 0, y: 0 });
  const [downloadedAll, setDownloadedAll] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const files = useMemo(() => {
    return buildFabricationPackage(layout, projectName);
  }, [layout, projectName]);

  const toggleLayer = (layerId: string) => {
    setVisibleLayers(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const handleDownloadAll = () => {
    files.forEach(f => {
      downloadText(f.filename, f.contents, f.type);
    });
    setDownloadedAll(true);
    setTimeout(() => setDownloadedAll(false), 2500);
  };

  // Keyboard shortcut listener for Esc
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Canvas drawing effect
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear dark EDA viewer background
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 + pan.x, height / 2 + pan.y);
    ctx.scale(zoom, zoom);

    // Board center offset
    const scaleMm = 8; // 8px per mm
    const bW = layout.boardWidth * scaleMm;
    const bH = layout.boardHeight * scaleMm;
    const ox = -bW / 2;
    const oy = -bH / 2;

    // Substrate backdrop
    ctx.fillStyle = '#18181b';
    ctx.fillRect(ox, oy, bW, bH);

    // 1. Board Outline
    if (visibleLayers.outline) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox, oy, bW, bH);
    }

    // 2. Soldermask opening (translucent greenish mask)
    if (visibleLayers.topMask) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      ctx.fillRect(ox, oy, bW, bH);
    }

    // 3. Bottom Copper
    if (visibleLayers.bottomCopper) {
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = '#38bdf8';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      layout.traces.filter(t => t.layer === 'bottom').forEach(t => {
        if (t.points.length < 2) return;
        ctx.beginPath();
        ctx.lineWidth = t.width * scaleMm;
        ctx.moveTo(ox + t.points[0].x * scaleMm, oy + t.points[0].y * scaleMm);
        for (let i = 1; i < t.points.length; i++) {
          ctx.lineTo(ox + t.points[i].x * scaleMm, oy + t.points[i].y * scaleMm);
        }
        ctx.stroke();
      });

      // Bottom copper for through-hole pads & vias
      layout.footprints.forEach(fp => {
        fp.pads.forEach(p => {
          if (p.holeDiameter > 0) {
            const pt = getPadBoardCoords(fp, p);
            ctx.beginPath();
            ctx.arc(ox + pt.x * scaleMm, oy + pt.y * scaleMm, (p.diameter / 2) * scaleMm, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      });
      layout.vias.forEach(v => {
        ctx.beginPath();
        ctx.arc(ox + v.x * scaleMm, oy + v.y * scaleMm, (v.diameter / 2) * scaleMm, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 4. Top Copper
    if (visibleLayers.topCopper) {
      ctx.strokeStyle = '#ef4444';
      ctx.fillStyle = '#ef4444';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      layout.traces.filter(t => t.layer === 'top').forEach(t => {
        if (t.points.length < 2) return;
        ctx.beginPath();
        ctx.lineWidth = t.width * scaleMm;
        ctx.moveTo(ox + t.points[0].x * scaleMm, oy + t.points[0].y * scaleMm);
        for (let i = 1; i < t.points.length; i++) {
          ctx.lineTo(ox + t.points[i].x * scaleMm, oy + t.points[i].y * scaleMm);
        }
        ctx.stroke();
      });

      // Top pads
      layout.footprints.forEach(fp => {
        fp.pads.forEach(p => {
          const pt = getPadBoardCoords(fp, p);
          ctx.beginPath();
          ctx.arc(ox + pt.x * scaleMm, oy + pt.y * scaleMm, (p.diameter / 2) * scaleMm, 0, Math.PI * 2);
          ctx.fill();
        });
      });

      // Top vias
      layout.vias.forEach(v => {
        ctx.beginPath();
        ctx.arc(ox + v.x * scaleMm, oy + v.y * scaleMm, (v.diameter / 2) * scaleMm, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 5. Silkscreen Legend
    if (visibleLayers.topSilk) {
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      layout.footprints.forEach(fp => {
        ctx.save();
        ctx.translate(ox + fp.x * scaleMm, oy + fp.y * scaleMm);
        ctx.rotate((fp.rotation * Math.PI) / 180);
        ctx.strokeRect(
          (-fp.width / 2) * scaleMm,
          (-fp.height / 2) * scaleMm,
          fp.width * scaleMm,
          fp.height * scaleMm
        );
        ctx.fillText(fp.id, 0, (-fp.height / 2 - 1.5) * scaleMm);
        ctx.restore();
      });
    }

    // 6. Drill Hits (Excellon NC Holes)
    if (visibleLayers.drills) {
      ctx.fillStyle = '#09090b'; // Hole void
      ctx.strokeStyle = '#fbbf24'; // Drill circle highlight
      ctx.lineWidth = 1;

      // Vias
      layout.vias.forEach(v => {
        if (v.drillDiameter > 0) {
          ctx.beginPath();
          ctx.arc(ox + v.x * scaleMm, oy + v.y * scaleMm, (v.drillDiameter / 2) * scaleMm, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      });

      // Component through-hole pins
      layout.footprints.forEach(fp => {
        fp.pads.forEach(p => {
          if (p.holeDiameter > 0) {
            const pt = getPadBoardCoords(fp, p);
            ctx.beginPath();
            ctx.arc(ox + pt.x * scaleMm, oy + pt.y * scaleMm, (p.holeDiameter / 2) * scaleMm, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        });
      });
    }

    ctx.restore();
  }, [isOpen, layout, visibleLayers, zoom, pan]);

  if (!isOpen) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsPanning(true);
    setStartPan({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - startPan.x, y: e.clientY - startPan.y });
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const scaleMm = 8 * zoom;
      const midX = rect.width / 2 + pan.x;
      const midY = rect.height / 2 + pan.y;
      const mmX = (e.clientX - rect.left - midX) / scaleMm + layout.boardWidth / 2;
      const mmY = (e.clientY - rect.top - midY) / scaleMm + layout.boardHeight / 2;
      setMouseMm({
        x: Math.max(0, Math.min(layout.boardWidth, Math.round(mmX * 10) / 10)),
        y: Math.max(0, Math.min(layout.boardHeight, Math.round(mmY * 10) / 10))
      });
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(prev => Math.max(0.4, Math.min(5.0, prev * zoomFactor)));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 select-none">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-6xl h-[88vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-zinc-100 font-mono tracking-wider">
                GERBER X2 & EXCELLON DRILL VIEWER
              </h2>
              <p className="text-xs text-zinc-400 font-mono">
                {projectName} · {layout.boardWidth}×{layout.boardHeight} mm · 2-Layer FR4
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleDownloadAll}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all ${
                downloadedAll
                  ? 'bg-emerald-950/60 border border-emerald-500/50 text-emerald-300'
                  : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-lg shadow-cyan-900/30'
              }`}
            >
              {downloadedAll ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
              {downloadedAll ? 'Downloaded Package!' : 'Download All Files'}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-zinc-850 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Main Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Layer Controls & Files Sidebar */}
          <div className="w-72 border-r border-zinc-800 bg-zinc-900/40 flex flex-col overflow-y-auto custom-scrollbar p-4 gap-4">
            <div>
              <div className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-cyan-400" />
                Layer Visibility
              </div>
              <div className="space-y-1.5 font-mono text-xs">
                {[
                  { id: 'topCopper', label: 'Top Copper (GTL)', color: '#ef4444' },
                  { id: 'bottomCopper', label: 'Bottom Copper (GBL)', color: '#38bdf8' },
                  { id: 'topMask', label: 'Soldermask (GTS)', color: '#10b981' },
                  { id: 'topSilk', label: 'Silkscreen (GTO)', color: '#ffffff' },
                  { id: 'outline', label: 'Board Profile (GKO)', color: '#f59e0b' },
                  { id: 'drills', label: 'Excellon Drill (DRL)', color: '#fbbf24' },
                ].map(layer => (
                  <button
                    key={layer.id}
                    onClick={() => toggleLayer(layer.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border transition-all ${
                      visibleLayers[layer.id]
                        ? 'bg-zinc-900 border-zinc-700 text-zinc-200'
                        : 'bg-zinc-950 border-zinc-850 text-zinc-600'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-3 h-3 rounded-full"
                        style={{
                          backgroundColor: visibleLayers[layer.id] ? layer.color : '#3f3f46',
                          opacity: visibleLayers[layer.id] ? 1 : 0.4
                        }}
                      />
                      <span>{layer.label}</span>
                    </div>
                    <span className="text-[10px] text-zinc-500">
                      {visibleLayers[layer.id] ? 'ON' : 'OFF'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-zinc-800 pt-3">
              <div className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                <Download className="w-3.5 h-3.5 text-amber-400" />
                Fabrication Files ({files.length})
              </div>
              <div className="space-y-1.5">
                {files.map(f => (
                  <div
                    key={f.filename}
                    className="p-2.5 bg-zinc-950 border border-zinc-850 rounded-lg flex items-center justify-between gap-2 text-xs font-mono hover:border-zinc-750 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-zinc-200 truncate">{f.filename}</div>
                      <div className="text-[10px] text-zinc-500 truncate">{f.description}</div>
                    </div>
                    <button
                      onClick={() => downloadText(f.filename, f.contents, f.type)}
                      title={`Download ${f.filename}`}
                      className="p-1.5 bg-zinc-900 hover:bg-cyan-950 hover:text-cyan-400 border border-zinc-800 rounded text-zinc-400 transition-colors shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Canvas Center Area */}
          <div className="flex-1 flex flex-col relative bg-[#09090b] overflow-hidden">
            {/* Canvas Zoom & Tool HUD */}
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg p-1 text-xs font-mono text-zinc-300 shadow-xl">
              <button
                onClick={() => setZoom(prev => Math.min(5.0, prev * 1.25))}
                className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
                title="Zoom In"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                onClick={() => setZoom(prev => Math.max(0.4, prev / 1.25))}
                className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
                title="Zoom Out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <button
                onClick={() => { setZoom(1.0); setPan({ x: 0, y: 0 }); }}
                className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
                title="Reset View"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <div className="h-4 w-px bg-zinc-800" />
              <span className="px-2">{Math.round(zoom * 100)}%</span>
            </div>

            {/* Position HUD */}
            <div className="absolute bottom-3 right-3 z-10 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg px-3 py-1 text-xs font-mono text-zinc-400 shadow-xl">
              X: <span className="text-zinc-200">{mouseMm.x.toFixed(1)}</span> mm | Y: <span className="text-zinc-200">{mouseMm.y.toFixed(1)}</span> mm
            </div>

            <canvas
              ref={canvasRef}
              width={850}
              height={550}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={() => setIsPanning(false)}
              onMouseLeave={() => setIsPanning(false)}
              onWheel={handleWheel}
              className="w-full h-full cursor-grab active:cursor-grabbing select-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
