import type { Aperture } from './gerber';
type Point = { x: number; y: number };
export type PreviewCommand = { dark: boolean } & (
  { kind: 'flash'; aperture: Aperture; at: Point } |
  { kind: 'stroke'; width: number; from: Point; to: Point } |
  { kind: 'region'; points: Point[] }
);

/** Parses precisely the linear RS-274X subset emitted by AURA, not arbitrary CAM files. */
export function parseGeneratedGerber(contents: string): PreviewCommand[] {
  const apertures = new Map<number, Aperture>();
  const result: PreviewCommand[] = [];
  let selected = 0; let dark = true; let at = { x: 0, y: 0 }; let region: Point[] | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    const aperture = /^%ADD(\d+)(C|R),([\d.]+)(?:X([\d.]+))?\*%$/.exec(line);
    if (aperture) { apertures.set(Number(aperture[1]), aperture[2] === 'C' ? { shape: 'C', diameter: Number(aperture[3]) } : { shape: 'R', width: Number(aperture[3]), height: Number(aperture[4]) }); continue; }
    if (line === '%LPD*%') { dark = true; continue; }
    if (line === '%LPC*%') { dark = false; continue; }
    if (line === 'G36*') { region = []; continue; }
    if (line === 'G37*') { if (!region) throw new Error('Unmatched Gerber region.'); result.push({ kind: 'region', dark, points: region }); region = null; continue; }
    const code = /^D(\d+)\*$/.exec(line);
    if (code) { selected = Number(code[1]); continue; }
    const command = /^X(-?\d+)Y(-?\d+)D(01|02|03)\*$/.exec(line);
    if (!command) continue;
    const next = { x: Number(command[1]) / 1e6, y: Number(command[2]) / 1e6 };
    if (region) region.push(next);
    else if (command[3] !== '02') {
      const shape = apertures.get(selected);
      if (!shape) throw new Error('Gerber uses an undefined aperture.');
      if (command[3] === '03') result.push({ kind: 'flash', dark, aperture: shape, at: next });
      else if (shape.shape === 'C') result.push({ kind: 'stroke', dark, width: shape.diameter, from: at, to: next });
      else throw new Error('Unsupported stroke aperture.');
    }
    at = next;
  }
  if (region) throw new Error('Unterminated Gerber region.');
  return result;
}

export function renderGerberCommands(ctx: CanvasRenderingContext2D, commands: PreviewCommand[], height: number, scale: number, color: string) {
  const move = (p: Point) => [p.x * scale, (height - p.y) * scale] as const;
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const command of commands) {
    ctx.globalCompositeOperation = command.dark ? 'source-over' : 'destination-out';
    ctx.beginPath();
    if (command.kind === 'flash') {
      const [x, y] = move(command.at);
      if (command.aperture.shape === 'C') ctx.arc(x, y, command.aperture.diameter * scale / 2, 0, Math.PI * 2);
      else ctx.rect(x - command.aperture.width * scale / 2, y - command.aperture.height * scale / 2, command.aperture.width * scale, command.aperture.height * scale);
      ctx.fill();
    } else if (command.kind === 'stroke') {
      ctx.lineWidth = command.width * scale; ctx.moveTo(...move(command.from)); ctx.lineTo(...move(command.to)); ctx.stroke();
    } else {
      command.points.forEach((p, i) => { if (i) ctx.lineTo(...move(p)); else ctx.moveTo(...move(p)); });
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}
