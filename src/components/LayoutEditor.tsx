import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { PCBLayoutData, PCBFootprint, PCBTrace, Pad, PCBVia } from '../types/pcb';
import { Route, CheckCircle, Layers, Ruler, Trash2, CircleDot } from 'lucide-react';

interface LayoutEditorProps {
  layoutData: PCBLayoutData;
  selectedCompId: string | null;
  onSelectComponent: (id: string | null) => void;
  onUpdateLayout: (data: PCBLayoutData) => void;
  drcErrors: string[];
  setDrcErrors: (errors: string[]) => void;
}

export const LayoutEditor: React.FC<LayoutEditorProps> = ({
  layoutData,
  selectedCompId,
  onSelectComponent,
  onUpdateLayout,
  drcErrors,
  setDrcErrors
}) => {
  const [draggedFootprint, setDraggedFootprint] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [routingStart, setRoutingStart] = useState<{ pad: Pad; fpId: string; x: number; y: number } | null>(null);
  const [routingPoints, setRoutingPoints] = useState<{ x: number; y: number }[]>([]);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [activeLayer, setActiveLayer] = useState<'top' | 'bottom'>('top');
  const [isRouting, setIsRouting] = useState(false);
  const [traceWidthInput, setTraceWidthInput] = useState('0.40');
  const [showGroundPour, setShowGroundPour] = useState(true);
  const [showMeasurements, setShowMeasurements] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Conversion: 1mm = 8px
  const SCALE = 8;
  const boardWidthPx = layoutData.boardWidth * SCALE;
  const boardHeightPx = layoutData.boardHeight * SCALE;
  const activeTraceWidth = Math.max(0.15, parseFloat(traceWidthInput) || 0.4);

  // Translate click coords to mm
  const getMMCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / SCALE;
    const y = (e.clientY - rect.top) / SCALE;
    // Snap to 0.5mm grid
    return {
      x: Math.round(x * 2) / 2,
      y: Math.round(y * 2) / 2
    };
  };

  // Get absolute coordinates of a pad on the board in mm
  const getPadBoardCoords = useCallback((fp: PCBFootprint, pad: Pad) => {
    const rad = (fp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Rotate local pad coordinates relative to footprint center
    const rx = pad.relX * cos - pad.relY * sin;
    const ry = pad.relX * sin + pad.relY * cos;

    return {
      x: fp.x + rx,
      y: fp.y + ry
    };
  }, []);

  const calculateTraceLength = (trace: PCBTrace) => {
    let length = 0;
    for (let i = 0; i < trace.points.length - 1; i++) {
      const p1 = trace.points[i];
      const p2 = trace.points[i + 1];
      length += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
    return length;
  };

  const layoutMetrics = useMemo(() => {
    const netToPads: Record<string, number> = {};
    layoutData.footprints.forEach(fp => {
      fp.pads.forEach(pad => {
        if (!pad.net || pad.net === 'GND') return;
        netToPads[pad.net] = (netToPads[pad.net] || 0) + 1;
      });
    });

    const routableNets = Object.keys(netToPads).filter(net => netToPads[net] > 1);
    const routedNets = routableNets.filter(net => layoutData.traces.some(trace => trace.net === net));
    const totalTraceLength = layoutData.traces.reduce((sum, trace) => sum + calculateTraceLength(trace), 0);
    const copperArea = layoutData.traces.reduce((sum, trace) => sum + calculateTraceLength(trace) * trace.width, 0);
    const boardArea = Math.max(1, layoutData.boardWidth * layoutData.boardHeight);

    return {
      routableNets: routableNets.length,
      routedNets: routedNets.length,
      unroutedNets: Math.max(0, routableNets.length - routedNets.length),
      totalTraceLength,
      copperDensity: (copperArea / boardArea) * 100
    };
  }, [layoutData]);

  // Run Design Rule Checking (DRC)
  // Check for overlap of traces/pads belonging to different nets
  const runDRC = useCallback(() => {
    const errors: string[] = [];
    const minClearance = 0.25; // 0.25mm minimum clearance

    const { footprints, traces, vias } = layoutData;

    footprints.forEach(fp => {
      if (
        fp.x - fp.width / 2 < 0 ||
        fp.x + fp.width / 2 > layoutData.boardWidth ||
        fp.y - fp.height / 2 < 0 ||
        fp.y + fp.height / 2 > layoutData.boardHeight
      ) {
        errors.push(`Board edge violation: Footprint ${fp.id} exceeds the board outline`);
      }
    });

    traces.forEach(trace => {
      if (trace.width < 0.2) {
        errors.push(`Fabrication violation: Trace ${trace.net} width ${trace.width.toFixed(2)}mm is below 0.20mm`);
      }
      trace.points.forEach(point => {
        if (point.x < 0 || point.x > layoutData.boardWidth || point.y < 0 || point.y > layoutData.boardHeight) {
          errors.push(`Board edge violation: Trace ${trace.net} exits the board outline`);
        }
      });
    });

    vias.forEach(via => {
      if (via.drillDiameter < 0.35) {
        errors.push(`Fabrication violation: Via ${via.id} drill ${via.drillDiameter.toFixed(2)}mm is below 0.35mm`);
      }
      if (via.x < 0 || via.x > layoutData.boardWidth || via.y < 0 || via.y > layoutData.boardHeight) {
        errors.push(`Board edge violation: Via ${via.id} exits the board outline`);
      }
    });

    // Helper: distance between point and line segment
    const distPointToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
      const l2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;
      if (l2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
      let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
      t = Math.max(0, Math.min(1, t));
      return Math.sqrt((px - (x1 + t * (x2 - x1))) ** 2 + (py - (y1 + t * (y2 - y1))) ** 2);
    };

    // 1. Check footprint pads vs footprint pads (different nets)
    for (let i = 0; i < footprints.length; i++) {
      const fp1 = footprints[i];
      for (let j = i + 1; j < footprints.length; j++) {
        const fp2 = footprints[j];
        fp1.pads.forEach(p1 => {
          fp2.pads.forEach(p2 => {
            if (p1.net && p2.net && p1.net !== p2.net) {
              const c1 = getPadBoardCoords(fp1, p1);
              const c2 = getPadBoardCoords(fp2, p2);
              const dist = Math.sqrt((c1.x - c2.x) ** 2 + (c1.y - c2.y) ** 2);
              const r1 = p1.diameter / 2;
              const r2 = p2.diameter / 2;
              if (dist < r1 + r2 + minClearance) {
                errors.push(`Clearance violation: Pad ${fp1.id}:${p1.id} to Pad ${fp2.id}:${p2.id} (${(dist - r1 - r2).toFixed(2)}mm)`);
              }
            }
          });
        });
      }
    }

    // 2. Check trace vs pad (different nets)
    traces.forEach(trace => {
      footprints.forEach(fp => {
        fp.pads.forEach(pad => {
          if (pad.net && trace.net !== pad.net) {
            const padCoords = getPadBoardCoords(fp, pad);
            for (let i = 0; i < trace.points.length - 1; i++) {
              const p1 = trace.points[i];
              const p2 = trace.points[i + 1];
              const dist = distPointToSegment(padCoords.x, padCoords.y, p1.x, p1.y, p2.x, p2.y);
              const padRadius = pad.diameter / 2;
              const traceRadius = trace.width / 2;
              if (dist < padRadius + traceRadius + minClearance) {
                errors.push(`Clearance violation: Trace ${trace.net} to Pad ${fp.id}:${pad.id} (${(dist - padRadius - traceRadius).toFixed(2)}mm)`);
              }
            }
          }
        });
      });
    });

    // 3. Check trace vs trace (different nets)
    for (let i = 0; i < traces.length; i++) {
      const t1 = traces[i];
      for (let j = i + 1; j < traces.length; j++) {
        const t2 = traces[j];
        if (t1.net !== t2.net) {
          // Check segments
          for (let s1 = 0; s1 < t1.points.length - 1; s1++) {
            const a1 = t1.points[s1];
            const a2 = t1.points[s1 + 1];
            for (let s2 = 0; s2 < t2.points.length - 1; s2++) {
              const b1 = t2.points[s2];
              const b2 = t2.points[s2 + 1];

              // Approximate check: minimum distance between two segments
              // We'll check endpoints distances
              const dist1 = distPointToSegment(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y);
              const dist2 = distPointToSegment(a2.x, a2.y, b1.x, b1.y, b2.x, b2.y);
              const minDist = Math.min(dist1, dist2);
              const rSum = t1.width / 2 + t2.width / 2;
              if (minDist < rSum + minClearance) {
                errors.push(`Clearance violation: Trace ${t1.net} to Trace ${t2.net} (${(minDist - rSum).toFixed(2)}mm)`);
              }
            }
          }
        }
      }
    }

    setDrcErrors(errors);
  }, [layoutData, setDrcErrors, getPadBoardCoords]);

  // Run DRC and draw airwires whenever components or traces change
  useEffect(() => {
    runDRC();
  }, [runDRC]);

  // Canvas drawing loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, boardWidthPx, boardHeightPx);

    // Draw Grid dots
    ctx.fillStyle = '#27272a';
    for (let x = 0; x < boardWidthPx; x += SCALE * 2) {
      for (let y = 0; y < boardHeightPx; y += SCALE * 2) {
        ctx.fillRect(x, y, 1, 1);
      }
    }

    const { footprints, traces, vias } = layoutData;

    // Ground pour visualization
    if (showGroundPour) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(0, 0, boardWidthPx, boardHeightPx);
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(4, 4, boardWidthPx - 8, boardHeightPx - 8);
      ctx.setLineDash([]);
    }

    // 1. Draw Traces
    traces.forEach(trace => {
      ctx.beginPath();
      ctx.lineWidth = trace.width * SCALE;
      ctx.strokeStyle = trace.layer === 'top' ? '#ef4444' : '#3b82f6'; // Red for top layer, blue for bottom
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
        ctx.fillStyle = 'rgba(9, 9, 11, 0.82)';
        ctx.fillRect(labelX - labelWidth / 2, labelY - 8, labelWidth, 16);
        ctx.fillStyle = trace.layer === 'top' ? '#fecaca' : '#bfdbfe';
        ctx.fillText(label, labelX, labelY);
      }
    });

    // 2. Draw Active Manual Routing Trace
    if (isRouting && routingStart) {
      ctx.beginPath();
      ctx.lineWidth = activeTraceWidth * SCALE;
      ctx.strokeStyle = activeLayer === 'top' ? 'rgba(239, 68, 68, 0.7)' : 'rgba(59, 130, 246, 0.7)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([4, 4]);

      ctx.moveTo(routingStart.x * SCALE, routingStart.y * SCALE);
      routingPoints.forEach(pt => {
        ctx.lineTo(pt.x * SCALE, pt.y * SCALE);
      });
      ctx.lineTo(mousePos.x * SCALE, mousePos.y * SCALE);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. Draw Footprints
    footprints.forEach(fp => {
      const isSelected = selectedCompId === fp.id;
      
      ctx.save();
      ctx.translate(fp.x * SCALE, fp.y * SCALE);
      ctx.rotate((fp.rotation * Math.PI) / 180);

      // Footprint outline
      ctx.strokeStyle = isSelected ? '#06b6d4' : '#10b981'; // Cyan if selected, Emerald for silkscreen
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        (-fp.width / 2) * SCALE,
        (-fp.height / 2) * SCALE,
        fp.width * SCALE,
        fp.height * SCALE
      );

      // Text label (Designator)
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(fp.id, 0, (-fp.height / 2 - 1.5) * SCALE);

      // Draw component type/value symbol
      ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
      ctx.fillRect(
        (-fp.width / 2 + 0.5) * SCALE,
        (-fp.height / 2 + 0.5) * SCALE,
        (fp.width - 1.0) * SCALE,
        (fp.height - 1.0) * SCALE
      );

      ctx.restore();

      // Draw Pads
      fp.pads.forEach(pad => {
        const pc = getPadBoardCoords(fp, pad);
        
        // Pad copper ring
        ctx.beginPath();
        ctx.arc(pc.x * SCALE, pc.y * SCALE, (pad.diameter / 2) * SCALE, 0, 2 * Math.PI);
        ctx.fillStyle = '#f59e0b'; // Gold copper color
        ctx.fill();

        // Through hole (if present)
        if (pad.holeDiameter > 0) {
          ctx.beginPath();
          ctx.arc(pc.x * SCALE, pc.y * SCALE, (pad.holeDiameter / 2) * SCALE, 0, 2 * Math.PI);
          ctx.fillStyle = '#09090b'; // board background hole
          ctx.fill();
        }

        // Net labeling text inside pad
        if (pad.net) {
          ctx.fillStyle = '#000000';
          ctx.font = '7px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pad.id, pc.x * SCALE, pc.y * SCALE);
        }
      });
    });

    // 4. Draw Vias
    vias.forEach(via => {
      ctx.beginPath();
      ctx.arc(via.x * SCALE, via.y * SCALE, (via.diameter / 2) * SCALE, 0, 2 * Math.PI);
      ctx.fillStyle = '#06b6d4'; // teal cyan for vias
      ctx.fill();

      ctx.beginPath();
      ctx.arc(via.x * SCALE, via.y * SCALE, (via.drillDiameter / 2) * SCALE, 0, 2 * Math.PI);
      ctx.fillStyle = '#09090b'; // hole
      ctx.fill();
    });

    // 5. Draw Ratsnest airwires (Unrouted Net Connections)
    // Find all nets in footprints
    const netToPads: Record<string, { x: number; y: number }[]> = {};
    footprints.forEach(fp => {
      fp.pads.forEach(pad => {
        if (pad.net && pad.net !== 'GND') { // GND can use solid copper pour, we skip GND in ratsnest for clean view
          if (!netToPads[pad.net]) netToPads[pad.net] = [];
          netToPads[pad.net].push(getPadBoardCoords(fp, pad));
        }
      });
    });

    // For each net, draw dotted lines connecting all pads, skipping if already routed
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.45)'; // trans gold
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);

    Object.keys(netToPads).forEach(net => {
      const pads = netToPads[net];
      if (pads.length < 2) return;

      // Draw ratsnest lines in a daisy chain
      for (let i = 0; i < pads.length - 1; i++) {
        // Simple routing check: has this net already been routed between these pads?
        // We look if there is a trace for this net
        const isRouted = traces.some(t => t.net === net);
        if (!isRouted) {
          ctx.beginPath();
          ctx.moveTo(pads[i].x * SCALE, pads[i].y * SCALE);
          ctx.lineTo(pads[i + 1].x * SCALE, pads[i + 1].y * SCALE);
          ctx.stroke();
        }
      }
    });
    ctx.setLineDash([]);

    // 6. Draw DRC Violation Markers
    // Parse DRC messages to find locations and highlight
    drcErrors.forEach(err => {
      // Crude parsing to find which pads are involved
      const match = err.match(/Pad ([R|C|Q|U|V]\d+:\w+)/g);
      if (match) {
        match.forEach(pLabel => {
          const cleanLabel = pLabel.replace('Pad ', '');
          const [fpId, padId] = cleanLabel.split(':');
          const fp = footprints.find(f => f.id === fpId);
          const pad = fp?.pads.find(p => p.id === padId);
          if (fp && pad) {
            const pc = getPadBoardCoords(fp, pad);
            ctx.beginPath();
            ctx.arc(pc.x * SCALE, pc.y * SCALE, (pad.diameter + 0.5) * SCALE, 0, 2 * Math.PI);
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 2;
            ctx.setLineDash([2, 2]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        });
      }
    });

  }, [layoutData, selectedCompId, routingStart, routingPoints, mousePos, activeLayer, isRouting, drcErrors, showGroundPour, showMeasurements, activeTraceWidth, boardWidthPx, boardHeightPx, getPadBoardCoords]);

  // Handle canvas mouse actions
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
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
        if (start && destPad.net && destPad.net === start.pad.net && clickedPadFpId !== start.fpId) {
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
      const halfW = fp.width / 2;
      const halfH = fp.height / 2;
      return (
        mm.x >= fp.x - halfW &&
        mm.x <= fp.x + halfW &&
        mm.y >= fp.y - halfH &&
        mm.y <= fp.y + halfH
      );
    });

    if (clickedFp) {
      if (isRouting) return; // ignore footprint drags while routing
      onSelectComponent(clickedFp.id);
      setDraggedFootprint(clickedFp.id);
      setDragOffset({
        x: mm.x - clickedFp.x,
        y: mm.y - clickedFp.y
      });
      return;
    }

    // 3. Clicked on empty space
    if (isRouting) {
      // Lay down intermediate routing corner
      setRoutingPoints([...routingPoints, mm]);
    } else {
      onSelectComponent(null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const mm = getMMCoords(e);
    setMousePos(mm);

    if (draggedFootprint) {
      const updatedFps = layoutData.footprints.map(fp => {
        if (fp.id === draggedFootprint) {
          // grid snapping of footprint placement (1mm grid)
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

    onUpdateLayout({
      ...layoutData,
      vias: [...layoutData.vias, newVia]
    });
    setRoutingPoints([...routingPoints, mousePos]);
    setActiveLayer(activeLayer === 'top' ? 'bottom' : 'top');
  }, [activeLayer, isRouting, layoutData, mousePos, onUpdateLayout, routingPoints, routingStart]);

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
        // Check if selectedCompId matches a trace ID
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

  // Lee's Grid Autorouter (BFS Pathfinding on 1.0mm grid)
  const triggerAutoroute = () => {
    const gridSpacing = 1.0; // mm
    const wCells = Math.ceil(layoutData.boardWidth / gridSpacing);
    const hCells = Math.ceil(layoutData.boardHeight / gridSpacing);

    // Get all nets that have pins needing connection
    const netToPads: Record<string, { x: number; y: number; padId: string; fpId: string }[]> = {};
    layoutData.footprints.forEach(fp => {
      fp.pads.forEach(pad => {
        if (pad.net && pad.net !== 'GND') { // GND is connected to ground plane
          if (!netToPads[pad.net]) netToPads[pad.net] = [];
          const coords = getPadBoardCoords(fp, pad);
          netToPads[pad.net].push({
            x: coords.x,
            y: coords.y,
            padId: pad.id,
            fpId: fp.id
          });
        }
      });
    });

    const routedTraces: PCBTrace[] = [...layoutData.traces];

    // Build obstacle map from footprints centers
    // Grid: true for occupied/obstacle, false for open
    const baseObstacles = Array(hCells).fill(0).map(() => Array(wCells).fill(false));

    // Place obstacle boxes around component bodies (excluding their pads)
    layoutData.footprints.forEach(fp => {
      const minCol = Math.max(0, Math.floor((fp.x - fp.width / 2 + 1) / gridSpacing));
      const maxCol = Math.min(wCells - 1, Math.ceil((fp.x + fp.width / 2 - 1) / gridSpacing));
      const minRow = Math.max(0, Math.floor((fp.y - fp.height / 2 + 1) / gridSpacing));
      const maxRow = Math.min(hCells - 1, Math.ceil((fp.y + fp.height / 2 - 1) / gridSpacing));

      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          baseObstacles[r][c] = true;
        }
      }
    });

    // Helper: A* or BFS routing between two nodes
    const routeNets = (
      xStart: number, yStart: number,
      xEnd: number, yEnd: number,
      currentNetName: string
    ): { x: number; y: number }[] | null => {
      // Convert mm to grid indices
      const startC = Math.round(xStart / gridSpacing);
      const startR = Math.round(yStart / gridSpacing);
      const endC = Math.round(xEnd / gridSpacing);
      const endR = Math.round(yEnd / gridSpacing);

      // BFS Queue
      const queue: [number, number][] = [[startR, startC]];
      const visited = Array(hCells).fill(0).map(() => Array(wCells).fill(false));
      const parent: Record<string, string> = {};

      visited[startR][startC] = true;

      // Directions: N, S, E, W
      const dRow = [-1, 1, 0, 0];
      const dCol = [0, 0, 1, -1];

      let found = false;

      while (queue.length > 0) {
        const [r, c] = queue.shift()!;
        if (r === endR && c === endC) {
          found = true;
          break;
        }

        for (let d = 0; d < 4; d++) {
          const nextR = r + dRow[d];
          const nextC = c + dCol[d];

          if (
            nextR >= 0 && nextR < hCells &&
            nextC >= 0 && nextC < wCells &&
            !visited[nextR][nextC]
          ) {
            // Check if grid node is blocked
            // It is blocked if it's in baseObstacles and NOT the start or end cell
            let isBlocked = baseObstacles[nextR][nextC];
            
            // Check if blocked by already routed traces of OTHER nets
            routedTraces.forEach(trace => {
              if (trace.net !== currentNetName) {
                trace.points.forEach(pt => {
                  const ptC = Math.round(pt.x / gridSpacing);
                  const ptR = Math.round(pt.y / gridSpacing);
                  if (ptC === nextC && ptR === nextR) {
                    isBlocked = true;
                  }
                });
              }
            });

            if (!isBlocked || (nextR === endR && nextC === endC)) {
              visited[nextR][nextC] = true;
              queue.push([nextR, nextC]);
              parent[`${nextR},${nextC}`] = `${r},${c}`;
            }
          }
        }
      }

      if (!found) return null;

      // Reconstruct path
      const path: { x: number; y: number }[] = [];
      let curr = `${endR},${endC}`;
      while (curr) {
        const [r, c] = curr.split(',').map(Number);
        path.unshift({ x: c * gridSpacing, y: r * gridSpacing });
        curr = parent[curr];
      }

      // Add actual high precision pad terminals
      path[0] = { x: xStart, y: yStart };
      path[path.length - 1] = { x: xEnd, y: yEnd };

      return path;
    };

    // Process each net and lay down paths
    Object.keys(netToPads).forEach(net => {
      const pads = netToPads[net];
      if (pads.length < 2) return;

      // Check if already routed, if so skip
      const alreadyRouted = routedTraces.some(t => t.net === net);
      if (alreadyRouted) return;

      // Route sequential pairs
      for (let i = 0; i < pads.length - 1; i++) {
        const p1 = pads[i];
        const p2 = pads[i + 1];

        const pathPoints = routeNets(p1.x, p1.y, p2.x, p2.y, net);
        if (pathPoints) {
          const newTrace: PCBTrace = {
            id: `trace_${net}_${i}_${Date.now()}`,
            net,
            points: pathPoints,
            width: activeTraceWidth,
            layer: 'top'
          };
          routedTraces.push(newTrace);
        }
      }
    });

    onUpdateLayout({
      ...layoutData,
      traces: routedTraces
    });
  };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col relative h-full">
      {/* Floating Toolbar Controls */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap gap-2" style={{ maxWidth: 'calc(100% - 210px)' }}>
        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-3 text-xs text-zinc-400 font-mono">
          <button
            onClick={() => setActiveLayer(activeLayer === 'top' ? 'bottom' : 'top')}
            className="flex items-center gap-1.5 hover:text-white transition-colors"
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: activeLayer === 'top' ? '#ef4444' : '#3b82f6' }}
            ></span>
            Active Layer: <span className="font-bold capitalize">{activeLayer}</span>
          </button>
        </div>

        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-2 text-xs text-zinc-400 font-mono">
          <Ruler className="w-3.5 h-3.5 text-cyan-400" />
          <span>Width</span>
          <input
            value={traceWidthInput}
            onChange={(e) => setTraceWidthInput(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-right text-zinc-200 font-mono"
            style={{ width: 58 }}
          />
          <span>mm</span>
        </div>

        <button
          onClick={triggerAutoroute}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 border border-cyan-500 rounded-lg text-white font-mono text-xs transition-all shadow-lg shadow-cyan-600/20 active:scale-95"
        >
          <Route className="w-3.5 h-3.5" />
          Run Lee's Autorouter
        </button>

        <button
          onClick={handleDropVia}
          disabled={!isRouting}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/80 border border-zinc-800 rounded-lg text-zinc-300 font-mono text-xs transition-all"
          style={{ opacity: isRouting ? 1 : 0.45 }}
          title="Drop a via at the cursor and switch layers"
        >
          <CircleDot className="w-3.5 h-3.5 text-amber-500" />
          Drop Via
        </button>

        <button
          onClick={() => setShowGroundPour(!showGroundPour)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900/80 border border-zinc-800 rounded-lg text-zinc-300 font-mono text-xs transition-all"
        >
          <Layers className="w-3.5 h-3.5 text-emerald-400" />
          Ground Pour {showGroundPour ? 'On' : 'Off'}
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
          Clear Routes
        </button>

        {isRouting && (
          <span className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-950/60 border border-purple-800 rounded-lg text-purple-400 font-mono text-xs animate-pulse">
            Routing {routingStart?.pad.net}: click pads, click empty space for corners, press V for via
          </span>
        )}
      </div>

      <div className="absolute top-3 right-3 z-10 px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex flex-col gap-1.5 text-xs font-mono">
        <div>
          {drcErrors.length === 0 ? (
            <span className="text-emerald-400 flex items-center gap-1">
              <CheckCircle className="w-3.5 h-3.5" /> DRC Passed
            </span>
          ) : (
            <span className="text-red-400 flex items-center gap-1">
              <AlertTriangleIcon className="w-3.5 h-3.5" /> DRC Violations: {drcErrors.length}
            </span>
          )}
        </div>
        <div className="text-zinc-500">
          Routed: <span className="text-zinc-300">{layoutMetrics.routedNets}/{layoutMetrics.routableNets}</span>
        </div>
        <div className="text-zinc-500">
          Copper: <span className="text-zinc-300">{layoutMetrics.totalTraceLength.toFixed(1)}mm</span>
          <span> / </span>
          <span className="text-zinc-300">{layoutMetrics.copperDensity.toFixed(1)}%</span>
        </div>
        {layoutMetrics.unroutedNets > 0 && (
          <div className="text-amber-500">Unrouted nets: {layoutMetrics.unroutedNets}</div>
        )}
      </div>

      {/* Canvas container */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-4">
        <canvas
          ref={canvasRef}
          width={boardWidthPx}
          height={boardHeightPx}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          className="border border-zinc-800 rounded-lg shadow-2xl relative select-none cursor-crosshair max-w-full"
          onContextMenu={(e) => {
            e.preventDefault();
            if (isRouting) {
              setIsRouting(false);
              setRoutingStart(null);
              setRoutingPoints([]);
            }
          }}
        />
      </div>
    </div>
  );
};

// Internal icon proxy helper for DRC Alert icon
const AlertTriangleIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
