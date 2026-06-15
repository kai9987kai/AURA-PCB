import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PCBLayoutData, SimResult } from '../types/pcb';
import { Layers, RotateCcw, HelpCircle } from 'lucide-react';

interface ThreeDPCBViewerProps {
  layoutData: PCBLayoutData;
  simResult?: SimResult | null;
}

export const ThreeDPCBViewer: React.FC<ThreeDPCBViewerProps> = ({ layoutData, simResult }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [showComponents, setShowComponents] = useState(true);
  const [showTraces, setShowTraces] = useState(true);
  const [showThermalOverlay, setShowThermalOverlay] = useState(true);
  const [showStackup, setShowStackup] = useState(true);
  const [soldermaskColor, setSoldermaskColor] = useState<'green' | 'blue' | 'black'>('green');

  useEffect(() => {
    if (!containerRef.current) return;

    // 1. Setup Scene, Camera, Renderer
    const width = containerRef.current.clientWidth;
    const height = 550;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0c);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    // Position camera looking down at an angle
    camera.position.set(0, 80, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    
    // Clear any previous canvas
    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(renderer.domElement);

    // 2. Setup Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.05; // don't go below ground level
    controls.minDistance = 20;
    controls.maxDistance = 250;

    // 3. Setup Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight1.position.set(50, 100, 50);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xa5f3fc, 0.3); // soft cyan fill light
    dirLight2.position.set(-50, 40, -50);
    scene.add(dirLight2);

    // 4. Create PCB Board Substrate Mesh
    // Scale down layout coords slightly for Three.js space: 1mm = 0.5 units
    const boardScale = 0.5;
    const bWidth = layoutData.boardWidth * boardScale;
    const bHeight = layoutData.boardHeight * boardScale;
    const bThickness = 1.6 * boardScale; // 1.6mm thickness

    const boardGeom = new THREE.BoxGeometry(bWidth, bThickness, bHeight);
    
    // Select soldermask color
    let maskHex = 0x064e3b; // dark green
    if (soldermaskColor === 'blue') maskHex = 0x0f172a; // dark blue
    if (soldermaskColor === 'black') maskHex = 0x09090b; // matte black

    const boardMat = new THREE.MeshStandardMaterial({
      color: maskHex,
      roughness: 0.2,
      metalness: 0.1,
      transparent: true,
      opacity: 0.95
    });

    const boardMesh = new THREE.Mesh(boardGeom, boardMat);
    boardMesh.receiveShadow = true;
    scene.add(boardMesh);

    // Coordinate helper: maps board (x, y) in mm to Three.js centered (x, z)
    const boardToWorld = (bx: number, by: number) => {
      return {
        x: (bx - layoutData.boardWidth / 2) * boardScale,
        z: (by - layoutData.boardHeight / 2) * boardScale
      };
    };

    if (showStackup) {
      const copperMat = new THREE.MeshStandardMaterial({
        color: 0xb7791f,
        roughness: 0.22,
        metalness: 0.75,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide
      });
      const dielectricMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        roughness: 0.6,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide
      });
      const layerGeom = new THREE.PlaneGeometry(bWidth * 1.01, bHeight * 1.01);
      const topCopper = new THREE.Mesh(layerGeom, copperMat);
      topCopper.rotation.x = -Math.PI / 2;
      topCopper.position.y = bThickness / 2 + 0.035;
      scene.add(topCopper);

      const bottomCopper = new THREE.Mesh(layerGeom, copperMat.clone());
      bottomCopper.rotation.x = -Math.PI / 2;
      bottomCopper.position.y = -bThickness / 2 - 0.035;
      scene.add(bottomCopper);

      const coreLayer = new THREE.Mesh(new THREE.PlaneGeometry(bWidth * 0.98, bHeight * 0.98), dielectricMat);
      coreLayer.rotation.x = -Math.PI / 2;
      coreLayer.position.y = 0;
      scene.add(coreLayer);
    }

    // 5. Draw Copper Traces as Canvas Texture
    const traceCanvas = document.createElement('canvas');
    traceCanvas.width = 1024;
    traceCanvas.height = 1024;
    const ctx = traceCanvas.getContext('2d');
    
    if (ctx && showTraces) {
      ctx.fillStyle = 'rgba(0,0,0,0)';
      ctx.fillRect(0, 0, 1024, 1024);

      // Scale factor to map board mm to 1024x1024 texture canvas
      const texXScale = 1024 / layoutData.boardWidth;
      const texYScale = 1024 / layoutData.boardHeight;

      // Draw traces
      layoutData.traces.forEach(trace => {
        ctx.beginPath();
        ctx.lineWidth = trace.width * texXScale;
        ctx.strokeStyle = trace.layer === 'top' ? '#eab308' : '#38bdf8';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (trace.layer === 'bottom') ctx.setLineDash([10, 8]);

        ctx.moveTo(trace.points[0].x * texXScale, trace.points[0].y * texYScale);
        for (let i = 1; i < trace.points.length; i++) {
          ctx.lineTo(trace.points[i].x * texXScale, trace.points[i].y * texYScale);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      });

      layoutData.vias.forEach(via => {
        ctx.beginPath();
        ctx.arc(via.x * texXScale, via.y * texYScale, (via.diameter / 2) * texXScale, 0, 2 * Math.PI);
        ctx.fillStyle = '#fbbf24';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(via.x * texXScale, via.y * texYScale, (via.drillDiameter / 2) * texXScale, 0, 2 * Math.PI);
        ctx.fillStyle = '#0a0a0c';
        ctx.fill();
      });

      // Draw pads
      layoutData.footprints.forEach(fp => {
        fp.pads.forEach(pad => {
          const rad = (fp.rotation * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const rx = pad.relX * cos - pad.relY * sin;
          const ry = pad.relX * sin + pad.relY * cos;
          const px = fp.x + rx;
          const py = fp.y + ry;

          ctx.beginPath();
          ctx.arc(px * texXScale, py * texYScale, (pad.diameter / 2) * texXScale, 0, 2 * Math.PI);
          ctx.fillStyle = '#f59e0b'; // Gold pads
          ctx.fill();
        });
      });

      // Apply as overlay texture
      const traceTexture = new THREE.CanvasTexture(traceCanvas);
      const traceGeom = new THREE.PlaneGeometry(bWidth, bHeight);
      const traceMat = new THREE.MeshStandardMaterial({
        map: traceTexture,
        transparent: true,
        roughness: 0.1,
        metalness: 0.8, // metallic copper
        side: THREE.DoubleSide
      });
      
      const traceMeshTop = new THREE.Mesh(traceGeom, traceMat);
      // Place trace slightly above the board to prevent z-fighting
      traceMeshTop.position.y = bThickness / 2 + 0.02;
      traceMeshTop.rotation.x = -Math.PI / 2;
      scene.add(traceMeshTop);
    }

    layoutData.vias.forEach(via => {
      const world = boardToWorld(via.x, via.y);
      const viaGeom = new THREE.CylinderGeometry((via.diameter * boardScale) / 2, (via.diameter * boardScale) / 2, bThickness + 0.08, 16);
      const viaMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.8, roughness: 0.2 });
      const viaMesh = new THREE.Mesh(viaGeom, viaMat);
      viaMesh.position.set(world.x, 0, world.z);
      viaMesh.castShadow = true;
      scene.add(viaMesh);
    });

    // 6. Draw 3D Components
    const componentsGroup = new THREE.Group();

    if (showComponents) {
      layoutData.footprints.forEach(fp => {
        const worldPos = boardToWorld(fp.x, fp.y);
        const compRotRad = (fp.rotation * Math.PI) / 180;

        const compGroup = new THREE.Group();
        compGroup.position.set(worldPos.x, bThickness / 2, worldPos.z);
        compGroup.rotation.y = -compRotRad;

        // Generate 3D package models based on footprint type
        if (fp.type === 'resistor') {
          // Resistor body cylinder
          const bodyGeom = new THREE.CylinderGeometry(0.8, 0.8, 4.5, 8);
          bodyGeom.rotateZ(Math.PI / 2); // align horizontally
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0xddc5a2, roughness: 0.6 }); // tan color
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 1.0;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Color bands (representing 10k: brown, black, orange, gold)
          const bandGeom = new THREE.CylinderGeometry(0.82, 0.82, 0.3, 8);
          bandGeom.rotateZ(Math.PI / 2);
          
          const colors = [0x5c3a21, 0x000000, 0xd97706]; // Brown, Black, Orange
          const positions = [-1.2, -0.4, 0.4];
          colors.forEach((c, idx) => {
            const bandMat = new THREE.MeshStandardMaterial({ color: c });
            const bandMesh = new THREE.Mesh(bandGeom, bandMat);
            bandMesh.position.set(positions[idx], 1.0, 0);
            compGroup.add(bandMesh);
          });

          // Metal Leads (wires bent down into pads)
          const wireMat = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.8, roughness: 0.2 });
          const leadLGeom = new THREE.CylinderGeometry(0.1, 0.1, 3.5, 6);
          leadLGeom.rotateZ(Math.PI / 2);
          const leadL = new THREE.Mesh(leadLGeom, wireMat);
          leadL.position.set(-3.5, 1.0, 0);
          compGroup.add(leadL);

          const leadR = new THREE.Mesh(leadLGeom, wireMat);
          leadR.position.set(3.5, 1.0, 0);
          compGroup.add(leadR);

          // Downward pins to board
          const pinGeom = new THREE.CylinderGeometry(0.1, 0.1, 1.0, 6);
          const pinL = new THREE.Mesh(pinGeom, wireMat);
          pinL.position.set(-5.0, 0.5, 0);
          compGroup.add(pinL);

          const pinR = new THREE.Mesh(pinGeom, wireMat);
          pinR.position.set(5.0, 0.5, 0);
          compGroup.add(pinR);

        } else if (fp.type === 'capacitor') {
          // Radial electrolytic capacitor can
          const bodyGeom = new THREE.CylinderGeometry(1.8, 1.8, 6.0, 12);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.3 }); // blue metal sleeve
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 3.0;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Silver stripe on cap body
          const stripeGeom = new THREE.CylinderGeometry(1.82, 1.82, 6.0, 12, 1, false, 0, Math.PI / 3);
          const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.3 });
          const stripeMesh = new THREE.Mesh(stripeGeom, stripeMat);
          stripeMesh.position.y = 3.0;
          compGroup.add(stripeMesh);

          // Top aluminum cap
          const topGeom = new THREE.CylinderGeometry(1.75, 1.75, 0.1, 12);
          const topMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.8, roughness: 0.2 });
          const topMesh = new THREE.Mesh(topGeom, topMat);
          topMesh.position.y = 6.0;
          compGroup.add(topMesh);

        } else if (fp.type === 'diode' || fp.type === 'led') {
          if (fp.type === 'led') {
            // LED Translucent plastic dome
            const domeGeom = new THREE.SphereGeometry(1.6, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
            const colorHex = fp.id.toLowerCase().includes('led2') ? 0x22c55e : 0xef4444; // Green or Red
            const domeMat = new THREE.MeshPhysicalMaterial({
              color: colorHex,
              transparent: true,
              opacity: 0.75,
              roughness: 0.1,
              transmission: 0.6,
              ior: 1.5
            });
            const domeMesh = new THREE.Mesh(domeGeom, domeMat);
            domeMesh.position.y = 1.0;
            domeMesh.castShadow = true;
            compGroup.add(domeMesh);

            // LED base rim ring
            const rimGeom = new THREE.CylinderGeometry(1.7, 1.7, 0.4, 16);
            const rimMesh = new THREE.Mesh(rimGeom, domeMat);
            rimMesh.position.y = 0.8;
            compGroup.add(rimMesh);

            // Internal metal anode/cathode block
            const anodeGeom = new THREE.BoxGeometry(0.4, 1.2, 0.8);
            const metalMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.8 });
            const anodeMesh = new THREE.Mesh(anodeGeom, metalMat);
            anodeMesh.position.set(-0.5, 0.8, 0);
            compGroup.add(anodeMesh);

          } else {
            // Diode DO-35 black body with silver band
            const bodyGeom = new THREE.CylinderGeometry(0.8, 0.8, 4.0, 8);
            bodyGeom.rotateZ(Math.PI / 2);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.5 }); // black
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
            bodyMesh.position.y = 0.8;
            bodyMesh.castShadow = true;
            compGroup.add(bodyMesh);

            // Silver polarity band
            const bandGeom = new THREE.CylinderGeometry(0.82, 0.82, 0.5, 8);
            bandGeom.rotateZ(Math.PI / 2);
            const bandMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db });
            const bandMesh = new THREE.Mesh(bandGeom, bandMat);
            bandMesh.position.set(-1.0, 0.8, 0);
            compGroup.add(bandMesh);
          }

        } else if (fp.type === 'timer555' || fp.type === 'opamp') {
          // DIP-8 IC Package
          const bodyGeom = new THREE.BoxGeometry(9.0, 3.2, 6.5); // 9.0mm long, 3.2mm high, 6.5mm wide
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e1e24, roughness: 0.8 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 2.0; // lifted slightly off board
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Pin-1 indicator notch/dot
          const dotGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8);
          const dotMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.9 });
          const dotMesh = new THREE.Mesh(dotGeom, dotMat);
          dotMesh.position.set(-3.5, 3.6, -2.2);
          compGroup.add(dotMesh);

          // Renders pins bent down
          const pinMat = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.8, roughness: 0.2 });
          const pinGeom = new THREE.BoxGeometry(0.4, 2.0, 0.8);
          const xOffsets = [-3.81, -1.27, 1.27, 3.81]; // DIP pin spacings
          
          xOffsets.forEach(x => {
            // Left side pins (z = -3.8)
            const pinL = new THREE.Mesh(pinGeom, pinMat);
            pinL.position.set(x, 1.0, -3.4);
            pinL.rotation.z = -0.15;
            compGroup.add(pinL);

            // Right side pins (z = 3.8)
            const pinR = new THREE.Mesh(pinGeom, pinMat);
            pinR.position.set(x, 1.0, 3.4);
            pinR.rotation.z = 0.15;
            compGroup.add(pinR);
          });

        } else if (fp.type === 'transistor_npn') {
          // TO-92 Transistor Package (flat back, rounded front)
          // Simplified as semi-cylinder block
          const bodyGeom = new THREE.CylinderGeometry(1.6, 1.6, 3.5, 12, 1, false, 0, Math.PI);
          bodyGeom.rotateX(Math.PI / 2); // orient standing up
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.7 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 2.5;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Flat back plane box to close cylinder
          const backGeom = new THREE.BoxGeometry(3.2, 3.5, 0.4);
          const backMesh = new THREE.Mesh(backGeom, bodyMat);
          backMesh.position.set(0, 2.5, -0.2);
          compGroup.add(backMesh);

          // 3 leads standing up
          const leadMat = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.8 });
          const leadGeom = new THREE.CylinderGeometry(0.12, 0.12, 2.0, 6);
          const xOffsets = [-1.27, 0, 1.27];
          xOffsets.forEach(x => {
            const lead = new THREE.Mesh(leadGeom, leadMat);
            lead.position.set(x, 0.8, 0);
            compGroup.add(lead);
          });

        } else if (fp.type === 'voltage_source' || fp.type === 'gnd') {
          // Render a simple terminal connector header block
          const blockGeom = new THREE.BoxGeometry(4.0, 4.0, 4.0);
          const blockMat = new THREE.MeshStandardMaterial({ color: 0x047857, roughness: 0.4 }); // dark green plastic connector
          const blockMesh = new THREE.Mesh(blockGeom, blockMat);
          blockMesh.position.y = 2.0;
          blockMesh.castShadow = true;
          compGroup.add(blockMesh);

          // Gold header pins
          const pinGeom = new THREE.CylinderGeometry(0.3, 0.3, 1.5, 6);
          const pinMat = new THREE.MeshStandardMaterial({ color: 0xeab308, metalness: 0.8 });
          const pin = new THREE.Mesh(pinGeom, pinMat);
          pin.position.y = 4.5;
          compGroup.add(pin);
        }

        if (showThermalOverlay) {
          const power = simResult?.powerDissipation[fp.id] || 0;
          if (power > 0.0005) {
            const normalizedPower = Math.min(1, power / 0.25);
            const pillarHeight = 2 + normalizedPower * 10;
            const heatGeom = new THREE.CylinderGeometry(1.2 + normalizedPower * 1.6, 0.5, pillarHeight, 24);
            const heatMat = new THREE.MeshBasicMaterial({
              color: normalizedPower > 0.65 ? 0xef4444 : normalizedPower > 0.3 ? 0xf59e0b : 0x22c55e,
              transparent: true,
              opacity: 0.32,
              depthWrite: false
            });
            const heatMesh = new THREE.Mesh(heatGeom, heatMat);
            heatMesh.position.y = 4.5 + pillarHeight / 2;
            compGroup.add(heatMesh);
          }
        }

        componentsGroup.add(compGroup);
      });

      scene.add(componentsGroup);
    }

    // 7. Render Animation Loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      
      // Slow background board rotation for dynamic view
      boardMesh.rotation.y = 0.0008;
      if (showTraces) {
        // Keep trace textures aligned with board rotation
        scene.children.forEach(c => {
          if (c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry) {
            c.rotation.z = -boardMesh.rotation.y;
          }
        });
      }
      componentsGroup.rotation.y = boardMesh.rotation.y;

      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    // 8. Handle Resize
    const handleResize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      camera.aspect = w / height;
      camera.updateProjectionMatrix();
      renderer.setSize(w, height);
    };

    window.addEventListener('resize', handleResize);

    // 9. Cleanup
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener('resize', handleResize);
      
      // Dispose geometries and materials
      boardGeom.dispose();
      boardMat.dispose();
      
      scene.clear();
      renderer.dispose();
    };

  }, [layoutData, simResult, showComponents, showTraces, showThermalOverlay, showStackup, soldermaskColor]);

  const handleResetCamera = () => {
    // Standard camera position
    if (containerRef.current) {
      // Re-trigger useEffect by toggling component or other states, 
      // or we can manually animate camera back
      // Let's just reload scene elements
      setShowComponents(prev => !prev);
      setTimeout(() => setShowComponents(prev => !prev), 10);
    }
  };

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-6 text-zinc-100 overflow-y-auto h-full">
      {/* 3D Renders Options toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 backdrop-blur">
        <div className="flex items-center gap-6">
          {/* Toggles */}
          <div className="flex items-center gap-4 text-xs font-mono">
            <button
              onClick={() => setShowComponents(!showComponents)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showComponents
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Components
            </button>

            <button
              onClick={() => setShowTraces(!showTraces)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showTraces
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Copper Traces
            </button>

            <button
              onClick={() => setShowStackup(!showStackup)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showStackup
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Stackup
            </button>

            <button
              onClick={() => setShowThermalOverlay(!showThermalOverlay)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showThermalOverlay
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
              title="Uses SPICE power dissipation after simulation"
            >
              <Layers className="w-3.5 h-3.5" />
              Thermal
            </button>
          </div>

          {/* Solder Mask Color picker */}
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
            <span>Solder Mask:</span>
            <button
              onClick={() => setSoldermaskColor('green')}
              className={`w-5 h-5 rounded-full bg-emerald-700 border-2 transition-all ${
                soldermaskColor === 'green' ? 'border-white scale-110 shadow-lg' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
              title="Emerald Green"
            />
            <button
              onClick={() => setSoldermaskColor('blue')}
              className={`w-5 h-5 rounded-full bg-slate-800 border-2 transition-all ${
                soldermaskColor === 'blue' ? 'border-white scale-110 shadow-lg' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
              title="Slate Blue"
            />
            <button
              onClick={() => setSoldermaskColor('black')}
              className={`w-5 h-5 rounded-full bg-zinc-900 border-2 transition-all ${
                soldermaskColor === 'black' ? 'border-white scale-110 shadow-lg' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
              title="Matte Black"
            />
          </div>
        </div>

        <button
          onClick={handleResetCamera}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded text-xs text-zinc-400 hover:text-zinc-200 transition-colors font-mono"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reload Scene
        </button>
      </div>

      {/* Renders Box */}
      <div className="bg-zinc-900/30 border border-zinc-850 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl relative">
        <div className="flex items-center justify-between text-sm">
          <span className="font-bold tracking-wider text-zinc-300 font-mono">
            3D PCB PHOTOREALISTIC WEBGL VIEWER
          </span>
          <div className="text-xs font-mono text-zinc-500 flex items-center gap-1">
            <HelpCircle className="w-3.5 h-3.5" />
            Left click + drag to orbit. Right click + drag to pan. Scroll to zoom.
          </div>
        </div>

        {/* WebGL Canvas container */}
        <div
          ref={containerRef}
          className="w-full bg-[#0a0a0c] border border-zinc-850 rounded-xl overflow-hidden shadow-inner flex items-center justify-center min-h-[550px]"
        />
      </div>
    </div>
  );
};
