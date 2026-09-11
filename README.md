# AURA PCB Design Suite

AURA PCB is a research-grade, browser-based EDA (Electronic Design Automation) and physics-informed CAD suite. It integrates schematic capture, grid-snapped board layout, real-time SPICE-like circuit simulation, 2D finite-difference thermal diffusion solvers, transmission-line signal integrity solvers, and a photorealistic 3D WebGL board renderer into a dark-themed React application.

---

## Key Features

### 1. Interactive Schematic Capture
- **Vector Drawing**: Drag, place, wire, and rotate components on a grid-snapped canvas.
- **Visual Simulations**: Visualizes live simulated voltages (node coloring: positive is red, negative is blue, zero is green) and currents (flowing dash speed proportional to current magnitude).

### 2. 2D PCB Layout Editor
- **Manual & Auto-routing**: Route copper traces manually with automatic multi-segment snapping and via placement, or utilize **Lee's Grid Autorouter** (BFS pathfinder on a 1mm routing grid).
- **Ratsnest Airwires**: Visualizes missing connections to guide trace layout.
- **Copper Pours**: Flood either layer with a ground plane. The pour is a real board object, not a preview: it joins same-net copper that falls inside it, so a ground net can be completed by a plane instead of traces, and it is written into the Gerber as a filled region with every other net cleared out of it in negative polarity.
- **Real-Time DRC (Design Rule Checker)**: Flags trace width clearance (min 0.20mm) and overlap errors (min 0.25mm spacing) with red target rings.

### 3. SPICE Simulation Engine
- **Custom MNA (Modified Nodal Analysis) Solver**: Built-in linear and non-linear solver ($G \cdot v + C \cdot \frac{dv}{dt} = i$) using Newton-Raphson iteration.
- **Support for Advanced Parts**: Models resistors, capacitors, inductors, potentiometers, diodes, Zener diodes, LEDs, NPN BJTs, N-channel MOSFETs and op-amps, and behaviorally models the 555 Timer.
- **One Part Table**: Every per-type fact — library entry, reference prefix, default value and parameters, schematic terminals and footprint lands — lives in `src/project/parts.ts`. A new component type becomes placeable, exportable and simulatable by being declared once rather than by being added to six separate switch statements.
- **Digital Oscilloscope Scope**: Probes multiple node voltages dynamically over time with interactive coordinate reading on hover.

### 4. 2D Finite-Difference Thermal Solver
- **Physics-Informed Modeling**: Solves the 2D heat equation:
  $$\frac{\partial T}{\partial t} = \alpha \nabla^2 T + Q$$
- **Material-aware Diffusion**: Differentiates conductivity between copper traces ($390\text{ W/m}\cdot\text{K}$) and FR4 substrate ($0.3\text{ W/m}\cdot\text{K}$).
- **Natural Convection**: Simulates heat dissipation to ambient air using convection equations.
- **Simulation Coupling**: Automatically maps heat sources using component power dissipation ($P = V \times I$) computed in the SPICE simulation.

### 5. High-Speed Signal Integrity Analyzer
- **Impedance Solver**: Computes characteristic impedance ($Z_0$) with the Hammerstad-Jensen quasi-static microstrip model, including the finite conductor-thickness correction. It assumes a uniform external microstrip over a continuous reference plane, which the board editor does not itself model or verify.
- **Reflections Ringing Simulator**: Models transmission-line reflection effects at high frequencies when edge rates are fast relative to propagation delay. Plot outputs on a dedicated ringing scope.
- **Crosstalk Estimator**: Calculates electromagnetic coupling to adjacent parallel traces (crosstalk peak voltage in mV).

### 6. Photorealistic 3D WebGL Viewer
- **Three.js Substrate Rendering**: Realistic board rendering with soldermask color picking (Emerald Green, Slate Blue, Matte Black) and multilayer stackup view.
- **3D Component Packages**: Renders resistors with color bands, electrolytic capacitor cans, colored translucent LEDs, DO-35 diodes, DIP-8 IC chips, and TO-92 transistors.
- **Thermal Dissipation Pillars**: Visualizes component temperature rise as translucent glowing vertical energy cylinders.

### 7. Manufacturing & Interchange Output
- **Gerber RS-274X (X2)**: Two copper layers, soldermask, legend, paste and board outline, in 4.6 absolute millimetre format with layer function attributes.
- **Excellon Drill**: Metric, explicit decimals, one tool per distinct diameter.
- **Pick-and-place Centroid**: Surface-mount parts only, in the same coordinate frame as the copper.
- **SPICE Netlist, both ways**: Exports the captured circuit as a deck whose values follow the built-in solver, and reports every device that could not be translated exactly rather than emitting a card that merely looks right. Imports a deck back — its own or a hand-written one — honouring comments, continuation lines and `.model` parameters (a diode with a breakdown voltage becomes a Zener; a MOSFET keeps its threshold and transconductance), and names every device it had to skip or approximate.
- Every package ships a notes file stating what it does and does not cover. None of it is a design rule check; review it in a CAM viewer before ordering.

### 8. Research Lab Panel
- **DFM / Manufacturing Analysis**: Reports copper density, board occupancy, trace counts, via drill statistics, and total power metrics.
- **Optimization Queue**: Provides high-priority action items (P0/P1/P2 recommendations) for routing completion, impedance matching, DRC fixes, and thermal mitigation.

