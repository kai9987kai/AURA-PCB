import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Plus, Redo2, Undo2, List } from 'lucide-react';
import { buildBomCsv, downloadText, emptyProject, MAX_FILE_BYTES, parseProject, serializeProject } from '../project/projectFile';
import type { Project } from '../project/projectFile';

interface Props {
  project: Project; onChange: (project: Project, group?: string) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean; saveStatus: string; notice: string;
}
export function ProjectToolbar({ project, onChange, undo, redo, canUndo, canRedo, saveStatus, notice }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [importing, setImporting] = useState(false);
  const filename = project.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'aura-board';
  const save = () => downloadText(`${filename}.aura.json`, serializeProject(project));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); downloadText(`${filename}.aura.json`, serializeProject(project)); return; }
      if ((event.target as HTMLElement)?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      if (key === 'y') { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, filename, undo, redo]);
  const open = async (file?: File) => {
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error('Project files must be smaller than 2 MB.');
      const next = parseProject(await file.text());
      onChange(next, 'replace'); setMessage(`Opened ${next.name}. Undo returns to the previous design.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to read the project.'); }
    finally { setImporting(false); if (input.current) input.current.value = ''; }
  };
  return <div className="project-bar">
    <div className="project-actions">
      <div className="project-identity"><span className="project-eyebrow">DESIGN WORKSPACE</span><input aria-label="Project name" maxLength={80} value={project.name} onChange={e => onChange({ ...project, name: e.target.value }, 'name')} /></div>
      <span className="save-indicator" role="status">{saveStatus}</span>
      <div className="project-buttons">
        <button onClick={() => { onChange(emptyProject()); setMessage('New project. Undo restores your previous design.'); }} title="New project (undoable)"><Plus size={15} />New</button>
        <button onClick={() => input.current?.click()} disabled={importing}><FolderOpen size={15} />{importing ? 'Opening…' : 'Open'}</button>
        <button onClick={save} title="Download project (Ctrl+S)"><Download size={15} />Save</button>
        <button onClick={() => downloadText(`${filename}-bom.csv`, buildBomCsv(project), 'text/csv;charset=utf-8')} disabled={!project.schematic.components.length}><List size={15} />BOM</button>
        <span className="toolbar-divider" />
        <button onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={16} /></button>
        <button onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 size={16} /></button>
      </div>
      <input ref={input} type="file" accept=".json,.aura.json" hidden aria-label="Open project file" onChange={e => void open(e.target.files?.[0])} />
    </div>
    {(message || notice) && <div className="project-notice" role="status">{message || notice}{message && <button aria-label="Dismiss notification" onClick={() => setMessage('')}>×</button>}</div>}
  </div>;
}
