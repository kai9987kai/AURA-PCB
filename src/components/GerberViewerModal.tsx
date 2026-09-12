import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { PCBLayoutData, SchematicData } from '../types/pcb';
import { buildFabricationPackage, buildGerberLayers } from '../export/gerber';
import { downloadText } from '../project/projectFile';
import { X, Download, Layers, ZoomIn, ZoomOut, RotateCcw, Check, Eye } from 'lucide-react';
import { parseGeneratedGerber, renderGerberCommands } from '../export/gerberPreview';
import { createZip } from '../export/zip';
import { getPadBoardCoords } from '../analysis/boardChecks';

interface GerberViewerModalProps {
  layout: PCBLayoutData;
  /** Supplies component values to the centroid; the layout alone does not carry them. */
  schematic?: SchematicData;
  projectName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const GerberViewerModal: React.FC<GerberViewerModalProps> = ({
  layout,
  schematic,
  projectName,
  isOpen,
  onClose
}) => {
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    topCopper: true,
    bottomCopper: true,
    topMask: false,
    bottomMask: false,
    topPaste: false,
    topSilk: true,
    outline: true,
    drills: true,
  });

  const [viewport, setViewport] = useState({ width: 850, height: 550 });
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [startPan, setStartPan] = useState({ x: 0, y: 0 });
  const [mouseMm, setMouseMm] = useState({ x: 0, y: 0 });
  const [downloadedAll, setDownloadedAll] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const files = useMemo(() => {
    return buildFabricationPackage(layout, projectName, schematic);
  }, [layout, projectName, schematic]);

  const toggleLayer = (layerId: string) => {
    setVisibleLayers(prev => ({ ...prev, [layerId]: !prev[layerId] }));
  };

  const handleDownloadAll = () => {
    const url = URL.createObjectURL(new Blob([createZip(files)], { type: 'application/zip' }));
    const link = document.createElement('a'); link.href = url;
    link.download = (projectName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'aura-board') + '-fabrication.zip'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloadedAll(true);
    setTimeout(() => setDownloadedAll(false), 2500);
  };

  // Keyboard shortcut listener for Esc
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0]; const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      setViewport({ width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) });
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [isOpen]);

  const fittedZoom = zoom * Math.max(0.01, Math.min((viewport.width - 40) / (layout.boardWidth * 8), (viewport.height - 40) / (layout.boardHeight * 8)));

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
    ctx.scale(fittedZoom, fittedZoom);

    // Board center offset
    const scaleMm = 8; // 8px per mm
    const bW = layout.boardWidth * scaleMm;
    const bH = layout.boardHeight * scaleMm;
    const ox = -bW / 2;
    const oy = -bH / 2;

    // Substrate backdrop
    ctx.fillStyle = '#18181b';
    ctx.fillRect(ox, oy, bW, bH);

    // Each layer is rendered from the actual generated Gerber commands. Clear polarity
    // removes only that layer's fill, so pour cuts cannot erase a different copper layer.
    const colors: Record<string, string> = { bottomCopper: '#38bdf8', topCopper: '#ef4444', topMask: '#10b981', bottomMask: '#a78bfa', topPaste: '#f9a8d4', topSilk: '#ffffff', outline: '#f59e0b' };
    const layers = buildGerberLayers(layout);
    for (const id of Object.keys(colors)) {
      if (!visibleLayers[id]) continue;
      const layer = layers.find(layer => layer.id === id);
      if (!layer) continue;
      const buffer = document.createElement('canvas'); buffer.width = width; buffer.height = height;
      const layerContext = buffer.getContext('2d');
      if (!layerContext) continue;
      layerContext.translate(width / 2 + pan.x, height / 2 + pan.y);
      layerContext.scale(fittedZoom, fittedZoom);
      layerContext.translate(ox, oy);
      renderGerberCommands(layerContext, parseGeneratedGerber(layer.contents), layout.boardHeight, scaleMm, colors[id]);
      ctx.save(); ctx.resetTransform(); ctx.drawImage(buffer, 0, 0); ctx.restore();
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
  }, [isOpen, layout, visibleLayers, fittedZoom, pan, viewport]);

  if (!isOpen) return null;

  const canvasPoint = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * canvas.width / rect.width, y: (e.clientY - rect.top) * canvas.height / rect.height };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsPanning(true);
    setStartPan({ x: canvasPoint(e).x - pan.x, y: canvasPoint(e).y - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: canvasPoint(e).x - startPan.x, y: canvasPoint(e).y - startPan.y });
    }
    const canvas = canvasRef.current;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const scaleMm = 8 * fittedZoom;
      const midX = canvas.width / 2 + pan.x;
      const midY = canvas.height / 2 + pan.y;
      const mmX = ((e.clientX - rect.left) * canvas.width / rect.width - midX) / scaleMm + layout.boardWidth / 2;
      const mmY = ((e.clientY - rect.top) * canvas.height / rect.height - midY) / scaleMm + layout.boardHeight / 2;
      // Quote fabrication-file coordinates, whose origin is the lower-left corner, so a
      // hovered feature reads the same here as it does in the Gerber and drill files.
      setMouseMm({
        x: Math.max(0, Math.min(layout.boardWidth, Math.round(mmX * 10) / 10)),
        y: Math.max(0, Math.min(layout.boardHeight, Math.round((layout.boardHeight - mmY) * 10) / 10))
      });
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(prev => Math.max(0.4, Math.min(5.0, prev * zoomFactor)));
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Fabrication package preview" style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.82)' }} className="flex items-center justify-center p-4 select-none">
      <div style={{ width: 'min(1200px, 96vw)', height: '88vh' }} className="bg-zinc-950 border border-zinc-800 rounded-2xl flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="fabrication-header flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
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
              {downloadedAll ? 'Downloaded Package!' : 'Download Package ZIP'}
            </button>
            <button
              onClick={onClose}
              aria-label="Close fabrication preview"
              className="p-1.5 text-zinc-400 hover:text-zinc-100 rounded-lg hover:bg-zinc-850 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Main Area */}
        <div className="fabrication-main flex-1 flex overflow-hidden">
          {/* Left Layer Controls & Files Sidebar */}
          <div className="fabrication-sidebar border-r border-zinc-800 bg-zinc-900/40 flex flex-col overflow-y-auto custom-scrollbar p-4 gap-4">
            <div>
              <div className="text-xs font-mono font-bold text-zinc-400 uppercase tracking-wider mb-2.5 flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-cyan-400" />
                Exported Layer Visibility
              </div>
              <div className="space-y-1.5 font-mono text-xs">
                {[
                  { id: 'topCopper', label: 'Top Copper (GTL)', color: '#ef4444' },
                  { id: 'bottomCopper', label: 'Bottom Copper (GBL)', color: '#38bdf8' },
                  { id: 'topMask', label: 'Top mask openings (GTS)', color: '#10b981' },
                  { id: 'bottomMask', label: 'Bottom mask openings (GBS)', color: '#a78bfa' },
                  { id: 'topPaste', label: 'Top paste (GTP)', color: '#f9a8d4' },
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

            <p className="text-xs text-amber-400">Illustrative footprints require package/pinout review. Behavioral IC pads are not complete production land patterns. Preview covers the AURA-generated Gerber subset; verify files in an independent CAM tool before ordering.</p>
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
          <div className="fabrication-canvas flex-1 flex flex-col relative bg-[#09090b] overflow-hidden">
            {/* Canvas Zoom & Tool HUD */}
            <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1 }} className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg p-1 text-xs font-mono text-zinc-300 shadow-xl">
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
            <div style={{ position: 'absolute', bottom: 10, right: 10, zIndex: 1 }} className="absolute bottom-3 right-3 z-10 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg px-3 py-1 text-xs font-mono text-zinc-400 shadow-xl">
              X: <span className="text-zinc-200">{mouseMm.x.toFixed(1)}</span> mm | Y: <span className="text-zinc-200">{mouseMm.y.toFixed(1)}</span> mm <span className="text-zinc-600">(file origin, lower-left)</span>
            </div>

            <canvas
              ref={canvasRef}
              width={viewport.width}
              height={viewport.height}
              style={{ display: 'block', width: '100%', height: '100%' }}
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
