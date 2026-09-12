import { useState } from 'react';
import { Layers, Ruler, Save } from 'lucide-react';
import type { PCBLayoutData, SignalModelSettings } from '../types/pcb';
import { DEFAULT_SIGNAL_MODEL, parseSignalModel, resizeBoard, SIGNAL_FIELDS, signalModelFor } from '../project/boardSettings';

export function BoardSetupPanel({ layout, onApply }: { layout: PCBLayoutData; onApply: (layout: PCBLayoutData) => void }) {
  const saved = signalModelFor(layout);
  const [width, setWidth] = useState(String(layout.boardWidth));
  const [height, setHeight] = useState(String(layout.boardHeight));
  const [draft, setDraft] = useState(() => Object.fromEntries(SIGNAL_FIELDS.map(f => [f.key, String(saved[f.key])])) as Record<keyof SignalModelSettings, string>);
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      if (!width.trim() || !height.trim() || Object.values(draft).some(value => !value.trim())) throw new Error('Complete every field before applying the setup.');
      const signalModel = parseSignalModel(Object.fromEntries(SIGNAL_FIELDS.map(field => [field.key, Number(draft[field.key])])));
      onApply({ ...resizeBoard(layout, Number(width), Number(height)), signalModel });
      setError(''); setApplied(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Invalid board setup.'); }
  };
  return <section className="board-setup-panel">
    <div className="setup-heading"><div><span className="project-eyebrow">PROJECT CONFIGURATION</span><h2>Board setup</h2><p>Set the outline and shared signal model before comparing designs.</p></div><span className="setup-chip">Two copper layers</span></div>
    <form onSubmit={apply}>
      <div className="setup-grid">
        <fieldset><legend><Ruler size={17} /> Board outline</legend><p>Dimensions in millimetres. Applying a smaller outline keeps component and copper positions; board checks show any new edge violations.</p>
          <div className="setup-fields">
            <label>Board width (mm)<input aria-label="Board width (mm)" value={width} onChange={e => { setWidth(e.target.value); setApplied(false); }} inputMode="decimal" /></label>
            <label>Board height (mm)<input aria-label="Board height (mm)" value={height} onChange={e => { setHeight(e.target.value); setApplied(false); }} inputMode="decimal" /></label>
          </div>
          <div className="setup-summary"><strong>{layout.boardWidth} × {layout.boardHeight} mm</strong><span>Current outline · {(layout.boardWidth * layout.boardHeight / 100).toFixed(1)} cm²</span></div>
          <p>Changes support undo/redo and are included in local recovery and project downloads.</p>
        </fieldset>
        <fieldset><legend><Layers size={17} /> Shared SI inputs</legend><p>Saved values feed Signal Integrity and Research Lab. Plane distance describes the assumed microstrip geometry; it does not change the illustrative 3D or thermal board thickness.</p>
          <div className="setup-fields">{SIGNAL_FIELDS.map(field => <label key={field.key}>{field.label}<input aria-label={field.label} value={draft[field.key]} inputMode="decimal" onChange={e => { setDraft({ ...draft, [field.key]: e.target.value }); setApplied(false); }} /></label>)}</div>
          <button type="button" className="setup-reset" onClick={() => { setDraft(Object.fromEntries(SIGNAL_FIELDS.map(f => [f.key, String(DEFAULT_SIGNAL_MODEL[f.key])])) as Record<keyof SignalModelSettings, string>); setApplied(false); }}>Use default SI inputs</button>
        </fieldset>
      </div>
      <div className="setup-footer"><button className="setup-apply" type="submit"><Save size={16} />Apply setup</button><span role="status">{applied ? 'Setup saved to this project.' : 'Apply to update the board and analysis together.'}</span></div>
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </form>
    <div className="setup-note">A modeled copper pour is not proof of a continuous return path beneath a trace. Review clearance cuts, real laminate properties, and device edge rates when interpreting the SI estimate.</div>
  </section>;
}
