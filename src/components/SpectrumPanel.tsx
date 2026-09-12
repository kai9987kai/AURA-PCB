import { useMemo, useState } from 'react';
import type { SimResult } from '../types/pcb';
import { computeFftSpectrum } from '../simulation/fft';
import { downloadText } from '../project/projectFile';

export function SpectrumPanel({ result }: { result: SimResult }) {
  const [selected, setSelected] = useState('');
  const nodes = result.nodes.filter(n => n !== 'GND');
  const node = nodes.includes(selected) ? selected : nodes[0] ?? '';
  const analysis = useMemo(() => {
    const available = result.nodes.filter(n => n !== 'GND');
    const probe = available.includes(selected) ? selected : available[0] ?? '';
    try { return { spectrum: computeFftSpectrum(result.timepoints, result.voltages[probe] ?? []), error: '' }; }
    catch (e) { return { spectrum: null, error: e instanceof Error ? e.message : 'Spectrum unavailable.' }; }
  }, [result, selected]);
  const s = analysis.spectrum;
  const topDb = s ? Math.max(0, Math.ceil(Math.max(...s.magnitudesDb) / 20) * 20) : 0;
  const path = s?.magnitudesDb.map((db, i) => `${i ? 'L' : 'M'} ${45 + i / (s.magnitudesDb.length - 1) * 620} ${25 + (topDb - db) / (topDb + 120) * 200}`).join(' ');
  const exportCsv = () => {
    if (!s) return;
    downloadText('aura-spectrum.csv', ['frequency_hz,amplitude_dbv_rms', ...s.frequenciesHz.map((f, i) => `${f},${s.magnitudesDb[i]}`)].join('\r\n'), 'text/csv');
  };
  return <section className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-5">
    <div className="flex items-center justify-between gap-3 flex-wrap"><h3 className="text-sm text-cyan-400">Frequency spectrum</h3><div className="flex gap-3 items-center"><select aria-label="Spectrum node" value={node} onChange={e => setSelected(e.target.value)}>{nodes.map(n => <option key={n}>{n}</option>)}</select><button onClick={exportCsv} disabled={!s} className="setup-apply">Export spectrum CSV</button></div></div>
    {analysis.error && <p role="status" className="text-xs text-zinc-400">{analysis.error}</p>}
    {s && <>
      <svg role="img" aria-label={`Amplitude spectrum of ${node} in RMS dBV`} viewBox="0 0 700 265" style={{ width: '100%', maxHeight: 330 }}>
        {[topDb, -40, -80, -120].map(db => <g key={db}><line x1="45" x2="665" y1={25 + (topDb - db) / (topDb + 120) * 200} y2={25 + (topDb - db) / (topDb + 120) * 200} stroke="#283342" /><text x="6" y={29 + (topDb - db) / (topDb + 120) * 200} fontSize="10" fill="#9baabd">{db}</text></g>)}
        <path d={path} fill="none" stroke="#67e8f9" strokeWidth="1.5" />
        <text x="45" y="246" fontSize="11" fill="#9baabd">0 Hz</text><text x="665" y="246" textAnchor="end" fontSize="11" fill="#9baabd">{s.nyquistHz.toPrecision(4)} Hz</text>
      </svg>
      <div className="grid grid-cols-2 gap-3 text-xs text-zinc-300"><span>Dominant AC: {s.fundamentalFreqHz ? `${s.fundamentalFreqHz.toPrecision(4)} Hz · ${s.peakMagnitudeDb.toFixed(2)} dBV` : 'none'}</span><span>DC: {s.dcOffsetV.toPrecision(4)} V · total RMS: {s.rmsV.toPrecision(4)} V</span><span>{s.sampleCount} samples · Δf {s.frequencyResolutionHz.toPrecision(4)} Hz</span><span>Harmonic ratio (2–5): {s.thdPercent === null ? 'unavailable' : `${s.thdPercent.toFixed(3)}%`}</span></div>
      <p className="text-xs text-zinc-400">Periodic Hann window, RMS amplitude in dBV. Record: {s.startTimeS.toPrecision(4)}–{s.endTimeS.toPrecision(4)} s. DC is removed before windowing and shown separately at 0 Hz.</p>
      {s.warnings.map(w => <p key={w} className="text-xs text-zinc-500">{w}</p>)}
    </>}
  </section>;
}
