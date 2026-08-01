// Pure track geometry + the real-space anti-overlap solver. No React, no game
// state, no imports - just the oval math the canvas loop and its unit tests share.
const TRACK_LEN = 1000; // one lap in race units (mirrors lib/race.ts TRACK_LEN)

// The minimal marble shape the geometry needs (the game's Racer satisfies it).
export type Body = { dist: number; startU: number; uAdj: number; laneN: number; scale: number };

// A stage = the whole look of the track: outer background, running surface,
// infield fill, line colours, and a painter that decorates the centre infield.
export type Stage = {
  name: string;
  bg: string; // outer background
  road: string; // running surface the marbles roll on
  infield: string; // centre fill
  line: string; // dashed centre-line colour
  edge: string; // road edge line colour
  song: string; // key into the themed music loop for this scene
  decor: (ctx: CanvasRenderingContext2D, g: Geo) => void; // themed infield art
};
// STAGES are defined lower down, next to the drawing helpers they use.

// --- Track geometry ---------------------------------------------------------

export type Seg = { len: number; at: (t: number) => { x: number; y: number; nx: number; ny: number } };
export type Geo = {
  W: number;
  H: number;
  dpr: number;
  size: number;
  bandHalf: number;
  perim: number;
  segs: Seg[];
  cl: { L: number; T: number; R: number; B: number; r: number };
  hole: { x: number; y: number; w: number; h: number };
  stage: Stage;
};

export function buildGeo(W: number, H: number, dpr: number, stage: Stage): Geo {
  const m = Math.min(W, H);
  const inset = m * 0.016;
  const band = m * 0.4; // big road
  const bandHalf = band / 2;
  const size = band * 0.2; // ten marbles -> clear
  const L = inset + bandHalf;
  const T = inset + bandHalf;
  const R = W - inset - bandHalf;
  const B = H - inset - bandHalf;
  // Corner radius = half the shorter side, so the track is a proper oval with
  // fully rounded ends. This keeps the inner edge radius (r - bandHalf) well
  // above zero, so the infield "hole" is a smooth curve, never a square corner.
  const r = Math.min(R - L, B - T) * 0.5;
  const cx = (L + R) / 2;

  const straight = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number): Seg => ({
    len: Math.hypot(x1 - x0, y1 - y0),
    at: (t) => ({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, nx, ny }),
  });
  const arc = (ccx: number, ccy: number, a0: number, a1: number): Seg => ({
    len: Math.abs(a1 - a0) * r,
    at: (t) => {
      const a = a0 + (a1 - a0) * t;
      return { x: ccx + Math.cos(a) * r, y: ccy + Math.sin(a) * r, nx: -Math.cos(a), ny: -Math.sin(a) };
    },
  });

  const segs: Seg[] = [
    straight(cx, T, R - r, T, 0, 1),
    arc(R - r, T + r, -Math.PI / 2, 0),
    straight(R, T + r, R, B - r, -1, 0),
    arc(R - r, B - r, 0, Math.PI / 2),
    straight(R - r, B, L + r, B, 0, -1),
    arc(L + r, B - r, Math.PI / 2, Math.PI),
    straight(L, B - r, L, T + r, 1, 0),
    arc(L + r, T + r, Math.PI, Math.PI * 1.5),
    straight(L + r, T, cx, T, 0, 1),
  ];
  const perim = segs.reduce((sum, seg) => sum + seg.len, 0);
  const hole = { x: L + bandHalf, y: T + bandHalf, w: R - L - band, h: B - T - band };
  return { W, H, dpr, size, bandHalf, perim, segs, cl: { L, T, R, B, r }, hole, stage };
}

export function pathPoint(geo: Geo, u: number) {
  let d = (((u % 1) + 1) % 1) * geo.perim;
  for (const seg of geo.segs) {
    if (d <= seg.len) return seg.at(seg.len === 0 ? 0 : d / seg.len);
    d -= seg.len;
  }
  return geo.segs[0].at(0);
}

export function uOf(r: Body): number {
  return (((r.dist / TRACK_LEN + r.startU + r.uAdj) % 1) + 1) % 1;
}

export function crossed(u0: number, u1: number, uF: number): boolean {
  return u1 >= u0 ? uF > u0 && uF <= u1 : uF > u0 || uF <= u1;
}

// Anti-overlap in REAL screen space. Working in flat (along-track, lane) space
// fails on the tight oval bends, because equal lane spacing maps to much smaller
// real distances on the inside of a curve - so marbles that look separated in u
// still visibly stack. Here each pair is pushed apart by its true (x,y) distance,
// then the push is split back into along-track (uAdj) and lateral (laneN) parts
// via the local track frame, so it stays correct everywhere on the track.
type Frame = { x: number; y: number; tx: number; ty: number; nx: number; ny: number };
export function separate(active: Body[], g: Geo) {
  const spread = g.bandHalf - g.size * 0.5;
  if (spread <= 0) return;
  for (const r of active) r.uAdj *= 0.97;
  const fr: Frame[] = new Array(active.length);
  for (let iter = 0; iter < 20; iter++) {
    // refresh each marble's real position + local tangent/normal
    for (let k = 0; k < active.length; k++) {
      const r = active[k];
      const u = uOf(r);
      const p = pathPoint(g, u);
      const p2 = pathPoint(g, u + 0.002);
      let tx = p2.x - p.x;
      let ty = p2.y - p.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      fr[k] = { x: p.x + p.nx * r.laneN * spread, y: p.y + p.ny * r.laneN * spread, tx, ty, nx: p.nx, ny: p.ny };
    }
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const minD = (g.size * active[i].scale * 0.5 + g.size * active[j].scale * 0.5) * 1.06;
        let dx = fr[i].x - fr[j].x;
        let dy = fr[i].y - fr[j].y;
        let d = Math.hypot(dx, dy);
        if (d >= minD) continue;
        if (d < 1e-4) {
          const a = (i * 2.4) % (Math.PI * 2);
          dx = Math.cos(a);
          dy = Math.sin(a);
          d = 1;
        }
        const ux = dx / d;
        const uy = dy / d;
        const push = (minD - d) / 2;
        // decompose the real-space push into along-track + lateral for each marble
        const ai = ux * fr[i].tx + uy * fr[i].ty;
        const li = ux * fr[i].nx + uy * fr[i].ny;
        active[i].uAdj += (ai * push) / g.perim;
        active[i].laneN = Math.max(-1, Math.min(1, active[i].laneN + (li * push) / spread));
        const aj = ux * fr[j].tx + uy * fr[j].ty;
        const lj = ux * fr[j].nx + uy * fr[j].ny;
        active[j].uAdj -= (aj * push) / g.perim;
        active[j].laneN = Math.max(-1, Math.min(1, active[j].laneN - (lj * push) / spread));
      }
    }
  }
}

export type Ctx = CanvasRenderingContext2D;
