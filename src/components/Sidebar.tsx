import React, { useState } from 'react';
import type { SchematicComponent, ComponentType } from '../types/pcb';
import { PARTS, PART_TYPES } from '../project/parts';
import { FileText, Cpu, AlertTriangle, Search, X } from 'lucide-react';

interface SidebarProps {
  selectedComponent: SchematicComponent | null;
  onUpdateComponent: (updated: SchematicComponent) => void;
  onDeleteComponent: (id: string) => void;
  onAddComponent: (type: ComponentType) => void;
  onLoadPreset: (presetName: string) => void;
  drcErrors: string[];
}

export const Sidebar: React.FC<SidebarProps> = ({
  selectedComponent,
  onUpdateComponent,
  onDeleteComponent,
  onAddComponent,
  onLoadPreset,
  drcErrors
}) => {
  const [activeTab, setActiveTab] = useState<'library' | 'properties' | 'presets' | 'drc'>('library');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'passives' | 'actives' | 'ics' | 'sources'>('all');

  // The library is whatever the part table declares, so a new component type appears here
  // by existing rather than by being listed again.
  const libraryItems = PART_TYPES.map(type => ({ type, ...PARTS[type] }));

  return (
    <aside aria-label="Component library and design properties" className="component-sidebar w-80 flex flex-col border-r border-zinc-800 bg-zinc-950/80 backdrop-blur-md text-zinc-100 h-full select-none">
      {/* Sidebar Header */}
      <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="font-bold text-lg tracking-wider text-cyan-400 flex items-center gap-2">
          <Cpu className="w-5 h-5 text-cyan-400 animate-pulse" />
          AURA PCB
        </h1>
        <span className="text-xs px-2 py-0.5 bg-zinc-800 rounded text-zinc-400 border border-zinc-700">v1.3-beta</span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 bg-zinc-900/40 text-xs">
        <button
          onClick={() => setActiveTab('library')}
          className={`flex-1 py-3 text-center border-b-2 font-medium transition-all ${
            activeTab === 'library'
              ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Library
        </button>
        <button
          onClick={() => setActiveTab('properties')}
          className={`flex-1 py-3 text-center border-b-2 font-medium transition-all ${
            activeTab === 'properties'
              ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Properties
        </button>
        <button
          onClick={() => setActiveTab('presets')}
          className={`flex-1 py-3 text-center border-b-2 font-medium transition-all ${
            activeTab === 'presets'
              ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Presets
        </button>
        <button
          onClick={() => setActiveTab('drc')}
          className={`flex-1 py-3 text-center border-b-2 font-medium transition-all ${
            activeTab === 'drc'
              ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
              : 'border-transparent text-zinc-400 hover:text-zinc-200'
          }`}
        >
          DRC {drcErrors.length > 0 && <span className="bg-red-500 text-white rounded-full px-1.5 py-0.2 ml-1 text-[9px]">{drcErrors.length}</span>}
        </button>
      </div>

      {/* Tab Contents */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {activeTab === 'library' && (() => {
          const categories: { id: 'all' | 'passives' | 'actives' | 'ics' | 'sources'; label: string }[] = [
            { id: 'all', label: 'All' },
            { id: 'passives', label: 'Passives' },
            { id: 'actives', label: 'Actives' },
            { id: 'ics', label: 'ICs' },
            { id: 'sources', label: 'Power/GND' }
          ];

          const filteredItems = libraryItems.filter(item => {
            const matchesCategory = selectedCategory === 'all' || item.category === selectedCategory;
            const matchesSearch = item.label.toLowerCase().includes(searchQuery.toLowerCase()) || 
                                  item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                                  item.type.toLowerCase().includes(searchQuery.toLowerCase());
            return matchesCategory && matchesSearch;
          });

          return (
            <div className="space-y-4">
              {/* Search Bar */}
              <div className="relative">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search components..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setSearchQuery('');
                  }}
                  className="w-full bg-zinc-900/60 border border-zinc-850 hover:border-zinc-700 focus:border-cyan-500 focus:outline-none rounded-lg pl-9 pr-8 py-2 text-xs text-zinc-200 placeholder-zinc-500 font-mono transition-all"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-2.5 text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Category Filter Chips */}
              <div className="flex flex-wrap gap-1.5 pb-1 select-none">
                {categories.map(cat => {
                  const isActive = selectedCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => setSelectedCategory(cat.id)}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-mono transition-all border ${
                        isActive
                          ? 'bg-cyan-950/20 border-cyan-500/40 text-cyan-400 font-bold'
                          : 'bg-zinc-900/30 border-zinc-850 text-zinc-400 hover:text-zinc-200 hover:border-zinc-750'
                      }`}
                    >
                      {cat.label}
                    </button>
                  );
                })}
              </div>

              {/* Components List */}
              <div className="space-y-2">
                <div className="flex justify-between items-center text-xs text-zinc-500 font-mono mb-1">
                  <span>Component Placement</span>
                  <span>{filteredItems.length} found</span>
                </div>
                {filteredItems.length === 0 ? (
                  <div className="text-center py-8 text-zinc-600 text-xs font-mono border border-dashed border-zinc-850 rounded-lg">
                    No components match search
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2">
                    {filteredItems.map(item => (
                      <button
                        key={item.type}
                        onClick={() => onAddComponent(item.type)}
                        className="flex items-center gap-3 p-3 bg-zinc-900/60 border border-zinc-800 hover:border-cyan-500 hover:bg-cyan-500/5 rounded-lg text-left transition-all group hover-premium-card"
                      >
                        <div className="w-10 h-10 flex items-center justify-center rounded bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono text-[10px] group-hover:text-cyan-400 group-hover:border-cyan-500/50 transition-colors">
                          {item.type.slice(0, 3).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors">{item.label}</div>
                          <div className="text-[11px] text-zinc-400 truncate">{item.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {activeTab === 'properties' && (
          <div className="space-y-4">
            {selectedComponent ? (
              <div className="space-y-4">
                <div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-lg">
                  <div className="text-xs text-zinc-500 font-mono">Component ID</div>
                  <div className="text-lg font-mono font-bold text-cyan-400">{selectedComponent.id}</div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-zinc-400 font-medium">Designator Label</label>
                  <input
                    type="text"
                    value={selectedComponent.name}
                    onChange={(e) => onUpdateComponent({ ...selectedComponent, name: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-cyan-500 focus:outline-none rounded px-3 py-2 text-sm text-zinc-100 font-mono"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-zinc-400 font-medium">Component Value</label>
                  <input
                    type="text"
                    value={selectedComponent.value}
                    onChange={(e) => onUpdateComponent({ ...selectedComponent, value: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 focus:border-cyan-500 focus:outline-none rounded px-3 py-2 text-sm text-zinc-100 font-mono"
                  />
                  <p className="text-[10px] text-zinc-500 font-mono">e.g. 10k, 100n, 5V, sin(0, 5, 1k)</p>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2">
                  <button
                    onClick={() => {
                      const nextRot = (selectedComponent.rotation + 90) % 360;
                      onUpdateComponent({ ...selectedComponent, rotation: nextRot });
                    }}
                    className="py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 rounded text-xs text-zinc-300 font-medium transition-all"
                  >
                    Rotate (R)
                  </button>
                  <button
                    onClick={() => onDeleteComponent(selectedComponent.id)}
                    className="py-2 bg-red-950/40 hover:bg-red-900/40 border border-red-900/50 hover:border-red-500 rounded text-xs text-red-400 font-medium transition-all"
                  >
                    Delete
                  </button>
                </div>

                <div className="border-t border-zinc-800 pt-4 space-y-2">
                  <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Parameters</h3>
                  <div className="space-y-1.5 font-mono text-xs text-zinc-400">
                    <div>Type: <span className="text-zinc-200 capitalize">{selectedComponent.type}</span></div>
                    <div>Position: <span className="text-zinc-200">{selectedComponent.x}, {selectedComponent.y}</span></div>
                    <div>Pins count: <span className="text-zinc-200">{selectedComponent.pins.length}</span></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-zinc-500">
                <FileText className="w-12 h-12 mx-auto text-zinc-700 mb-3" />
                <p className="text-sm">No component selected</p>
                <p className="text-xs mt-1 text-zinc-600">Click a component in the schematic or layout editor to view properties.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'presets' && (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Research Reference Circuits</h2>
            
            <button
              onClick={() => onLoadPreset('astable555')}
              className="w-full text-left p-3.5 bg-zinc-900/60 hover:bg-cyan-500/5 border border-zinc-800 hover:border-cyan-500 rounded-lg transition-all group hover-premium-card"
            >
              <div className="text-sm font-semibold text-zinc-200 group-hover:text-cyan-400 transition-colors">555 Astable Multivibrator</div>
              <p className="text-[11px] text-zinc-400 mt-1">Generates a continuous square wave. Excellent for testing capacitor charging and transient signal integrity.</p>
            </button>

            <button
              onClick={() => onLoadPreset('ledFlasher')}
              className="w-full text-left p-3.5 bg-zinc-900/60 hover:bg-cyan-500/5 border border-zinc-800 hover:border-cyan-500 rounded-lg transition-all group hover-premium-card"
            >
              <div className="text-sm font-semibold text-zinc-200 group-hover:text-cyan-400 transition-colors">Transistor LED Flasher</div>
              <p className="text-[11px] text-zinc-400 mt-1">NPN BJT switching circuit. Showcases non-linear transistor threshold switching and LED power load dissipation.</p>
            </button>

            <button
              onClick={() => onLoadPreset('bandpassFilter')}
              className="w-full text-left p-3.5 bg-zinc-900/60 hover:bg-cyan-500/5 border border-zinc-800 hover:border-cyan-500 rounded-lg transition-all group hover-premium-card"
            >
              <div className="text-sm font-semibold text-zinc-200 group-hover:text-cyan-400 transition-colors">Op-Amp Active Bandpass Filter</div>
              <p className="text-[11px] text-zinc-400 mt-1">Dual-feedback bandpass filter using an operational amplifier. Demonstrates negative feedback loop simulation.</p>
            </button>

            <button
              onClick={() => onLoadPreset('rlcResonant')}
              className="w-full text-left p-3.5 bg-zinc-900/60 hover:bg-cyan-500/5 border border-zinc-800 hover:border-cyan-500 rounded-lg transition-all group hover-premium-card"
            >
              <div className="text-sm font-semibold text-zinc-200 group-hover:text-cyan-400 transition-colors">RLC Resonant Circuit</div>
              <p className="text-[11px] text-zinc-400 mt-1">A simple passive RLC filter with AC sine source. Perfect for plotting voltage peaks, ringing, and phase shifts.</p>
            </button>
          </div>
        )}

        {activeTab === 'drc' && (
          <div className="space-y-3">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Real-Time Design Rule Check</h2>
            
            {drcErrors.length === 0 ? (
              <div className="bg-emerald-950/20 border border-emerald-900/50 rounded-lg p-4 text-emerald-400 text-center text-xs">
                <div className="font-bold text-sm mb-1 text-emerald-300">No automated findings</div>
                Current geometry passes the supported checks. Review footprints and your fabricator's rules before manufacture.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="bg-red-950/20 border border-red-900/50 rounded-lg p-3 text-red-400 text-xs flex gap-2 items-center">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <div>
                    <span className="font-bold text-red-300">{drcErrors.length} Board Findings</span>
                    <p className="text-[10px] text-red-400/80">Review connectivity, clearance, board edges, and fabrication limits.</p>
                  </div>
                </div>
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {drcErrors.map((err, idx) => (
                    <div key={idx} className="p-2.5 bg-zinc-900 border-l-2 border-red-500 font-mono text-[11px] text-zinc-300 flex items-start justify-between">
                      <span>{err}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-zinc-800 pt-4 mt-4 space-y-2">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">DRC Rules</h3>
              <div className="space-y-1.5 font-mono text-xs text-zinc-500">
                <div>Clearance (Trace-Trace): <span className="text-zinc-300">0.25 mm</span></div>
                <div>Clearance (Trace-Pad): <span className="text-zinc-300">0.25 mm</span></div>
                <div>Min Trace Width: <span className="text-zinc-300">0.20 mm</span></div>
                <div>Minimum Drill: <span className="text-zinc-300">0.35 mm</span></div>
                <div>Annular Ring: <span className="text-zinc-300">0.15 mm</span></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
