import React, { useState, useRef, useEffect } from 'react';
import type { SchematicComponent, Wire, SchematicData, Pin } from '../types/pcb';
import { ZoomIn, ZoomOut, RotateCcw, Trash2 } from 'lucide-react';

interface SchematicEditorProps {
  data: SchematicData;
  selectedComponent: SchematicComponent | null;
  onSelectComponent: (comp: SchematicComponent | null) => void;
  onUpdateComponent: (comp: SchematicComponent) => void;
  onDeleteComponent?: (id: string) => void;
  onAddWire: (wire: Wire) => void;
  onDeleteWire: (id: string) => void;
  simVoltages?: Record<string, number>; // current time-step voltages
  simCurrents?: Record<string, number>; // current time-step currents
}

export const SchematicEditor: React.FC<SchematicEditorProps> = ({
  data,
  selectedComponent,
  onSelectComponent,
  onUpdateComponent,
  onDeleteComponent,
  onAddWire,
  onDeleteWire,
  simVoltages,
  simCurrents
}) => {
  const [draggedComp, setDraggedComp] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [wireStart, setWireStart] = useState<{ compId: string; pinId: string; x: number; y: number } | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);

  // SVG dimensions
  const width = 800;
  const height = 550;

  // Convert client coordinates to SVG coordinates (accounting for zoom and pan)
  const getSVGCoords = (e: React.MouseEvent) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;
    const svgX = (clientX - pan.x) / zoom;
    const svgY = (clientY - pan.y) / zoom;
    const x = Math.round(svgX / 10) * 10;
    const y = Math.round(svgY / 10) * 10;
    return { x, y };
  };

  // Keyboard shortcut listener (Rotation with 'R' or Delete with 'Del'/'Backspace')
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { setWireStart(null); return; }
      if (!selectedComponent) return;

      if (e.key.toLowerCase() === 'r') {
        const nextRot = (selectedComponent.rotation + 90) % 360;
        onUpdateComponent({ ...selectedComponent, rotation: nextRot });
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedComponent.type === 'gnd' && selectedComponent.pins.length === 0) {
          onDeleteWire(selectedComponent.id);
        } else if (onDeleteComponent) {
          onDeleteComponent(selectedComponent.id);
        }
        onSelectComponent(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponent, onUpdateComponent, onDeleteComponent, onDeleteWire, onSelectComponent]);

  // Handle dragging components
  const handleMouseDown = (e: React.MouseEvent, comp: SchematicComponent) => {
    if (wireStart) return; // Wiring has priority
    e.stopPropagation();
    onSelectComponent(comp);
    setDraggedComp(comp.id);
    const coords = getSVGCoords(e);
    setDragOffset({
      x: coords.x - comp.x,
      y: coords.y - comp.y
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const coords = getSVGCoords(e);
    setMousePos(coords);

    if (draggedComp) {
      const comp = data.components.find(c => c.id === draggedComp);
      if (comp) {
        // Snap to grid of 10px
        const newX = Math.round((coords.x - dragOffset.x) / 10) * 10;
        const newY = Math.round((coords.y - dragOffset.y) / 10) * 10;
        onUpdateComponent({
          ...comp,
          x: Math.max(20, Math.min(width * 2, newX)),
          y: Math.max(20, Math.min(height * 2, newY))
        });
      }
    } else if (isCanvasPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setDraggedComp(null);
    setIsCanvasPanning(false);
  };

  // Canvas background mouse down for panning
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || e.altKey || (e.button === 0 && !wireStart && !draggedComp)) {
      setIsCanvasPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };

  // Wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom(prev => Math.max(0.4, Math.min(3.0, prev * zoomFactor)));
  };

  // Handle pin click for wiring
  const handlePinMouseDown = (e: React.MouseEvent, comp: SchematicComponent, pin: Pin) => {
    e.stopPropagation();
    const pinCoords = getAbsolutePinCoords(comp, pin);
    if (!wireStart) {
      setWireStart({
        compId: comp.id,
        pinId: pin.id,
        x: pinCoords.x,
        y: pinCoords.y
      });
    } else {
      // Complete wiring
      if (wireStart.compId !== comp.id || wireStart.pinId !== pin.id) {
        const wirePoints = [
          { x: wireStart.x, y: wireStart.y },
          // Orthogonal routing point
          { x: pinCoords.x, y: wireStart.y },
          { x: pinCoords.x, y: pinCoords.y }
        ];

        onAddWire({
          id: `w_${wireStart.compId}_${wireStart.pinId}_${comp.id}_${pin.id}`,
          fromCompId: wireStart.compId,
          fromPinId: wireStart.pinId,
          toCompId: comp.id,
          toPinId: pin.id,
          points: wirePoints,
          net: '' // net list solver will assign
        });
      }
      setWireStart(null);
    }
  };

  // Cancel wiring or deselect on canvas click
  const handleCanvasClick = () => {
    if (wireStart) {
      setWireStart(null);
    } else if (!isCanvasPanning) {
      onSelectComponent(null);
    }
  };

  // Get absolute pin coordinate in SVG space based on component placement and rotation
  const getAbsolutePinCoords = (comp: SchematicComponent, pin: Pin) => {
    const rad = (comp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const rx = pin.relX * cos - pin.relY * sin;
    const ry = pin.relX * sin + pin.relY * cos;

    return {
      x: comp.x + rx,
      y: comp.y + ry
    };
  };

  // Render Component SVG Symbol based on its type
  const renderSymbol = (comp: SchematicComponent) => {
    const isSelected = selectedComponent?.id === comp.id;
    const color = isSelected ? '#06b6d4' : '#e4e4e7'; // Cyan if selected, zinc-200 otherwise

    switch (comp.type) {
      case 'resistor':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -15,0 L -10,-8 L 0,8 L 10,-8 L 15,0 L 30,0" />
          </g>
        );
      case 'capacitor':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -6,0 M 6,0 L 30,0" />
            <line x1="-6" y1="-12" x2="-6" y2="12" />
            <line x1="6" y1="-12" x2="6" y2="12" />
          </g>
        );
      case 'inductor':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -20,0 C -20,-8 -12,-8 -12,0 C -12,-8 -4,-8 -4,0 C -4,-8 4,-8 4,0 C 4,-8 12,-8 12,0 L 30,0" />
          </g>
        );
      case 'voltage_source':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <circle cx="0" cy="0" r="16" />
            <path d="M -22,0 L -16,0 M 16,0 L 22,0" />
            <path d="M -8,0 L -2,0 M -5,-3 L -5,3" strokeWidth="1.5" />
            <path d="M 4,0 L 10,0" strokeWidth="1.5" />
          </g>
        );
      case 'gnd':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <line x1="0" y1="0" x2="0" y2="15" />
            <line x1="-15" y1="15" x2="15" y2="15" />
            <line x1="-10" y1="20" x2="10" y2="20" />
            <line x1="-5" y1="25" x2="5" y2="25" />
          </g>
        );
      case 'diode':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -8,0 M 8,0 L 30,0" />
            <path d="M -8,-10 L -8,10 L 8,0 Z" fill={color} />
            <line x1="8" y1="-10" x2="8" y2="10" />
          </g>
        );
      case 'zener':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -8,0 M 8,0 L 30,0" />
            <path d="M -8,-10 L -8,10 L 8,0 Z" fill={color} />
            <path d="M 4,-10 L 8,-10 L 8,10 L 12,10" />
          </g>
        );
      case 'led':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -8,0 M 8,0 L 30,0" />
            <path d="M -8,-10 L -8,10 L 8,0 Z" fill={color} />
            <line x1="8" y1="-10" x2="8" y2="10" />
            <path d="M -4,-12 L 4,-20 M 0,-20 L 4,-20 L 4,-16" strokeWidth="1" />
            <path d="M 2,-12 L 10,-20 M 6,-20 L 10,-20 L 10,-16" strokeWidth="1" />
          </g>
        );
      case 'transistor_npn':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <circle cx="0" cy="0" r="18" strokeDasharray="3 2" strokeWidth="1" />
            <line x1="-30" y1="0" x2="-8" y2="0" />
            <line x1="-8" y1="-10" x2="-8" y2="10" />
            <line x1="-8" y1="5" x2="10" y2="15" />
            <line x1="10" y1="15" x2="20" y2="15" />
            <line x1="-8" y1="-5" x2="10" y2="-15" />
            <line x1="10" y1="-15" x2="20" y2="-15" />
            <path d="M 4,-11.5 L 9,-14.5 L 6.5,-9" fill={color} strokeWidth="1" />
          </g>
        );
      case 'mosfet_n':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <circle cx="0" cy="0" r="22" strokeDasharray="3 2" strokeWidth="1" />
            {/* Gate */}
            <line x1="-30" y1="0" x2="-10" y2="0" />
            <line x1="-10" y1="-14" x2="-10" y2="14" strokeWidth="2.5" />
            {/* Channel segments */}
            <line x1="-4" y1="-14" x2="-4" y2="-6" strokeWidth="2" />
            <line x1="-4" y1="-3" x2="-4" y2="3" strokeWidth="2" />
            <line x1="-4" y1="6" x2="-4" y2="14" strokeWidth="2" />
            {/* Drain (top) */}
            <line x1="-4" y1="-10" x2="10" y2="-10" />
            <line x1="10" y1="-10" x2="10" y2="-20" />
            <line x1="10" y1="-20" x2="20" y2="-20" />
            {/* Source (bottom) */}
            <line x1="-4" y1="10" x2="10" y2="10" />
            <line x1="10" y1="10" x2="10" y2="20" />
            <line x1="10" y1="20" x2="20" y2="20" />
            {/* Substrate center connection and inward arrow */}
            <line x1="-4" y1="0" x2="10" y2="0" />
            <line x1="10" y1="0" x2="10" y2="10" />
            <path d="M 4,-3 L -2,0 L 4,3 Z" fill={color} strokeWidth="1" />
          </g>
        );
      case 'potentiometer':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            {/* Resistor line */}
            <path d="M -30,0 L -15,0 L -10,-8 L 0,8 L 10,-8 L 15,0 L 30,0" />
            {/* Wiper arrow pointing down from pin 2 */}
            <line x1="0" y1="-25" x2="0" y2="-3" strokeWidth="2" />
            <path d="M -4,-8 L 0,-1 L 4,-8" fill={color} strokeWidth="1.5" />
          </g>
        );
      case 'opamp':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -25,-25 L 25,0 L -25,25 Z" fill="zinc-900" />
            <path d="M -40,-15 L -25,-15 M -40,15 L -25,15 M 25,0 L 40,0" />
            <path d="M 0,-12 L 0,-25 M 0,12 L 0,25" />
            <path d="M -20,-15 L -14,-15 M -17,-18 L -17,-12" strokeWidth="1.5" />
            <path d="M -20,15 L -14,15" strokeWidth="1.5" />
          </g>
        );
      case 'timer555':
        return (
          <g stroke={color} strokeWidth="2" fill="zinc-900">
            <rect x="-35" y="-45" width="70" height="90" rx="3" fill="#18181b" />
            <path d="M -10,-45 C -10,-40 10,-40 10,-45" />
          </g>
        );
      default:
        return null;
    }
  };

  // Determine wire color based on simulation voltage
  const getWireColor = (wire: Wire) => {
    if (!simVoltages) return '#52525b';
    const netName = wire.net;
    if (!netName) return '#52525b';

    const v = simVoltages[netName] ?? 0;
    if (v > 0.1) {
      const intensity = Math.min(255, Math.floor((v / 5.0) * 155) + 100);
      return `rgb(${intensity}, 34, 64)`;
    } else if (v < -0.1) {
      const intensity = Math.min(255, Math.floor((Math.abs(v) / 5.0) * 155) + 100);
      return `rgb(34, 100, ${intensity})`;
    } else {
      return '#10b981';
    }
  };

  // Determine dashed speed of wire animation based on current
  const getWireDashStyle = (wire: Wire) => {
    if (!simCurrents || !simCurrents[wire.fromCompId]) return 'none';
    const current = simCurrents[wire.fromCompId] || 0;
    if (Math.abs(current) < 1e-6) return 'none';

    const speed = Math.max(1, Math.min(20, Math.abs(current) * 10000));
    const dir = current > 0 ? 'normal' : 'reverse';

    return {
      strokeDasharray: '4 4',
      animation: `flow ${10 / speed}s linear infinite ${dir}`
    };
  };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col relative h-full select-none overflow-hidden">
      {/* Top Controls Info bar */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 flex-wrap">
        <div className="px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-3 text-xs text-zinc-400 font-mono">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
            Drag to Move
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-purple-400"></span>
            Click pins to Wire
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
            [R] Rotate
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400"></span>
            [Del] Delete
          </span>
          {wireStart && (
            <span className="text-purple-400 font-bold animate-pulse">
              • Connecting: {wireStart.compId}(Pin {wireStart.pinId})
            </span>
          )}
        </div>

        {/* Zoom & Pan Controls */}
        <div className="flex items-center gap-1 px-2 py-1 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg text-xs font-mono text-zinc-300">
          <button
            onClick={() => setZoom(prev => Math.min(3.0, prev * 1.2))}
            title="Zoom In"
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoom(prev => Math.max(0.4, prev / 1.2))}
            title="Zoom Out"
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setZoom(1.0); setPan({ x: 0, y: 0 }); }}
            title="Reset Zoom & Pan"
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-zinc-200"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <span className="px-1 text-zinc-400">{Math.round(zoom * 100)}%</span>
        </div>
      </div>

      {/* SVG Canvas Container */}
      <div
        className="flex-1 overflow-hidden flex items-center justify-center p-4 relative"
        onWheel={handleWheel}
        onMouseDown={handleCanvasMouseDown}
      >
        <svg
          ref={svgRef}
          width={width}
          height={height}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onClick={handleCanvasClick}
          className="border border-zinc-800 bg-[#09090b] rounded-xl shadow-2xl relative select-none cursor-crosshair w-full h-full"
          style={{
            backgroundImage: 'radial-gradient(#27272a 1px, transparent 1px)',
            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`
          }}
        >
          {/* Wire Animations Keyframes */}
          <defs>
            <style>
              {`
                @keyframes flow {
                  from { stroke-dashoffset: 20; }
                  to { stroke-dashoffset: 0; }
                }
              `}
            </style>
          </defs>

          {/* Root transformation group for Zoom and Pan */}
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Render Connections / Wires */}
            {data.wires.map(wire => {
              const pathColor = getWireColor(wire);
              const isWireSelected = selectedComponent?.id === wire.id;
              const strokeWidth = isWireSelected ? 3.5 : 2;

              const p = wire.points;
              let dString = `M ${p[0].x} ${p[0].y}`;
              for (let i = 1; i < p.length; i++) {
                dString += ` L ${p[i].x} ${p[i].y}`;
              }

              return (
                <g key={wire.id} className="group">
                  {/* Visual copper line */}
                  <path
                    d={dString}
                    stroke={pathColor}
                    strokeWidth={strokeWidth}
                    fill="none"
                    className="transition-colors duration-200"
                  />
                  
                  {/* Active current flow helper dots */}
                  {simCurrents && (
                    <path
                      d={dString}
                      stroke="#ffffff"
                      strokeWidth="1.5"
                      strokeOpacity="0.8"
                      fill="none"
                      style={getWireDashStyle(wire) as React.CSSProperties}
                    />
                  )}

                  {/* Click target helper */}
                  <path
                    d={dString}
                    stroke="transparent"
                    strokeWidth="10"
                    fill="none"
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectComponent({
                        id: wire.id,
                        type: 'gnd', // placeholder indicator
                        name: wire.id,
                        value: wire.net,
                        x: 0, y: 0, rotation: 0, pins: [], params: {}
                      });
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onDeleteWire(wire.id);
                    }}
                  />
                </g>
              );
            })}

            {/* Render Active Temporary Wire from pin to cursor */}
            {wireStart && (
              <path
                d={`M ${wireStart.x} ${wireStart.y} L ${mousePos.x} ${wireStart.y} L ${mousePos.x} ${mousePos.y}`}
                stroke="#a855f7"
                strokeWidth="2"
                strokeDasharray="3 3"
                fill="none"
              />
            )}

            {/* Render Components */}
            {data.components.map(comp => {
              const isGnd = comp.type === 'gnd';
              return (
                <g
                  key={comp.id}
                  transform={`translate(${comp.x}, ${comp.y}) rotate(${comp.rotation})`}
                  onMouseDown={(e) => handleMouseDown(e, comp)}
                  className="cursor-grab active:cursor-grabbing"
                >
                  {/* Render visual symbol */}
                  {renderSymbol(comp)}

                  {/* Render Component label and value */}
                  {!isGnd && (
                    <g transform={`rotate(${-comp.rotation})`} className="pointer-events-none">
                      <text
                        x="0"
                        y={comp.type === 'timer555' ? 60 : comp.type === 'mosfet_n' ? 34 : -25}
                        textAnchor="middle"
                        fill="#ffffff"
                        className="text-[11px] font-mono font-bold"
                      >
                        {comp.name}
                      </text>
                      <text
                        x="0"
                        y={comp.type === 'timer555' ? 72 : comp.type === 'mosfet_n' ? 45 : -14}
                        textAnchor="middle"
                        fill="#a1a1aa"
                        className="text-[10px] font-mono"
                      >
                        {comp.value}
                      </text>
                    </g>
                  )}

                  {/* Render Pin Nodes */}
                  {comp.pins.map(pin => {
                    const hasNet = pin.net !== undefined;
                    return (
                      <g
                        key={pin.id}
                        transform={`translate(${pin.relX}, ${pin.relY}) rotate(${-comp.rotation})`}
                        onMouseDown={(e) => handlePinMouseDown(e, comp, pin)}
                        className="group/pin cursor-pointer"
                      >
                        <circle
                          cx="0"
                          cy="0"
                          r="3.5"
                          fill={hasNet ? '#22c55e' : '#a1a1aa'}
                          stroke="#09090b"
                          strokeWidth="1"
                          className="group-hover/pin:fill-purple-500 group-hover/pin:scale-125 transition-all"
                        />
                        <text
                          x={pin.relX > 0 ? 8 : -8}
                          y="3"
                          textAnchor={pin.relX > 0 ? 'start' : 'end'}
                          fill="#71717a"
                          className="text-[8px] font-mono font-bold opacity-0 group-hover/pin:opacity-100 transition-opacity bg-zinc-900"
                        >
                          {pin.label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
};