---

## Directory Structure

```
src/
├── analysis/
│   ├── boardChecks.ts          # Geometry, clearance, pour and net connectivity analysis
│   └── pcbResearch.ts          # Research lab report builder & DRC compiler
├── components/
│   ├── GerberViewerModal.tsx   # Fabrication package preview & per-layer download
│   ├── LayoutEditor.tsx        # 2D layout editor, DRC visualizer, pours, Lee's autorouter
│   ├── ProjectToolbar.tsx      # New/open/save, BOM, SPICE and fabrication exports
│   ├── ResearchPanel.tsx       # Manufacturing snapshot & optimization recommendations
│   ├── SchematicEditor.tsx     # SVG schematic editor with animated current/voltage glow
│   ├── Sidebar.tsx             # Part library search, parameters editor, preset selector
│   ├── SignalIntegrityPanel.tsx# Transmission line scope & impedance recommendations
│   ├── SimulationPanel.tsx     # Scope transient plotting & SPICE settings
│   ├── ThermalPanel.tsx        # 2D heat equation canvas scanner & parameter inputs
│   └── ThreeDPCBViewer.tsx     # Three.js 3D board scene & geometry assembler
├── export/
│   └── gerber.ts               # RS-274X, Excellon drill, centroid & package notes
├── interchange/
│   └── spiceNetlist.ts         # SPICE deck export and import, with explicit translation notes
├── project/
│   ├── connectivity.ts         # Union-find net naming & copper reconciliation
│   ├── parts.ts                # The part table: pins, pads, defaults, library metadata
│   ├── history.ts              # Undo/redo reducer with edit coalescing
│   ├── projectFile.ts          # Bounded, validated project document & BOM export
│   └── useProject.ts           # Autosave, local recovery and commit hooks
├── simulation/
│   ├── fft.ts                  # Spectral transform for the scope
│   ├── signalIntegrity.ts      # Characteristic impedance & ringing simulations
│   ├── spiceSolver.ts          # Modified Nodal Analysis (MNA) matrix solver
│   └── thermalSolver.ts        # Finite-difference Jacobi relaxation thermal solver
├── types/
│   └── pcb.ts                  # Shared Type Definitions
├── App.tsx                     # Main app state manager and tab navigation layout
├── index.css                   # Custom styling variables, custom scrollbars, animations
└── main.tsx                    # React root launcher
```

---

## Getting Started

### Prerequisites
- Node.js (v18+)
- npm

### Installation
1. Clone or copy the project files to your workspace.
2. Install dependencies:
   ```bash
   npm install
   ```

### Development Server
Run the local HMR (Hot Module Replacement) server:
```bash
npm run dev
```
The app will be accessible at [http://localhost:5173/](http://localhost:5173/).

### Production Build
Build and package the production bundle:
```bash
npm run build
```
The build artifacts will be outputted to the `dist/` directory.

---

## Mathematical Foundations & Physics Engines

### A. Circuit Simulator (Modified Nodal Analysis)
The circuit solver parses the schematic into nodes, sets up the companion model stamps for reactive components (backward Euler companion grids for capacitors and inductors), and formulates the conductance matrix. For non-linear parts like diodes and transistors, it performs Newton-Raphson iteration:
$$v^{(k+1)} = v^{(k)} - J(v^{(k)})^{-1} \cdot f(v^{(k)})$$

### B. Thermal Diffusion (Jacobi Relaxation)
The heat solver utilizes a discrete 2D grid overlay ($1.5\text{mm}$ cells) and calculates heat conduction between cells based on adjacent interfaces:
$$T_{c,r}^{(new)} = \frac{k_r T_{r} + k_l T_{l} + k_u T_{u} + k_d T_{d} + \frac{Q_{c,r}}{d_z} + \frac{2 h_c dx^2}{d_z} T_{amb}}{k_r + k_l + k_u + k_d + \frac{2 h_c dx^2}{d_z}}$$
Where:
- $k$ is interface thermal conductivity, taken from the copper in each cell: pours first, then traces and pads.
- $Q$ is heat input generated by component power dissipation.
- $h_c$ is the natural air convection coefficient, applied to both faces and expressed per unit volume as $2h_c/d_z$ so that it scales like the source term. A surface coefficient used directly here is roughly three orders of magnitude weaker than conduction, which leaves the board with no effective heat sink at all.
- $d_z$ is the board thickness ($1.6\text{mm}$).

At steady state every watt leaves through the two faces, so the mean temperature rise is
$\Delta T = P / (2 h_c A)$ regardless of how the copper is arranged. Copper changes the
gradient, not the balance: the regression suite checks the settled mean against that figure for
bare substrate and for a fully poured board, and checks that the pour flattens the hot spot.

### C. Transmission Line Stackup
Characteristic impedance ($Z_0$) is derived from the copper width ($w$), trace thickness ($t$), substrate height ($h$), and effective dielectric constant ($\epsilon_{eff}$).
Reflection coefficients at the source ($\Gamma_S$) and load ($\Gamma_L$) dictate ringing coefficients:
$$\Gamma = \frac{Z - Z_0}{Z + Z_0}$$
Wave propagation time delay ($t_d$) is calculated relative to the speed of light scaled by the effective dielectric constant:
$$t_d = \frac{\text{length}}{c / \sqrt{\epsilon_{eff}}}$$
