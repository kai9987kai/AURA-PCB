import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { PCBLayoutData, SimResult } from '../types/pcb';
import { Layers, RotateCcw, HelpCircle, Eye, Compass, Flame, Info } from 'lucide-react';

interface ThreeDPCBViewerProps {
  layoutData: PCBLayoutData;
  simResult?: SimResult | null;
}

export const ThreeDPCBViewer: React.FC<ThreeDPCBViewerProps> = ({ layoutData, simResult }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const [showComponents, setShowComponents] = useState(true);
  const [showTraces, setShowTraces] = useState(true);
  const [showThermalOverlay, setShowThermalOverlay] = useState(true);
  const [showStackup, setShowStackup] = useState(true);
  const [soldermaskColor, setSoldermaskColor] = useState<'green' | 'blue' | 'black'>('green');
  const [inspectedComp, setInspectedComp] = useState<{
    id: string;
    type: string;
    power: number;
    tempRise: number;
    pos: { x: number; y: number };
  } | null>(null);

  const setCameraPreset = useCallback((preset: 'top' | 'bottom' | 'iso' | 'front') => {
    if (!cameraRef.current || !controlsRef.current) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;

    switch (preset) {
      case 'top':
        camera.position.set(0, 110, 0.01);
        break;
      case 'bottom':
        camera.position.set(0, -110, 0.01);
        break;
      case 'iso':
        camera.position.set(0, 80, 100);
        break;
      case 'front':
        camera.position.set(0, 10, 120);
        break;
    }
    controls.target.set(0, 0, 0);
    controls.update();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // 1. Setup Scene, Camera, Renderer
    const width = containerRef.current.clientWidth;
    const height = 560;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0c);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(0, 80, 100);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    containerRef.current.innerHTML = '';
    containerRef.current.appendChild(renderer.domElement);

    // 2. Setup Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 15;
    controls.maxDistance = 280;
    controlsRef.current = controls;

    // 3. Setup Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight1.position.set(60, 110, 60);
    dirLight1.castShadow = true;
    dirLight1.shadow.mapSize.width = 1024;
    dirLight1.shadow.mapSize.height = 1024;
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0x38bdf8, 0.3); // soft cyan fill
    dirLight2.position.set(-60, -40, -60);
    scene.add(dirLight2);

    // 4. Create PCB Board Substrate Mesh
    const boardScale = 0.5;
    const bWidth = layoutData.boardWidth * boardScale;
    const bHeight = layoutData.boardHeight * boardScale;
    const bThickness = 1.6 * boardScale;

    const boardGeom = new THREE.BoxGeometry(bWidth, bThickness, bHeight);

    let maskHex = 0x064e3b; // dark emerald green
    if (soldermaskColor === 'blue') maskHex = 0x0f172a; // dark slate blue
    if (soldermaskColor === 'black') maskHex = 0x09090b; // matte black

    const boardMat = new THREE.MeshStandardMaterial({
      color: maskHex,
      roughness: 0.25,
      metalness: 0.12,
      transparent: true,
      opacity: 0.96
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

    // Multilayer Stackup View
    if (showStackup) {
      const copperMat = new THREE.MeshStandardMaterial({
        color: 0xb7791f,
        roughness: 0.22,
        metalness: 0.75,
        transparent: true,
        opacity: 0.18,
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

    // 5. Build Top & Bottom Copper + Silkscreen Canvas Textures
    if (showTraces) {
      const texSize = 1024;
      const texXScale = texSize / layoutData.boardWidth;
      const texYScale = texSize / layoutData.boardHeight;

      // --- TOP TEXTURE ---
      const topCanvas = document.createElement('canvas');
      topCanvas.width = texSize;
      topCanvas.height = texSize;
      const topCtx = topCanvas.getContext('2d');

      if (topCtx) {
        topCtx.clearRect(0, 0, texSize, texSize);

        // Top Traces
        layoutData.traces.filter(t => t.layer === 'top').forEach(trace => {
          if (trace.points.length < 2) return;
          topCtx.beginPath();
          topCtx.lineWidth = trace.width * texXScale;
          topCtx.strokeStyle = '#eab308'; // Gold copper
          topCtx.lineCap = 'round';
          topCtx.lineJoin = 'round';

          topCtx.moveTo(trace.points[0].x * texXScale, trace.points[0].y * texYScale);
          for (let i = 1; i < trace.points.length; i++) {
            topCtx.lineTo(trace.points[i].x * texXScale, trace.points[i].y * texYScale);
          }
          topCtx.stroke();
        });

        // Top Pads
        layoutData.footprints.forEach(fp => {
          fp.pads.forEach(pad => {
            const rad = (fp.rotation * Math.PI) / 180;
            const rx = pad.relX * Math.cos(rad) - pad.relY * Math.sin(rad);
            const ry = pad.relX * Math.sin(rad) + pad.relY * Math.cos(rad);
            const px = fp.x + rx;
            const py = fp.y + ry;

            topCtx.beginPath();
            topCtx.arc(px * texXScale, py * texYScale, (pad.diameter / 2) * texXScale, 0, 2 * Math.PI);
            topCtx.fillStyle = '#f59e0b';
            topCtx.fill();
          });

          // Silkscreen Component Designator Text (R1, C1, etc.)
          topCtx.fillStyle = '#ffffff';
          topCtx.font = 'bold 16px monospace';
          topCtx.textAlign = 'center';
          topCtx.textBaseline = 'bottom';
          topCtx.fillText(fp.id, fp.x * texXScale, (fp.y - fp.height / 2 - 1) * texYScale);
        });

        const topTex = new THREE.CanvasTexture(topCanvas);
        const topGeom = new THREE.PlaneGeometry(bWidth, bHeight);
        const topMat = new THREE.MeshStandardMaterial({
          map: topTex,
          transparent: true,
          roughness: 0.15,
          metalness: 0.8,
          side: THREE.DoubleSide
        });
        const topMesh = new THREE.Mesh(topGeom, topMat);
        topMesh.position.y = bThickness / 2 + 0.02;
        topMesh.rotation.x = -Math.PI / 2;
        scene.add(topMesh);
      }

      // --- BOTTOM TEXTURE ---
      const botCanvas = document.createElement('canvas');
      botCanvas.width = texSize;
      botCanvas.height = texSize;
      const botCtx = botCanvas.getContext('2d');

      if (botCtx) {
        botCtx.clearRect(0, 0, texSize, texSize);

        // Bottom Traces
        layoutData.traces.filter(t => t.layer === 'bottom').forEach(trace => {
          if (trace.points.length < 2) return;
          botCtx.beginPath();
          botCtx.lineWidth = trace.width * texXScale;
          botCtx.strokeStyle = '#38bdf8'; // Blue copper
          botCtx.lineCap = 'round';
          botCtx.lineJoin = 'round';

          // Flip X to match bottom view
          botCtx.moveTo((layoutData.boardWidth - trace.points[0].x) * texXScale, trace.points[0].y * texYScale);
          for (let i = 1; i < trace.points.length; i++) {
            botCtx.lineTo((layoutData.boardWidth - trace.points[i].x) * texXScale, trace.points[i].y * texYScale);
          }
          botCtx.stroke();
        });

        // Bottom through-hole pads
        layoutData.footprints.forEach(fp => {
          fp.pads.filter(p => p.holeDiameter > 0).forEach(pad => {
            const rad = (fp.rotation * Math.PI) / 180;
            const rx = pad.relX * Math.cos(rad) - pad.relY * Math.sin(rad);
            const ry = pad.relX * Math.sin(rad) + pad.relY * Math.cos(rad);
            const px = fp.x + rx;
            const py = fp.y + ry;

            botCtx.beginPath();
            botCtx.arc((layoutData.boardWidth - px) * texXScale, py * texYScale, (pad.diameter / 2) * texXScale, 0, 2 * Math.PI);
            botCtx.fillStyle = '#f59e0b';
            botCtx.fill();
          });
        });

        const botTex = new THREE.CanvasTexture(botCanvas);
        const botGeom = new THREE.PlaneGeometry(bWidth, bHeight);
        const botMat = new THREE.MeshStandardMaterial({
          map: botTex,
          transparent: true,
          roughness: 0.15,
          metalness: 0.8,
          side: THREE.DoubleSide
        });
        const botMesh = new THREE.Mesh(botGeom, botMat);
        botMesh.position.y = -bThickness / 2 - 0.02;
        botMesh.rotation.x = Math.PI / 2;
        scene.add(botMesh);
      }
    }

    // Vias 3D Cylinders through board
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
    const clickableObjects: THREE.Object3D[] = [];

    if (showComponents) {
      layoutData.footprints.forEach(fp => {
        const worldPos = boardToWorld(fp.x, fp.y);
        const compRotRad = (fp.rotation * Math.PI) / 180;

        const compGroup = new THREE.Group();
        compGroup.position.set(worldPos.x, bThickness / 2, worldPos.z);
        compGroup.rotation.y = -compRotRad;
        compGroup.userData = { footprint: fp };

        // Component 3D Geometries
        if (fp.type === 'resistor') {
          const bodyGeom = new THREE.CylinderGeometry(0.8, 0.8, 4.5, 8);
          bodyGeom.rotateZ(Math.PI / 2);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0xddc5a2, roughness: 0.6 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 1.0;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Color bands
          const bandGeom = new THREE.CylinderGeometry(0.82, 0.82, 0.3, 8);
          bandGeom.rotateZ(Math.PI / 2);
          const colors = [0x5c3a21, 0x000000, 0xd97706];
          const positions = [-1.2, -0.4, 0.4];
          colors.forEach((c, idx) => {
            const bandMat = new THREE.MeshStandardMaterial({ color: c });
            const bandMesh = new THREE.Mesh(bandGeom, bandMat);
            bandMesh.position.set(positions[idx], 1.0, 0);
            compGroup.add(bandMesh);
          });

          // Metal Leads
          const wireMat = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.8, roughness: 0.2 });
          const leadLGeom = new THREE.CylinderGeometry(0.1, 0.1, 3.5, 6);
          leadLGeom.rotateZ(Math.PI / 2);
          const leadL = new THREE.Mesh(leadLGeom, wireMat);
          leadL.position.set(-3.5, 1.0, 0);
          compGroup.add(leadL);

          const leadR = new THREE.Mesh(leadLGeom, wireMat);
          leadR.position.set(3.5, 1.0, 0);
          compGroup.add(leadR);

        } else if (fp.type === 'capacitor') {
          // Radial electrolytic capacitor can
          const bodyGeom = new THREE.CylinderGeometry(1.8, 1.8, 6.0, 12);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.3 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 3.0;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          const stripeGeom = new THREE.CylinderGeometry(1.82, 1.82, 6.0, 12, 1, false, 0, Math.PI / 3);
          const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.3 });
          const stripeMesh = new THREE.Mesh(stripeGeom, stripeMat);
          stripeMesh.position.y = 3.0;
          compGroup.add(stripeMesh);

        } else if (fp.type === 'diode' || fp.type === 'led' || fp.type === 'zener') {
          if (fp.type === 'led') {
            const domeGeom = new THREE.SphereGeometry(1.6, 16, 16, 0, Math.PI * 2, 0, Math.PI / 2);
            const colorHex = fp.id.toLowerCase().includes('led2') ? 0x22c55e : 0xef4444;
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

          } else if (fp.type === 'zener') {
            // DO-35 glass body with blue cathode band
            const bodyGeom = new THREE.CylinderGeometry(0.7, 0.7, 3.5, 8);
            bodyGeom.rotateZ(Math.PI / 2);
            const bodyMat = new THREE.MeshPhysicalMaterial({
              color: 0xd97706,
              transparent: true,
              opacity: 0.8,
              roughness: 0.1
            });
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
            bodyMesh.position.y = 0.8;
            compGroup.add(bodyMesh);

            const bandGeom = new THREE.CylinderGeometry(0.72, 0.72, 0.5, 8);
            bandGeom.rotateZ(Math.PI / 2);
            const bandMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8 }); // blue zener band
            const bandMesh = new THREE.Mesh(bandGeom, bandMat);
            bandMesh.position.set(-1.0, 0.8, 0);
            compGroup.add(bandMesh);

          } else {
            // Standard black DO-35 diode
            const bodyGeom = new THREE.CylinderGeometry(0.8, 0.8, 4.0, 8);
            bodyGeom.rotateZ(Math.PI / 2);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.5 });
            const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
            bodyMesh.position.y = 0.8;
            bodyMesh.castShadow = true;
            compGroup.add(bodyMesh);

            const bandGeom = new THREE.CylinderGeometry(0.82, 0.82, 0.5, 8);
            bandGeom.rotateZ(Math.PI / 2);
            const bandMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db });
            const bandMesh = new THREE.Mesh(bandGeom, bandMat);
            bandMesh.position.set(-1.0, 0.8, 0);
            compGroup.add(bandMesh);
          }

        } else if (fp.type === 'timer555' || fp.type === 'opamp') {
          // DIP-8 IC Package
          const bodyGeom = new THREE.BoxGeometry(9.0, 3.2, 6.5);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e1e24, roughness: 0.8 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 2.0;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          // Dot on pin 1
          const dotGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 8);
          const dotMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, roughness: 0.9 });
          const dotMesh = new THREE.Mesh(dotGeom, dotMat);
          dotMesh.position.set(-3.5, 3.6, -2.2);
          compGroup.add(dotMesh);

        } else if (fp.type === 'transistor_npn') {
          // TO-92 Transistor Package
          const bodyGeom = new THREE.CylinderGeometry(1.6, 1.6, 3.5, 12, 1, false, 0, Math.PI);
          bodyGeom.rotateX(Math.PI / 2);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.7 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 2.5;
          bodyMesh.castShadow = true;
          compGroup.add(bodyMesh);

          const backGeom = new THREE.BoxGeometry(3.2, 3.5, 0.4);
          const backMesh = new THREE.Mesh(backGeom, bodyMat);
          backMesh.position.set(0, 2.5, -0.2);
          compGroup.add(backMesh);

        } else if (fp.type === 'mosfet_n') {
          // TO-220 Power MOSFET package with metal tab
          const bodyGeom = new THREE.BoxGeometry(4.5, 6.0, 3.0);
          const bodyMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.6 });
          const bodyMesh = new THREE.Mesh(bodyGeom, bodyMat);
          bodyMesh.position.y = 3.5;
          compGroup.add(bodyMesh);

          // Metal tab on back
          const tabGeom = new THREE.BoxGeometry(4.5, 8.0, 0.8);
          const tabMat = new THREE.MeshStandardMaterial({ color: 0xd1d5db, metalness: 0.85, roughness: 0.2 });
          const tabMesh = new THREE.Mesh(tabGeom, tabMat);
          tabMesh.position.set(0, 4.5, -1.6);
          compGroup.add(tabMesh);

          // 3 leads
          const leadMat = new THREE.MeshStandardMaterial({ color: 0xc8c8cc, metalness: 0.8 });
          const leadGeom = new THREE.CylinderGeometry(0.15, 0.15, 2.0, 6);
          [-1.27, 0, 1.27].forEach(x => {
            const lead = new THREE.Mesh(leadGeom, leadMat);
            lead.position.set(x, 1.0, 0);
            compGroup.add(lead);
          });

        } else if (fp.type === 'potentiometer') {
          // Blue square trimmer box with top brass rotor dial
          const boxGeom = new THREE.BoxGeometry(6.0, 5.0, 6.0);
          const boxMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.4 });
          const boxMesh = new THREE.Mesh(boxGeom, boxMat);
          boxMesh.position.y = 2.5;
          compGroup.add(boxMesh);

          // Dial
          const dialGeom = new THREE.CylinderGeometry(1.5, 1.5, 0.6, 16);
          const dialMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.6 });
          const dialMesh = new THREE.Mesh(dialGeom, dialMat);
          dialMesh.position.y = 5.3;
          compGroup.add(dialMesh);

        } else {
          // Terminal connector block
          const blockGeom = new THREE.BoxGeometry(4.0, 4.0, 4.0);
          const blockMat = new THREE.MeshStandardMaterial({ color: 0x047857, roughness: 0.4 });
          const blockMesh = new THREE.Mesh(blockGeom, blockMat);
          blockMesh.position.y = 2.0;
          blockMesh.castShadow = true;
          compGroup.add(blockMesh);
        }

        // Thermal Dissipation Pillars
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

        clickableObjects.push(compGroup);
        componentsGroup.add(compGroup);
      });

      scene.add(componentsGroup);
    }

    // Raycasting for click-to-inspect 3D components
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerDown = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(clickableObjects, true);

      if (intersects.length > 0) {
        let parent: THREE.Object3D | null = intersects[0].object;
        while (parent && !parent.userData?.footprint) {
          parent = parent.parent;
        }
        if (parent?.userData?.footprint) {
          const fp = parent.userData.footprint;
          const power = simResult?.powerDissipation[fp.id] || 0;
          setInspectedComp({
            id: fp.id,
            type: fp.type,
            power: Math.round(power * 1000) / 1000,
            tempRise: Math.round(power * 65 * 10) / 10,
            pos: { x: fp.x, y: fp.y }
          });
        }
      }
    };

    renderer.domElement.addEventListener('pointerdown', handlePointerDown);

    // 7. Render Animation Loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
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
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);

      boardGeom.dispose();
      boardMat.dispose();
      scene.clear();
      renderer.dispose();
    };

  }, [layoutData, simResult, showComponents, showTraces, showThermalOverlay, showStackup, soldermaskColor]);

  const handleResetCamera = () => {
    setCameraPreset('iso');
  };

  return (
    <div className="flex-1 bg-zinc-950 p-6 flex flex-col gap-5 text-zinc-100 overflow-y-auto h-full select-none">
      {/* 3D Renders Options toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-zinc-900/40 border border-zinc-800 rounded-xl p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-4">
          {/* Toggles */}
          <div className="flex items-center gap-2 text-xs font-mono flex-wrap">
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
              <Eye className="w-3.5 h-3.5" />
              2-Layer Traces
            </button>

            <button
              onClick={() => setShowStackup(!showStackup)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showStackup
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Compass className="w-3.5 h-3.5" />
              Stackup
            </button>

            <button
              onClick={() => setShowThermalOverlay(!showThermalOverlay)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded border transition-all ${
                showThermalOverlay
                  ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
              title="Visualizes SPICE power dissipation as glowing pillars"
            >
              <Flame className="w-3.5 h-3.5 text-amber-500" />
              Heat Pillars
            </button>
          </div>

          {/* Solder Mask Color picker */}
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
            <span>Soldermask:</span>
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

        {/* Camera Presets & Reset */}
        <div className="flex items-center gap-1.5 text-xs font-mono">
          <span className="text-zinc-500 mr-1">Views:</span>
          <button
            onClick={() => setCameraPreset('top')}
            className="px-2.5 py-1 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded text-zinc-300"
          >
            Top
          </button>
          <button
            onClick={() => setCameraPreset('bottom')}
            className="px-2.5 py-1 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded text-zinc-300"
          >
            Bottom
          </button>
          <button
            onClick={() => setCameraPreset('iso')}
            className="px-2.5 py-1 bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 rounded text-zinc-300"
          >
            Iso
          </button>
          <button
            onClick={handleResetCamera}
            title="Reset Camera"
            className="p-1.5 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-colors ml-1"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Renders Box */}
      <div className="bg-zinc-900/30 border border-zinc-850 rounded-2xl p-5 flex flex-col gap-4 shadow-2xl relative">
        <div className="flex items-center justify-between text-sm flex-wrap gap-2">
          <span className="font-bold tracking-wider text-zinc-300 font-mono flex items-center gap-2">
            3D PHOTOREALISTIC WEBGL VIEWER
            <span className="text-xs px-2 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
              Interactive
            </span>
          </span>
          <div className="text-xs font-mono text-zinc-500 flex items-center gap-1">
            <HelpCircle className="w-3.5 h-3.5" />
            Left click + drag to orbit. Right click + drag to pan. Click part to inspect.
          </div>
        </div>

        {/* WebGL Canvas container */}
        <div className="relative w-full bg-[#0a0a0c] border border-zinc-850 rounded-xl overflow-hidden shadow-inner flex items-center justify-center min-h-[560px]">
          <div ref={containerRef} className="w-full h-full min-h-[560px]" />

          {/* Component Inspection Floating HUD */}
          {inspectedComp && (
            <div className="absolute top-4 right-4 z-20 bg-zinc-900/90 backdrop-blur-md border border-cyan-500/40 rounded-xl p-4 shadow-2xl text-xs font-mono text-zinc-200 max-w-xs animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800 mb-2">
                <div className="flex items-center gap-2 font-bold text-cyan-400">
                  <Info className="w-4 h-4" />
                  <span>{inspectedComp.id}</span>
                </div>
                <button
                  onClick={() => setInspectedComp(null)}
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  ×
                </button>
              </div>
              <div className="space-y-1 text-zinc-300">
                <div>Type: <span className="text-zinc-100 capitalize">{inspectedComp.type}</span></div>
                <div>Position: <span className="text-zinc-100">{inspectedComp.pos.x}, {inspectedComp.pos.y} mm</span></div>
                <div>Dissipation: <span className="text-amber-400 font-bold">{inspectedComp.power * 1000} mW</span></div>
                <div>Est. \(\Delta T\): <span className="text-emerald-400">+{inspectedComp.tempRise} °C</span></div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
