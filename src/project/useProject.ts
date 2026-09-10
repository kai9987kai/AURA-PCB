import { useCallback, useEffect, useReducer, useState } from 'react';
import { createHistory, projectHistory } from './history';
import { emptyProject, parseProject, serializeProject, STORAGE_KEY } from './projectFile';
import type { Project } from './projectFile';

function restore() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return createHistory(saved ? parseProject(saved) : emptyProject(), saved ? 'Recovered your locally saved project.' : 'Start with a reference circuit or add a component.');
  } catch {
    return createHistory(emptyProject(), 'Local recovery was unavailable. Import a saved project or start a new design.');
  }
}

export function useProject() {
  const [state, dispatch] = useReducer(projectHistory, undefined, restore);
  const [storage, setStorage] = useState<{ project: Project | null; error: string }>({ project: null, error: '' });
  useEffect(() => {
    if (!state.changed) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, serializeProject(state.present));
        setStorage({ project: state.present, error: '' });
      } catch { setStorage({ project: null, error: 'Local save unavailable — download your project to keep it.' }); }
    }, 300);
    return () => clearTimeout(timer);
  }, [state.present, state.changed]);
  // Flush pending changes on refresh/close, even inside the autosave debounce window.
  useEffect(() => {
    const flush = () => { if (state.changed) { try { localStorage.setItem(STORAGE_KEY, serializeProject(state.present)); } catch { /* UI already offers download. */ } } };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [state.present, state.changed]);
  const commit = useCallback((project: Project, group?: string) => dispatch({ type: 'edit', project, group, at: Date.now() }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  return { project: state.present, commit, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0, notice: state.notice,
    saveStatus: storage.error || (storage.project === state.present ? 'Saved locally' : state.changed ? 'Saving…' : 'Local workspace') };
}
