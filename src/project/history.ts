import { reconcileCopper } from './connectivity';
import type { Project } from './projectFile';

export interface HistoryState { present: Project; past: Project[]; future: Project[]; group?: string; at: number; changed: boolean; notice: string }
export type HistoryAction = { type: 'edit'; project: Project; group?: string; at: number } | { type: 'undo' | 'redo' };
export const createHistory = (project: Project, notice = ''): HistoryState => ({ present: project, past: [], future: [], at: 0, changed: false, notice });
export function projectHistory(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    if (!state.past.length) return state;
    return { ...state, present: state.past.at(-1)!, past: state.past.slice(0, -1), future: [state.present, ...state.future], group: undefined, changed: true };
  }
  if (action.type === 'redo') {
    if (!state.future.length) return state;
    return { ...state, present: state.future[0], past: [...state.past, state.present], future: state.future.slice(1), group: undefined, changed: true };
  }
  if (action.type !== 'edit' || JSON.stringify(action.project) === JSON.stringify(state.present)) return state;
  const normalized = reconcileCopper(action.group === 'replace' ? action.project.schematic : state.present.schematic, action.project.schematic, action.project.pcbLayout);
  const removed = action.project.pcbLayout.traces.length - normalized.pcbLayout.traces.length;
  const coalesce = action.group && action.group !== 'replace' && action.group === state.group && action.at - state.at < 600;
  return {
    present: { ...action.project, ...normalized }, past: coalesce ? state.past : [...state.past, state.present].slice(-60), future: [],
    group: action.group, at: action.at, changed: true,
    notice: removed > 0 ? `${removed} ambiguous route(s) removed after a net split. Undo restores the previous design.` : '',
  };
}
