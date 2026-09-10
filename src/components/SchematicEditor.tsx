
  // Convert client coordinates to SVG coordinates
  const getSVGCoords = (e: React.MouseEvent) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    const matrix = svgRef.current.getScreenCTM();
    const position = matrix ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse()) : { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const x = Math.round(position.x / 10) * 10;
    const y = Math.round(position.y / 10) * 10;
    return { x, y };
  };

  // Keyboard shortcut listener (Rotation with 'R' or Delete with 'Del')
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { setWireStart(null); return; }
      if (!selectedComponent) return;
      if (e.key.toLowerCase() === 'r') {
        const nextRot = (selectedComponent.rotation + 90) % 360;
        onUpdateComponent({ ...selectedComponent, rotation: nextRot });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedComponent, onUpdateComponent]);

  // Handle dragging
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
          x: Math.max(20, Math.min(width - 20, newX)),
          y: Math.max(20, Math.min(height - 20, newY))
        });
      }
    }
  };

  const handleMouseUp = () => {
    setDraggedComp(null);
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
          // Simple orthogonal routing point
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

  // Cancel wiring on right click or escape
  const handleCanvasClick = () => {
    if (wireStart) {
      setWireStart(null);
    } else {
      onSelectComponent(null);
    }
  };

  // Get absolute pin coordinate in SVG space based on component placement and rotation
  const getAbsolutePinCoords = (comp: SchematicComponent, pin: Pin) => {
    const rad = (comp.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Rotate local pin coordinates
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

    // Render local symbol elements centered at (0, 0)
    switch (comp.type) {
      case 'resistor':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            {/* Zigzag lines */}
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
            {/* Plus sign */}
            <path d="M -8,0 L -2,0 M -5,-3 L -5,3" strokeWidth="1.5" />
            {/* Minus sign */}
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
      case 'led':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <path d="M -30,0 L -8,0 M 8,0 L 30,0" />
            <path d="M -8,-10 L -8,10 L 8,0 Z" fill={color} />
            <line x1="8" y1="-10" x2="8" y2="10" />
            {/* Small light arrows */}
            <path d="M -4,-12 L 4,-20 M 0,-20 L 4,-20 L 4,-16" strokeWidth="1" />
            <path d="M 2,-12 L 10,-20 M 6,-20 L 10,-20 L 10,-16" strokeWidth="1" />
          </g>
        );
      case 'transistor_npn':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            <circle cx="0" cy="0" r="18" strokeDasharray="3 2" strokeWidth="1" />
            {/* Base leg */}
            <line x1="-30" y1="0" x2="-8" y2="0" />
            <line x1="-8" y1="-10" x2="-8" y2="10" />
            {/* Collector leg */}
            <line x1="-8" y1="5" x2="10" y2="15" />
            <line x1="10" y1="15" x2="20" y2="15" />
            {/* Emitter leg */}
            <line x1="-8" y1="-5" x2="10" y2="-15" />
            <line x1="10" y1="-15" x2="20" y2="-15" />
            {/* Arrow on emitter */}
            <path d="M 4,-11.5 L 9,-14.5 L 6.5,-9" fill={color} strokeWidth="1" />
          </g>
        );
      case 'opamp':
        return (
          <g stroke={color} strokeWidth="2" fill="none">
            {/* Triangle shape */}
            <path d="M -25,-25 L 25,0 L -25,25 Z" fill="zinc-900" />
            <path d="M -40,-15 L -25,-15 M -40,15 L -25,15 M 25,0 L 40,0" />
            {/* V+ and V- power pins */}
            <path d="M 0,-12 L 0,-25 M 0,12 L 0,25" />
            {/* Plus and Minus symbols inside */}
            <path d="M -20,-15 L -14,-15 M -17,-18 L -17,-12" strokeWidth="1.5" />
            <path d="M -20,15 L -14,15" strokeWidth="1.5" />
          </g>
        );
      case 'timer555':
        return (
          <g stroke={color} strokeWidth="2" fill="zinc-900">
            {/* IC Box */}
            <rect x="-35" y="-45" width="70" height="90" rx="3" fill="#18181b" />
            {/* Notch */}
            <path d="M -10,-45 C -10,-40 10,-40 10,-45" />
          </g>
        );
      default:
        return null;
    }
  };

  // Determine wire color based on simulation voltage
  const getWireColor = (wire: Wire) => {
    if (!simVoltages) return '#52525b'; // default zinc-600

    // Get nodes of both endpoints
    // For visual overlay, find voltage at the net name
    const netName = wire.net;
    if (!netName) return '#52525b';

    const v = simVoltages[netName] ?? 0;

    // Map voltage to red (positive), blue (ground/negative), green (zeroish)
    if (v > 0.1) {
      // Interpolate red intensity up to 5V
      const intensity = Math.min(255, Math.floor((v / 5.0) * 155) + 100);
      return `rgb(${intensity}, 34, 64)`; // glowing redish
    } else if (v < -0.1) {
      const intensity = Math.min(255, Math.floor((Math.abs(v) / 5.0) * 155) + 100);
      return `rgb(34, 100, ${intensity})`; // blueish
    } else {
      return '#10b981'; // emerald green for stable 0V / GND
    }
  };

  // Determine dashed speed of wire animation based on current
  const getWireDashStyle = (wire: Wire) => {
    if (!simCurrents || !simCurrents[wire.fromCompId]) return 'none';
    
    // We approximate the current flowing in this wire as component current
    const current = simCurrents[wire.fromCompId] || 0;
    if (Math.abs(current) < 1e-6) return 'none'; // no current

    const speed = Math.max(1, Math.min(20, Math.abs(current) * 10000)); // scaling current to speed
    const dir = current > 0 ? 'normal' : 'reverse';

    return {
      strokeDasharray: '4 4',
      animation: `flow ${10 / speed}s linear infinite ${dir}`
    };
  };

  return (
    <div className="flex-1 bg-zinc-950 flex flex-col relative h-full">
      {/* Top Controls Info bar */}
      <div className="absolute top-3 left-3 z-10 px-3 py-1.5 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-lg flex items-center gap-3 text-xs text-zinc-400 font-mono">
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
          [R] to Rotate
        </span>
        {wireStart && (
          <span className="text-purple-400 font-bold animate-pulse">
            • Connecting: {wireStart.compId}(Pin {wireStart.pinId})
          </span>
        )}
      </div>

      {/* SVG Canvas Container */}
      <div className="flex-1 overflow-auto flex items-center justify-center p-4">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onClick={handleCanvasClick}
          className="border border-zinc-800 bg-[#09090b] rounded-xl shadow-2xl relative select-none cursor-crosshair"
          style={{
            backgroundImage: 'radial-gradient(#27272a 1px, transparent 1px)',
            backgroundSize: '20px 20px'
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

          {/* Render Connections / Wires */}
          {data.wires.map(wire => {
            const pathColor = getWireColor(wire);
            const isWireSelected = selectedComponent?.id === wire.id;
            const strokeWidth = isWireSelected ? 3.5 : 2;

            // Generate path string
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
                  strokeWidth="8"
                  fill="none"
                  className="cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectComponent({
                      id: wire.id,
                      type: 'gnd', // dummy placeholder
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
            // Filter out GND from rendering standard component names, GND has its own style
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

                {/* Render Component label and value (Un-rotated text so it is readable) */}
                {!isGnd && (
                  <g transform={`rotate(${-comp.rotation})`} className="pointer-events-none">
                    <text
                      x="0"
                      y={comp.type === 'timer555' ? 60 : -25}
                      textAnchor="middle"
                      fill="#ffffff"
                      className="text-[11px] font-mono font-bold"
                    >
                      {comp.name}
                    </text>
                    <text
                      x="0"
                      y={comp.type === 'timer555' ? 72 : -14}
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
                      {/* Pin Circle */}
                      <circle
                        cx="0"
                        cy="0"
                        r="3.5"
                        fill={hasNet ? '#22c55e' : '#a1a1aa'} // green if connected
                        stroke="#09090b"
                        strokeWidth="1"
                        className="group-hover/pin:fill-purple-500 group-hover/pin:scale-125 transition-all"
                      />
                      {/* Hover Pin Label */}
                      <text
                        x={pin.relX > 0 ? 8 : -8}
                        y="3"
                        textAnchor={pin.relX > 0 ? 'start' : 'end'}
                        fill="#52525b"
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
        </svg>
      </div>
    </div>
  );
};
