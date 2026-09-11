import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { PCBLayoutData, PCBTrace, Pad, PCBVia } from '../types/pcb';
import { Route, Layers, Ruler, Trash2, CircleDot, ZoomIn, ZoomOut, RotateCcw, Sparkles } from 'lucide-react';
import { analyzeBoard, BOARD_RULES, getPadBoardCoords, pointSegmentDistance, segmentDistance } from '../analysis/boardChecks';

interface LayoutEditorProps {
  layoutData: PCBLayoutData;
  selectedCompId: string | null;
  onSelectComponent: (id: string | null) => void;
  onUpdateLayout: (data: PCBLayoutData) => void;
  drcErrors: string[];
}

export const LayoutEditor: React.FC<LayoutEditorProps> = ({
  layoutData,
  selectedCompId,
  onSelectComponent,
  onUpdateLayout,
  drcErrors
}) => {
  const [draggedFootprint, setDraggedFootprint] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [routingStart, setRoutingStart] = useState<{ pad: Pad; fpId: string; x: number; y: number } | null>(null);
  const [routingPoints, setRoutingPoints] = useState<{ x: number; y: number }[]>([]);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [activeLayer, setActiveLayer] = useState<'top' | 'bottom'>('top');
  const [isRouting, setIsRouting] = useState(false);
  const [traceWidthInput, setTraceWidthInput] = useState('0.40');
  const [showGroundPour, setShowGroundPour] = useState(false);
  const [routeNotice, setRouteNotice] = useState('');
  const [showMeasurements, setShowMeasurements] = useState(true);
  const [snap45, setSnap45] = useState(true);
  const [boardWInput, setBoardWInput] = useState(layoutData.boardWidth.toString());
  const [boardHInput, setBoardHInput] = useState(layoutData.boardHeight.toString());
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Conversion: 1mm = 8px
  const SCALE = 8;
  const boardWidthPx = layoutData.boardWidth * SCALE;
  const boardHeightPx = layoutData.boardHeight * SCALE;
  const activeTraceWidth = Math.max(0.15, parseFloat(traceWidthInput) || 0.4);

  // Board size also changes outside this editor (import, undo, a new project). Adjusting
  // during render re-syncs the text inputs without the extra commit an effect would cost.
  const [syncedSize, setSyncedSize] = useState({ w: layoutData.boardWidth, h: layoutData.boardHeight });
  if (syncedSize.w !== layoutData.boardWidth || syncedSize.h !== layoutData.boardHeight) {
    setSyncedSize({ w: layoutData.boardWidth, h: layoutData.boardHeight });
    setBoardWInput(layoutData.boardWidth.toString());
    setBoardHInput(layoutData.boardHeight.toString());
  }

  // Translate click coords to mm with zoom and pan
  const getMMCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    const centerX = rect.width / 2 + pan.x;
    const centerY = rect.height / 2 + pan.y;

    const mmX = (clientX - centerX) / (SCALE * zoom) + layoutData.boardWidth / 2;
    const mmY = (clientY - centerY) / (SCALE * zoom) + layoutData.boardHeight / 2;

    return {
      x: Math.round(mmX * 2) / 2,
      y: Math.round(mmY * 2) / 2
    };
  };

  // Snap proposed next point to horizontal, vertical, or 45-degree diagonal
  const snapTo45 = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    if (!snap45) return to;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx > 2.4 * absDy) {
      return { x: to.x, y: from.y }; // Horizontal
    } else if (absDy > 2.4 * absDx) {
      return { x: from.x, y: to.y }; // Vertical
    } else {
      // 45-degree diagonal
      const d = Math.min(absDx, absDy);
      return {
        x: Math.round((from.x + Math.sign(dx) * d) * 2) / 2,
        y: Math.round((from.y + Math.sign(dy) * d) * 2) / 2,
      };
    }
  };

  const calculateTraceLength = (trace: PCBTrace) => {
    let length = 0;
    for (let i = 0; i < trace.points.length - 1; i++) {
      const p1 = trace.points[i];
      const p2 = trace.points[i + 1];
      length += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
    return length;
  };

  const boardAnalysis = useMemo(() => analyzeBoard(layoutData), [layoutData]);
  const layoutMetrics = useMemo(() => {
    const routableNets = boardAnalysis.nets.filter(net => net.padCount > 1);
    const routedNets = routableNets.filter(net => net.fullyRouted);
    const totalTraceLength = layoutData.traces.reduce((sum, trace) => sum + calculateTraceLength(trace), 0);
    return {
      routableNets: routableNets.length,
      routedNets: routedNets.length,
      unroutedNets: routableNets.length - routedNets.length,
      totalTraceLength,
    };
  }, [layoutData, boardAnalysis]);

  // Canvas drawing loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Viewport dimensions
    const vW = canvas.width;
    const vH = canvas.height;

    // Clear viewport
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, vW, vH);

    ctx.save();
    // Center board and apply pan/zoom
    ctx.translate(vW / 2 + pan.x, vH / 2 + pan.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-boardWidthPx / 2, -boardHeightPx / 2);

    // Board substrate outline
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, boardWidthPx, boardHeightPx);
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, boardWidthPx, boardHeightPx);

    // Draw Grid dots (every 2mm)
    ctx.fillStyle = '#27272a';
    for (let x = 0; x < boardWidthPx; x += SCALE * 2) {
      for (let y = 0; y < boardHeightPx; y += SCALE * 2) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    const { footprints, traces, vias } = layoutData;

    // Ground pour flood visualization with thermal relief
    if (showGroundPour) {
      const pourColor = activeLayer === 'top' ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)';
      ctx.fillStyle = pourColor;
      ctx.fillRect(2, 2, boardWidthPx - 4, boardHeightPx - 4);
      ctx.strokeStyle = activeLayer === 'top' ? 'rgba(239, 68, 68, 0.35)' : 'rgba(59, 130, 246, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(2, 2, boardWidthPx - 4, boardHeightPx - 4);
      ctx.setLineDash([]);

      // Thermal relief spokes for GND pads
      footprints.forEach(fp => {
        fp.pads.filter(p => p.net === 'GND').forEach(pad => {
          const pc = getPadBoardCoords(fp, pad);
          const px = pc.x * SCALE;
          const py = pc.y * SCALE;
          const r = (pad.diameter / 2 + 0.5) * SCALE;
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(px - r, py); ctx.lineTo(px + r, py);
          ctx.moveTo(px, py - r); ctx.lineTo(px, py + r);
          ctx.stroke();
        });
      });
    }

    // 1. Draw Traces
    traces.forEach(trace => {
      if (trace.points.length < 2) return;
      ctx.beginPath();
      ctx.lineWidth = trace.width * SCALE;
      ctx.strokeStyle = trace.layer === 'top' ? '#ef4444' : '#3b82f6';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const p0 = trace.points[0];
      ctx.moveTo(p0.x * SCALE, p0.y * SCALE);
      for (let i = 1; i < trace.points.length; i++) {
        ctx.lineTo(trace.points[i].x * SCALE, trace.points[i].y * SCALE);
      }
      ctx.stroke();

      if (showMeasurements && trace.points.length > 1) {
        const midIndex = Math.floor((trace.points.length - 1) / 2);
        const a = trace.points[midIndex];
        const b = trace.points[midIndex + 1];
        const labelX = ((a.x + b.x) / 2) * SCALE;
        const labelY = ((a.y + b.y) / 2) * SCALE;
        const label = `${calculateTraceLength(trace).toFixed(1)}mm / ${trace.width.toFixed(2)}w`;
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelWidth = ctx.measureText(label).width + 8;
        ctx.fillStyle = 'rgba(9, 9, 11, 0.85)';
        ctx.fillRect(labelX - labelWidth / 2, labelY - 8, labelWidth, 16);
        ctx.fillStyle = trace.layer === 'top' ? '#fecaca' : '#bfdbfe';
        ctx.fillText(label, labelX, labelY);
      }
    });

    // 2. Draw Active Manual Routing Trace with 45-degree preview
    if (isRouting && routingStart) {
      ctx.beginPath();
      ctx.lineWidth = activeTraceWidth * SCALE;
      ctx.strokeStyle = activeLayer === 'top' ? 'rgba(239, 68, 68, 0.8)' : 'rgba(59, 130, 246, 0.8)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([4, 4]);

      ctx.moveTo(routingStart.x * SCALE, routingStart.y * SCALE);
      routingPoints.forEach(p => ctx.lineTo(p.x * SCALE, p.y * SCALE));

      const lastPoint = routingPoints.length > 0 ? routingPoints[routingPoints.length - 1] : routingStart;
      const previewPt = snap45 ? snapTo45(lastPoint, mousePos) : mousePos;
      ctx.lineTo(previewPt.x * SCALE, previewPt.y * SCALE);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. Draw Footprints and Pads
    footprints.forEach(fp => {
      ctx.save();
      ctx.translate(fp.x * SCALE, fp.y * SCALE);
      ctx.rotate((fp.rotation * Math.PI) / 180);

      const isSelected = selectedCompId === fp.id;
      ctx.strokeStyle = isSelected ? '#06b6d4' : '#52525b';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.fillStyle = 'rgba(24, 24, 27, 0.7)';

      const w = fp.width * SCALE;
      const h = fp.height * SCALE;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);

      // Silkscreen designator label
      ctx.fillStyle = isSelected ? '#22d3ee' : '#a1a1aa';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fp.id, 0, -h / 2 - 2);

      // Render Pads
      fp.pads.forEach(pad => {
        const px = pad.relX * SCALE;
        const py = pad.relY * SCALE;
        const padR = (pad.diameter / 2) * SCALE;
        const holeR = (pad.holeDiameter / 2) * SCALE;

        // Outer copper pad
        ctx.beginPath();
        ctx.arc(px, py, padR, 0, 2 * Math.PI);
        ctx.fillStyle = pad.holeDiameter > 0 ? '#f59e0b' : '#fbbf24'; // Through-hole vs SMD gold
        ctx.fill();

        // Inner drill hole if through-hole
        if (pad.holeDiameter > 0) {
          ctx.beginPath();
          ctx.arc(px, py, holeR, 0, 2 * Math.PI);
          ctx.fillStyle = '#09090b';
          ctx.fill();
        }

        // Net name text inside or beside pad
        if (pad.net) {
          ctx.fillStyle = '#18181b';
          ctx.font = '7px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pad.net.slice(0, 4), px, py);
        }
      });

      ctx.restore();
    });

    // 4. Draw Vias
    vias.forEach(via => {
      const vx = via.x * SCALE;
      const vy = via.y * SCALE;
      const viaR = (via.diameter / 2) * SCALE;
      const drillR = (via.drillDiameter / 2) * SCALE;

      ctx.beginPath();
      ctx.arc(vx, vy, viaR, 0, 2 * Math.PI);
      ctx.fillStyle = '#eab308';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(vx, vy, drillR, 0, 2 * Math.PI);
      ctx.fillStyle = '#09090b';
      ctx.fill();
    });

    // 5. Draw Ratsnest / Airwires with distance badges
    ctx.strokeStyle = 'rgba(168, 85, 247, 0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    boardAnalysis.airwires.forEach(({ from, to, net }) => {
      ctx.beginPath();
      ctx.moveTo(from.x * SCALE, from.y * SCALE);
      ctx.lineTo(to.x * SCALE, to.y * SCALE);
      ctx.stroke();

      if (showMeasurements) {
        const midX = ((from.x + to.x) / 2) * SCALE;
        const midY = ((from.y + to.y) / 2) * SCALE;
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const txt = `${net} (${dist.toFixed(1)}mm)`;
        ctx.font = '8px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#c084fc';
        ctx.fillText(txt, midX, midY - 4);
      }
    });
    ctx.setLineDash([]);

    // 6. DRC Issues Rings
    boardAnalysis.issues.forEach(issue => {
      if (issue.x === undefined || issue.y === undefined) return;
      ctx.beginPath();
      ctx.arc(issue.x * SCALE, issue.y * SCALE, 12, 0, 2 * Math.PI);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    ctx.restore();
  }, [layoutData, selectedCompId, routingStart, routingPoints, mousePos, activeLayer, isRouting, drcErrors, showGroundPour, showMeasurements, activeTraceWidth, boardWidthPx, boardHeightPx, boardAnalysis, zoom, pan, snap45]);

  // Handle canvas mouse actions
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Middle-click or Alt+click pans canvas
    if (e.button === 1 || e.altKey) {
      setIsCanvasPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    const mm = getMMCoords(e);

    // 1. Check if clicked on a pad (to start routing)
    let clickedPad: Pad | null = null;
    let clickedPadFpId = '';
    
    layoutData.footprints.forEach(fp => {
      fp.pads.forEach(pad => {
        const pc = getPadBoardCoords(fp, pad);
        const dist = Math.sqrt((mm.x - pc.x) ** 2 + (mm.y - pc.y) ** 2);
        if (dist <= pad.diameter / 2) {
          clickedPad = pad;
          clickedPadFpId = fp.id;
        }
      });
    });

    if (clickedPad && (clickedPad as Pad).net) {
      if (activeLayer === 'bottom' && (clickedPad as Pad).holeDiameter === 0) {
        setRouteNotice('Surface-mount pads are on top copper. Switch layers through a via first.');
        return;
      }
      setRouteNotice('');
      if (!isRouting) {
        // Start trace routing
        setIsRouting(true);
        const padCoords = getPadBoardCoords(
          layoutData.footprints.find(f => f.id === clickedPadFpId)!,
          clickedPad!
        );
        setRoutingStart({
          pad: clickedPad!,
          fpId: clickedPadFpId,
          x: padCoords.x,
          y: padCoords.y
        });
        setRoutingPoints([]);
      } else {
        // End trace routing by clicking on another pad of the SAME net
        const destPad = clickedPad as Pad;
        const start = routingStart;
        if (start && destPad.net && destPad.net === start.pad.net && (clickedPadFpId !== start.fpId || destPad.id !== start.pad.id)) {
          const padCoords = getPadBoardCoords(
            layoutData.footprints.find(f => f.id === clickedPadFpId)!,
            destPad
          );
          
          const finalPoints = [
            { x: start.x, y: start.y },
            ...routingPoints,
            { x: padCoords.x, y: padCoords.y }
          ];

          const newTrace: PCBTrace = {
            id: `trace_${Date.now()}`,
            net: destPad.net,
            points: finalPoints,
            width: activeTraceWidth,
            layer: activeLayer
          };

          onUpdateLayout({
            ...layoutData,
            traces: [...layoutData.traces, newTrace]
          });
        }
        setIsRouting(false);
        setRoutingStart(null);
        setRoutingPoints([]);
      }
      return;
    }

    // 2. Check if clicked on a footprint body (to drag)
    const clickedFp = layoutData.footprints.find(fp => {
      const angle = -fp.rotation * Math.PI / 180;
      const dx = mm.x - fp.x;
      const dy = mm.y - fp.y;
      const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
      const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
      return Math.abs(localX) <= fp.width / 2 && Math.abs(localY) <= fp.height / 2;
    });

    if (clickedFp) {
      if (isRouting) return;
      onSelectComponent(clickedFp.id);
      setDraggedFootprint(clickedFp.id);
      setDragOffset({
        x: mm.x - clickedFp.x,
        y: mm.y - clickedFp.y
      });
      return;
    }

    // 3. Clicked on empty space
    if (isRouting && routingStart) {
      const lastPoint = routingPoints.length > 0 ? routingPoints[routingPoints.length - 1] : routingStart;
      const nextPoint = snap45 ? snapTo45(lastPoint, mm) : mm;
      setRoutingPoints([...routingPoints, nextPoint]);
    } else {
      setIsCanvasPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      onSelectComponent(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mm = getMMCoords(e);
    setMousePos(mm);

    if (isCanvasPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      });
      return;
    }

    if (draggedFootprint) {
      const updatedFps = layoutData.footprints.map(fp => {
        if (fp.id === draggedFootprint) {
          const newX = Math.round(mm.x - dragOffset.x);
          const newY = Math.round(mm.y - dragOffset.y);
          return {
            ...fp,
            x: Math.max(5, Math.min(layoutData.boardWidth - 5, newX)),
            y: Math.max(5, Math.min(layoutData.boardHeight - 5, newY))
          };
        }
        return fp;
      });
      onUpdateLayout({ ...layoutData, footprints: updatedFps });
    }
  };

  const handleMouseUp = () => {
    setDraggedFootprint(null);
    setIsCanvasPanning(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(prev => Math.max(0.4, Math.min(4.0, prev * factor)));
  };

  const handleDropVia = useCallback(() => {
    const net = routingStart?.pad.net;
    if (!isRouting || !net) return;

    const newVia: PCBVia = {
      id: `via_${Date.now()}`,
      x: mousePos.x,
      y: mousePos.y,
      net,
      diameter: 0.85,
      drillDiameter: 0.4
    };

    const start = routingStart!;
    const segment: PCBTrace = {
      id: `trace_${crypto.randomUUID()}`, net, width: activeTraceWidth, layer: activeLayer,
      points: [{ x: start.x, y: start.y }, ...routingPoints, { ...mousePos }],
    };
    onUpdateLayout({
      ...layoutData,
      traces: [...layoutData.traces, segment],
      vias: [...layoutData.vias, newVia]
    });
    setRoutingStart({ ...start, x: mousePos.x, y: mousePos.y });
    setRoutingPoints([]);
    setActiveLayer(activeLayer === 'top' ? 'bottom' : 'top');
  }, [activeLayer, activeTraceWidth, isRouting, layoutData, mousePos, onUpdateLayout, routingPoints, routingStart]);

  const handleClearRoutes = () => {
    onUpdateLayout({
      ...layoutData,
      traces: [],
      vias: []
    });
    setIsRouting(false);
    setRoutingStart(null);
    setRoutingPoints([]);
    onSelectComponent(null);
  };

  // Keyboard rotation or trace deleting
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (e.key === 'Escape') {
        setIsRouting(false);
        setRoutingStart(null);
        setRoutingPoints([]);
      }
      if (e.key.toLowerCase() === 'r' && selectedCompId) {
        const updatedFps = layoutData.footprints.map(fp => {
          if (fp.id === selectedCompId) {
            return { ...fp, rotation: (fp.rotation + 90) % 360 };
          }
          return fp;
        });
        onUpdateLayout({ ...layoutData, footprints: updatedFps });
      }
      if (e.key === 'Delete' && selectedCompId) {
        if (selectedCompId.startsWith('trace_')) {
          onUpdateLayout({
            ...layoutData,
            traces: layoutData.traces.filter(t => t.id !== selectedCompId)
          });
          onSelectComponent(null);
        }
      }
      if (e.key.toLowerCase() === 'v' && isRouting) {
        handleDropVia();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedCompId, layoutData, onUpdateLayout, isRouting, handleDropVia, onSelectComponent]);

  // Enhanced multi-layer Lee autorouter
  const triggerAutoroute = () => {
    const gridSpacing = 1;
    const wCells = Math.floor(layoutData.boardWidth / gridSpacing) + 1;
    const hCells = Math.floor(layoutData.boardHeight / gridSpacing) + 1;
    if (wCells * hCells > 250_000) {
      setRouteNotice('This board is too large for the interactive 1mm-grid router. Route manually.');
      return;
    }
    const routedTraces = [...layoutData.traces];
    const routedVias = [...layoutData.vias];
    let searchedCells = 0;

    const roundObstacles = [
      ...layoutData.footprints.flatMap(fp => fp.pads.map(pad => ({
        ...getPadBoardCoords(fp, pad),
        radius: pad.diameter / 2,
        net: pad.net,
        isThroughHole: pad.holeDiameter > 0
      }))),
      ...routedVias.map(via => ({ ...via, radius: via.diameter / 2, isThroughHole: true })),
    ];
    const radius = activeTraceWidth / 2;
    const edge = radius + BOARD_RULES.edgeClearance;
    const inside = (p: { x: number; y: number }) => p.x >= edge && p.y >= edge &&
      p.x <= layoutData.boardWidth - edge && p.y <= layoutData.boardHeight - edge;

    const clearSegment = (a: { x: number; y: number }, b: { x: number; y: number }, net: string, layer: 'top' | 'bottom') => {
      if (!inside(a) || !inside(b)) return false;
      if (roundObstacles.some(pad => (!pad.net || pad.net !== net) &&
        (layer === 'top' || pad.isThroughHole) &&
        pointSegmentDistance(pad, a, b) < pad.radius + radius + BOARD_RULES.clearance - 1e-9)) return false;
      return !routedTraces.some(trace => trace.layer === layer && (!trace.net || trace.net !== net) &&
        trace.points.slice(1).some((p, i) => segmentDistance(a, b, trace.points[i], p) <
          trace.width / 2 + radius + BOARD_RULES.clearance - 1e-9));
    };

    const routeLayer = (from: { x: number; y: number }, to: { x: number; y: number }, net: string, layer: 'top' | 'bottom') => {
      const startC = Math.round(from.x / gridSpacing);
      const startR = Math.round(from.y / gridSpacing);
      const endC = Math.round(to.x / gridSpacing);
      const endR = Math.round(to.y / gridSpacing);
      if ([startC, endC].some(c => c < 0 || c >= wCells) || [startR, endR].some(r => r < 0 || r >= hCells)) return null;
      const start = startR * wCells + startC;
      const end = endR * wCells + endC;
      const toPoint = (index: number) => ({ x: index % wCells * gridSpacing, y: Math.floor(index / wCells) * gridSpacing });
      if (!clearSegment(from, toPoint(start), net, layer) || !clearSegment(toPoint(end), to, net, layer)) return null;

      const parent = new Int32Array(wCells * hCells).fill(-1);
      const queue = [start];
      parent[start] = start;
      let head = 0;
      while (head < queue.length && parent[end] === -1 && searchedCells < 80_000) {
        const current = queue[head++];
        searchedCells++;
        const c = current % wCells;
        const r = Math.floor(current / wCells);
        for (const [dc, dr] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
          const nextC = c + dc;
          const nextR = r + dr;
          if (nextC < 0 || nextR < 0 || nextC >= wCells || nextR >= hCells) continue;
          const next = nextR * wCells + nextC;
          if (parent[next] !== -1 || !clearSegment(toPoint(current), toPoint(next), net, layer)) continue;
          parent[next] = current;
          queue.push(next);
        }
      }
      if (parent[end] === -1) return null;
      const path = [to];
      for (let current = end; ; current = parent[current]) {
        path.push(toPoint(current));
        if (current === start) break;
      }
      path.push(from);
      path.reverse();
      const compact: { x: number; y: number }[] = [];
      path.forEach(point => {
        const last = compact.at(-1);
        if (last && last.x === point.x && last.y === point.y) return;
        const previous = compact.at(-2);
        if (previous && last && ((previous.x === last.x && last.x === point.x) ||
          (previous.y === last.y && last.y === point.y))) compact.pop();
        compact.push(point);
      });
      return compact.length >= 2 ? compact : null;
    };

    const attempted = new Set<string>();
    let added = 0;
    let attempts = 0;
    while (attempts < 120 && searchedCells < 100_000) {
      const analysis = analyzeBoard({ ...layoutData, traces: routedTraces, vias: routedVias });
      const connection = analysis.airwires.find(wire => !attempted.has(JSON.stringify(wire)));
      if (!connection) break;
      attempted.add(JSON.stringify(connection));
      attempts++;

      // Try top layer first
      let points = routeLayer(connection.from, connection.to, connection.net, 'top');
      let usedLayer: 'top' | 'bottom' = 'top';

      if (!points) {
        // Try bottom layer
        points = routeLayer(connection.from, connection.to, connection.net, 'bottom');
        if (points) usedLayer = 'bottom';
      }

      if (!points) continue;
      routedTraces.push({ id: `trace_${crypto.randomUUID()}`, net: connection.net, points, width: activeTraceWidth, layer: usedLayer });
      added++;
    }

    const missing = analyzeBoard({ ...layoutData, traces: routedTraces, vias: routedVias }).airwires.length;
    setRouteNotice(`Autorouter routed ${added} connections (${missing} remain).`);
    onUpdateLayout({ ...layoutData, traces: routedTraces, vias: routedVias });
  };

  const handleApplyBoardSize = () => {
    const w = parseFloat(boardWInput);
    const h = parseFloat(boardHInput);
    if (Number.isFinite(w) && w >= 20 && w <= 300 && Number.isFinite(h) && h >= 20 && h <= 300) {
      onUpdateLayout({ ...layoutData, boardWidth: Math.round(w), boardHeight: Math.round(h) });
    } else {
      setBoardWInput(layoutData.boardWidth.toString());
      setBoardHInput(layoutData.boardHeight.toString());
    }
  };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col relative h-full overflow-hidden select-none">
      {/* Floating Toolbar Controls */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2" style={{ maxWidth: 'calc(100% - 220px)' }}>
        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-3 text-xs text-zinc-400 font-mono">
          <button
            onClick={() => setActiveLayer(activeLayer === 'top' ? 'bottom' : 'top')}
            disabled={isRouting}
            title={isRouting ? 'Drop a via (V) to switch layers while routing' : 'Switch active copper layer'}
            className="flex items-center gap-1.5 hover:text-white transition-colors"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: activeLayer === 'top' ? '#ef4444' : '#3b82f6' }}
            ></span>
            Active: <span className="font-bold capitalize">{activeLayer}</span>
          </button>
        </div>

        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-2 text-xs text-zinc-400 font-mono">
          <Ruler className="w-3.5 h-3.5 text-cyan-400" />
          <span>Width</span>
          <input
            value={traceWidthInput}
            onChange={(e) => setTraceWidthInput(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-0.5 text-right text-zinc-200 font-mono"
            style={{ width: 48 }}
          />
          <span>mm</span>
        </div>

        {/* 45 Degree Snap Toggle */}
        <button
          onClick={() => setSnap45(!snap45)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono text-xs transition-all ${
            snap45
              ? 'bg-cyan-950/40 border-cyan-500/50 text-cyan-400 font-bold'
              : 'bg-zinc-900/80 border-zinc-800 text-zinc-400'
          }`}
          title="Snap trace segments to 45° angles"
        >
          45° Snap: {snap45 ? 'ON' : 'OFF'}
        </button>

        {/* Board Size Controls */}
        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-1.5 text-xs text-zinc-400 font-mono">
          <span>Board:</span>
          <input
            value={boardWInput}
            onChange={(e) => setBoardWInput(e.target.value)}
            onBlur={handleApplyBoardSize}
            className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-right text-zinc-200 font-mono w-11"
          />
          <span>×</span>
          <input
            value={boardHInput}
            onChange={(e) => setBoardHInput(e.target.value)}
            onBlur={handleApplyBoardSize}
            className="bg-zinc-950 border border-zinc-800 rounded px-1.5 py-0.5 text-right text-zinc-200 font-mono w-11"
          />
          <span>mm</span>
        </div>

        <button
          onClick={triggerAutoroute}
          disabled={isRouting}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 border border-cyan-500 rounded-lg text-white font-mono text-xs transition-all shadow-lg shadow-cyan-600/20 active:scale-95"
        >
          <Route className="w-3.5 h-3.5" />
          Multi-Layer Autorouter
        </button>

        <button
          onClick={handleDropVia}
          disabled={!isRouting}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/80 border border-zinc-800 rounded-lg text-zinc-300 font-mono text-xs transition-all"
          style={{ opacity: isRouting ? 1 : 0.45 }}
          title="Drop a via (V) and switch layer"
        >
          <CircleDot className="w-3.5 h-3.5 text-amber-500" />
          Via (V)
        </button>

        <button
          onClick={() => setShowGroundPour(!showGroundPour)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono text-xs transition-all ${
            showGroundPour
              ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-400 font-bold'
              : 'bg-zinc-900/80 border-zinc-800 text-zinc-400'
          }`}
        >
          <Layers className="w-3.5 h-3.5 text-emerald-400" />
          Copper Flood: {showGroundPour ? 'ON' : 'OFF'}
        </button>

        <button
          onClick={() => setShowMeasurements(!showMeasurements)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/80 border border-zinc-800 rounded-lg text-zinc-300 font-mono text-xs transition-all"
        >
          <Ruler className="w-3.5 h-3.5 text-purple-400" />
          Labels {showMeasurements ? 'On' : 'Off'}
        </button>

        <button
          onClick={handleClearRoutes}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-950/40 border border-red-900/50 rounded-lg text-red-400 font-mono text-xs transition-all"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg text-xs font-mono text-zinc-300">
          <button
            onClick={() => setZoom(prev => Math.min(4.0, prev * 1.2))}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoom(prev => Math.max(0.4, prev / 1.2))}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setZoom(1.0); setPan({ x: 0, y: 0 }); }}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
            title="Reset Zoom"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <span className="px-1 text-zinc-400">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* Notice bar */}
      {routeNotice && (
        <div className="absolute top-16 left-3 z-10 px-3 py-1.5 bg-zinc-900/90 border border-cyan-500/40 rounded-lg text-xs text-cyan-300 font-mono flex items-center gap-2 shadow-xl">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span>{routeNotice}</span>
          <button onClick={() => setRouteNotice('')} className="text-zinc-500 hover:text-zinc-300 ml-2">×</button>
        </div>
      )}

      {/* Bottom status & coordinates bar */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 px-3 py-1 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg text-xs font-mono text-zinc-400 shadow-xl">
        <span>X: <span className="text-zinc-200">{mousePos.x.toFixed(1)}</span> mm</span>
        <span>Y: <span className="text-zinc-200">{mousePos.y.toFixed(1)}</span> mm</span>
        <div className="h-3 w-px bg-zinc-800" />
        <span>Routed: <span className="text-emerald-400">{layoutMetrics.routedNets}/{layoutMetrics.routableNets}</span> nets</span>
        <span>Trace: <span className="text-cyan-400">{layoutMetrics.totalTraceLength.toFixed(1)}</span> mm</span>
      </div>

      {/* Canvas Area */}
      <div className="flex-1 flex items-center justify-center relative overflow-hidden">
        <canvas
          ref={canvasRef}
          width={boardWidthPx + 160}
          height={boardHeightPx + 160}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          className="cursor-crosshair w-full h-full"
        />
      </div>
    </div>
  );
};
