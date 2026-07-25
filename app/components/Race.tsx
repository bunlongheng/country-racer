"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { COUNTRIES, type Country } from "../data/countries";
import { FINISH, TRACK_LEN, stepRacer } from "@/lib/race";

const SPRITE = 96; // baked marble sprite resolution (px)
const MAX_ACTIVE = 20; // most marbles allowed on the road at once
const NEED = 3; // finishers needed to end the race (gold/silver/bronze)
const FIRES = 2; // just two small fires on the track
const POP_CHANCE = 0.4; // chance to pop only when a marble rolls right over a fire

type Fire = { u: number; laneN: number };
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

type Racer = {
  i: number; // wobble seed (= country index)
  ci: number; // country index
  dist: number;
  speed: number;
  form: number;
  place: number;
  laneN: number;
  startU: number;
  uAdj: number; // visual along-track nudge from anti-overlap (not race distance)
  dead: boolean;
  pop: number;
  spawn: number; // drop-in animation 1 -> 0
};
type Winner = { country: Country; place: number };

type Theme = {
  name: string;
  bg: string;
  track: string;
  line: string;
  dashed: boolean;
  edge: string;
  decor: "stars" | "trees" | "dots" | "none";
  decorColor: string;
};

const THEMES: Theme[] = [
  { name: "Night", bg: "#04050a", track: "#191c26", line: "rgba(255,255,255,0.5)", dashed: true, edge: "rgba(255,255,255,0.18)", decor: "stars", decorColor: "rgba(255,255,255,0.8)" },
  { name: "Grass", bg: "#08160d", track: "#2b2f38", line: "rgba(255,255,255,0.5)", dashed: true, edge: "rgba(255,255,255,0.16)", decor: "trees", decorColor: "#2e8b45" },
  { name: "Neon", bg: "#070512", track: "#151129", line: "rgba(120,225,255,0.7)", dashed: false, edge: "rgba(140,90,255,0.6)", decor: "dots", decorColor: "rgba(120,225,255,0.5)" },
  { name: "Desert", bg: "#170f04", track: "#332d22", line: "rgba(255,238,200,0.45)", dashed: true, edge: "rgba(255,255,255,0.14)", decor: "none", decorColor: "rgba(0,0,0,0)" },
];

function bakeMarble(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE;
  const g = c.getContext("2d")!;
  const r = SPRITE / 2;
  g.save();
  g.beginPath();
  g.arc(r, r, r - 2, 0, Math.PI * 2);
  g.clip();
  const s = Math.max(SPRITE / img.width, SPRITE / img.height);
  const w = img.width * s;
  const h = img.height * s;
  g.drawImage(img, (SPRITE - w) / 2, (SPRITE - h) / 2, w, h);
  // radial rim shading only (symmetric, so it can rotate). The directional
  // gloss highlight is drawn per-frame and stays put, so the flag reads as a
  // rolling 3D marble under a fixed light.
  const rim = g.createRadialGradient(r, r, r * 0.35, r, r, r);
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(0.72, "rgba(0,0,0,0.06)");
  rim.addColorStop(1, "rgba(0,0,0,0.6)");
  g.fillStyle = rim;
  g.fillRect(0, 0, SPRITE, SPRITE);
  g.restore();
  return c;
}

// Draw one rolling glossy marble: the flag sprite spins by `roll`, then a fixed
// top-left highlight is laid over it so it looks like a 3D ball under light.
function drawBall(ctx: Ctx, sp: HTMLCanvasElement, x: number, y: number, ms: number, roll: number) {
  if (sp && sp.width) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(roll);
    ctx.drawImage(sp, -ms / 2, -ms / 2, ms, ms);
    ctx.restore();
  }
  const hx = x - ms * 0.17;
  const hy = y - ms * 0.2;
  const hg = ctx.createRadialGradient(hx, hy, 1, hx, hy, ms * 0.58);
  hg.addColorStop(0, "rgba(255,255,255,0.72)");
  hg.addColorStop(0.32, "rgba(255,255,255,0.14)");
  hg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, ms / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = hg;
  ctx.fillRect(x - ms / 2, y - ms / 2, ms, ms);
  ctx.restore();
}

// --- Track geometry: a rounded-rect loop hugging the screen edges -----------

type Seg = { len: number; at: (t: number) => { x: number; y: number; nx: number; ny: number } };
type Geo = {
  W: number;
  H: number;
  dpr: number;
  size: number;
  bandHalf: number;
  perim: number;
  segs: Seg[];
  cl: { L: number; T: number; R: number; B: number; r: number };
  hole: { x: number; y: number; w: number; h: number };
  theme: Theme;
};

function buildGeo(W: number, H: number, dpr: number, theme: Theme): Geo {
  const m = Math.min(W, H);
  const inset = m * 0.016; // hug the screen edge
  const band = m * 0.33; // big road - most of the screen is racing surface
  const bandHalf = band / 2;
  const size = band * 0.17; // small marbles so the field never overlaps
  const L = inset + bandHalf;
  const T = inset + bandHalf;
  const R = W - inset - bandHalf;
  const B = H - inset - bandHalf;
  const r = Math.min(R - L, B - T) * 0.16;
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
  return { W, H, dpr, size, bandHalf, perim, segs, cl: { L, T, R, B, r }, hole, theme };
}

function pathPoint(geo: Geo, u: number) {
  let d = (((u % 1) + 1) % 1) * geo.perim;
  for (const seg of geo.segs) {
    if (d <= seg.len) return seg.at(seg.len === 0 ? 0 : d / seg.len);
    d -= seg.len;
  }
  return geo.segs[0].at(0);
}

function uOf(r: Racer): number {
  return (((r.dist / TRACK_LEN + r.startU + r.uAdj) % 1) + 1) % 1;
}

function crossed(u0: number, u1: number, uF: number): boolean {
  return u1 >= u0 ? uF > u0 && uF <= u1 : uF > u0 || uF <= u1;
}

// Full 2D anti-overlap: push overlapping marbles apart both sideways (laneN)
// and along the track (uAdj, a visual-only nudge that never touches race
// distance), so with small marbles on a wide road nothing ever overlaps.
function separate(active: Racer[], g: Geo) {
  const spread = g.bandHalf - g.size * 0.5;
  if (spread <= 0) return;
  const minD = g.size * 1.04;
  for (const r of active) if (!r.dead) r.uAdj *= 0.9; // relax back toward true position
  for (let iter = 0; iter < 6; iter++) {
    for (let i = 0; i < active.length; i++) {
      if (active[i].dead) continue;
      for (let j = i + 1; j < active.length; j++) {
        if (active[j].dead) continue;
        let da = (uOf(active[i]) - uOf(active[j])) * g.perim;
        if (da > g.perim / 2) da -= g.perim;
        else if (da < -g.perim / 2) da += g.perim;
        const dq = (active[i].laneN - active[j].laneN) * spread;
        const d2 = da * da + dq * dq;
        if (d2 >= minD * minD) continue;
        let d = Math.sqrt(d2);
        let nx: number;
        let ny: number;
        if (d < 1e-4) {
          const ang = (i * 2.4) % (Math.PI * 2);
          nx = Math.cos(ang);
          ny = Math.sin(ang);
          d = 0;
        } else {
          nx = da / d;
          ny = dq / d;
        }
        const push = (minD - d) / 2;
        active[i].uAdj += (nx * push) / g.perim;
        active[j].uAdj -= (nx * push) / g.perim;
        active[i].laneN = Math.max(-1, Math.min(1, active[i].laneN + (ny * push) / spread));
        active[j].laneN = Math.max(-1, Math.min(1, active[j].laneN - (ny * push) / spread));
      }
    }
  }
}

type Ctx = CanvasRenderingContext2D;
type Sprites = HTMLCanvasElement[];

function h1(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function drawScenery(ctx: Ctx, g: Geo) {
  ctx.fillStyle = g.theme.bg;
  ctx.fillRect(0, 0, g.W, g.H);
  const t = g.theme;
  if (t.decor === "stars" || t.decor === "dots") {
    for (let i = 0; i < 70; i++) {
      ctx.beginPath();
      ctx.arc(h1(i, 1) * g.W, h1(i, 2) * g.H, (0.6 + h1(i, 3) * 1.6) * g.dpr, 0, Math.PI * 2);
      ctx.fillStyle = t.decorColor;
      ctx.fill();
    }
  } else if (t.decor === "trees") {
    for (let i = 0; i < 22; i++) {
      const x = h1(i, 1) * g.W;
      const y = h1(i, 2) * g.H;
      const s = (8 + h1(i, 3) * 10) * g.dpr;
      ctx.fillStyle = "#6b4a2b";
      ctx.fillRect(x - s * 0.12, y, s * 0.24, s * 0.7);
      ctx.beginPath();
      ctx.moveTo(x, y - s);
      ctx.lineTo(x - s * 0.6, y + s * 0.1);
      ctx.lineTo(x + s * 0.6, y + s * 0.1);
      ctx.closePath();
      ctx.fillStyle = t.decorColor;
      ctx.fill();
    }
  }
}

function trackPath(ctx: Ctx, g: Geo) {
  ctx.beginPath();
  ctx.roundRect(g.cl.L, g.cl.T, g.cl.R - g.cl.L, g.cl.B - g.cl.T, g.cl.r);
}

function drawTrack(ctx: Ctx, g: Geo) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2;
  ctx.strokeStyle = g.theme.track;
  ctx.stroke();
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2 + 2 * g.dpr;
  ctx.strokeStyle = g.theme.edge;
  ctx.globalCompositeOperation = "destination-over";
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  trackPath(ctx, g);
  ctx.lineWidth = 2 * g.dpr;
  ctx.setLineDash(g.theme.dashed ? [10 * g.dpr, 12 * g.dpr] : []);
  ctx.strokeStyle = g.theme.line;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Two small marble-sized fires, each sitting in one lane. Roll right over one
// and you might pop - most marbles pass safely beside it.
function drawFires(ctx: Ctx, g: Geo, fires: Fire[], t: number) {
  const spread = g.bandHalf - g.size * 0.5;
  const rad = g.size * 0.5;
  for (const fire of fires) {
    const p = pathPoint(g, fire.u);
    const x = p.x + p.nx * fire.laneN * spread;
    const y = p.y + p.ny * fire.laneN * spread;
    const flick = 0.9 + 0.1 * Math.sin(t * 10 + fire.u * 40);
    const gl = ctx.createRadialGradient(x, y, rad * 0.1, x, y, rad * 1.7 * flick);
    gl.addColorStop(0, "rgba(255,200,80,0.85)");
    gl.addColorStop(0.5, "rgba(255,100,20,0.5)");
    gl.addColorStop(1, "rgba(255,60,0,0)");
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(x, y, rad * 1.7 * flick, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, rad * flick, 0, Math.PI * 2);
    ctx.fillStyle = "#ff7a1a";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, rad * 0.55 * flick, 0, Math.PI * 2);
    ctx.fillStyle = "#ffe066";
    ctx.fill();
  }
}

function drawFinish(ctx: Ctx, g: Geo) {
  const p = pathPoint(g, 0);
  ctx.save();
  ctx.lineWidth = 4 * g.dpr;
  ctx.setLineDash([7 * g.dpr, 7 * g.dpr]);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.moveTo(p.x - p.nx * g.bandHalf, p.y - p.ny * g.bandHalf);
  ctx.lineTo(p.x + p.nx * g.bandHalf, p.y + p.ny * g.bandHalf);
  ctx.stroke();
  ctx.restore();
}

function drawMarbles(ctx: Ctx, g: Geo, active: Racer[], sprites: Sprites) {
  const spread = g.bandHalf - g.size * 0.5;
  // leader ring on the 3 furthest live racers
  const live = active.filter((r) => !r.dead).sort((a, b) => b.dist - a.dist);
  const leaders = new Set(live.slice(0, 3));
  for (const r of active) {
    const p = pathPoint(g, uOf(r));
    const off = r.laneN * spread;
    const x = p.x + p.nx * off;
    let y = p.y + p.ny * off;
    const sp = sprites[r.ci];

    if (r.dead) {
      if (r.pop <= 0) continue;
      const t = 1 - r.pop;
      const ms = g.size * (1 + t * 0.9);
      ctx.globalAlpha = r.pop;
      if (sp && sp.width) ctx.drawImage(sp, x - ms / 2, y - ms / 2, ms, ms);
      ctx.beginPath();
      ctx.arc(x, y, ms * 0.62, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * g.dpr;
      ctx.strokeStyle = `rgba(255,220,150,${r.pop})`;
      ctx.stroke();
      ctx.globalAlpha = 1;
      continue;
    }

    let ms = g.size;
    if (r.spawn > 0) {
      // drop-in: fall from above + fade
      y -= r.spawn * g.size * 1.4;
      ctx.globalAlpha = 1 - r.spawn;
      ms = g.size * (1.2 - r.spawn * 0.2);
    }
    drawBall(ctx, sp, x, y, ms, r.dist * 0.13); // spin ∝ distance = rolling
    ctx.globalAlpha = 1;

    if (leaders.has(r) && r.spawn <= 0) {
      const idx = [...leaders].indexOf(r);
      ctx.beginPath();
      ctx.arc(x, y, ms / 2 + 2 * g.dpr, 0, Math.PI * 2);
      ctx.lineWidth = 3 * g.dpr;
      ctx.strokeStyle = ["#ffd24a", "#cfd6e0", "#e0a06a"][idx] ?? "#ffd24a";
      ctx.stroke();
    }
  }
}

// Tiny centre readout - remaining field + finishers. Small on purpose.
function drawInfo(ctx: Ctx, g: Geo, remaining: number, finished: number) {
  const s = Math.max(11 * g.dpr, g.hole.h * 0.03);
  const cx = g.hole.x + g.hole.w / 2;
  const cy = g.hole.y + g.hole.h / 2;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = `700 ${Math.round(s)}px ${FONT}`;
  ctx.fillText(`${remaining} left`, cx, cy);
  ctx.fillStyle = "rgba(255,210,74,0.8)";
  ctx.font = `700 ${Math.round(s * 0.85)}px ${FONT}`;
  ctx.fillText(`${finished}/${NEED} finished`, cx, cy + s * 1.3);
}

function drawCountdown(ctx: Ctx, g: Geo, countdown: number, goFlash: number) {
  const cx = g.hole.x + g.hole.w / 2;
  const cy = g.hole.y + g.hole.h / 2;
  const big = Math.min(g.hole.w, g.hole.h) * 0.5;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (countdown > 0) {
    const frac = countdown - Math.floor(countdown);
    ctx.globalAlpha = 0.5 + 0.5 * frac;
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 ${Math.round(big)}px ${FONT}`;
    ctx.fillText(`${Math.ceil(countdown)}`, cx, cy);
    ctx.globalAlpha = 1;
  } else if (goFlash > 0) {
    ctx.globalAlpha = Math.min(1, goFlash * 2);
    ctx.fillStyle = "#4ade80";
    ctx.font = `800 ${Math.round(big * 0.9)}px ${FONT}`;
    ctx.fillText("GO!", cx, cy);
    ctx.globalAlpha = 1;
  }
  ctx.textBaseline = "alphabetic";
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    theme: Theme;
    queue: number[];
    active: Racer[];
    finishers: number[];
    fires: Fire[];
    countdown: number;
    goFlash: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
  }>({ sprites: [], theme: THEMES[0], queue: [], active: [], finishers: [], fires: [], countdown: 3, goFlash: 0, elapsed: 0, raf: 0, last: 0, ended: false });

  useEffect(() => {
    let alive = true;
    Promise.all(
      COUNTRIES.map(
        (c) =>
          new Promise<HTMLCanvasElement>((resolve) => {
            const img = new window.Image();
            img.onload = () => resolve(bakeMarble(img));
            img.onerror = () => resolve(document.createElement("canvas"));
            img.src = `/flags/${c.code}.png`;
          }),
      ),
    ).then((sprites) => {
      if (!alive) return;
      state.current.sprites = sprites;
      setPhase("racing");
    });
    return () => {
      alive = false;
    };
  }, []);

  const spawn = useCallback((slot: number): Racer | null => {
    const s = state.current;
    const ci = s.queue.shift();
    if (ci === undefined) return null;
    const lane = slot % 5;
    const row = Math.floor(slot / 5);
    return {
      i: ci,
      ci,
      dist: 0,
      speed: 0,
      form: 0.9 + Math.random() * 0.3,
      place: 0,
      laneN: (lane - 2) / 2 + (Math.random() * 0.2 - 0.1),
      startU: -0.02 * (row + 1), // just behind the start line
      uAdj: 0,
      dead: false,
      pop: 0,
      spawn: 1,
    };
  }, []);

  const startRace = useCallback(() => {
    const s = state.current;
    s.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    s.queue = COUNTRIES.map((_, i) => i);
    for (let i = s.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
    }
    s.active = [];
    for (let k = 0; k < MAX_ACTIVE; k++) {
      const r = spawn(k);
      if (r) {
        r.spawn = 0; // the starting grid is already lined up (no drop-in)
        s.active.push(r);
      }
    }
    s.finishers = [];
    s.fires = Array.from({ length: FIRES }, (_, k) => ({
      u: (k + 0.5) / FIRES + (Math.random() - 0.5) * 0.12,
      laneN: (Math.random() * 2 - 1) * 0.7,
    }));
    s.countdown = 3;
    s.goFlash = 0;
    s.elapsed = 0;
    s.ended = false;
    s.last = 0;
    setPodium([]);
    setPhase("racing");
  }, [spawn]);

  useEffect(() => {
    if (phase !== "racing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const s = state.current;
    if (s.active.length === 0 && s.finishers.length === 0) startRace();

    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (now: number) => {
      const st = state.current;
      if (!st.last) st.last = now;
      const dt = Math.min((now - st.last) / 1000, 0.05);
      st.last = now;
      const g = buildGeo(canvas.width, canvas.height, dpr, st.theme);

      if (!st.ended) {
        if (st.countdown > 0) {
          st.countdown -= dt;
          if (st.countdown <= 0) st.goFlash = 0.8;
        } else {
          st.goFlash = Math.max(0, st.goFlash - dt);
          st.elapsed += dt;
          const spread = g.bandHalf - g.size * 0.5;
          for (const r of st.active) {
            if (r.dead || r.place > 0) continue;
            const u0 = uOf(r);
            stepRacer(r, dt, st.elapsed);
            const u1 = uOf(r);
            // fire pops - only if the marble rolls right over the small fire
            for (const fire of st.fires) {
              const near = Math.abs(r.laneN - fire.laneN) * spread < g.size * 0.85;
              if (near && crossed(u0, u1, fire.u) && Math.random() < POP_CHANCE) {
                r.dead = true;
                r.pop = 1;
                break;
              }
            }
            // finished a full race?
            if (!r.dead && r.dist >= FINISH) {
              r.place = st.finishers.length + 1;
              st.finishers.push(r.ci);
            }
          }
          // replace anyone who left (popped fully or finished) - keep the road full
          for (let k = 0; k < st.active.length; k++) {
            const r = st.active[k];
            if (r.place > 0 || (r.dead && r.pop <= 0)) {
              const next = spawn(k);
              if (next) st.active[k] = next;
              else st.active.splice(k--, 1);
            }
          }
          if (st.finishers.length >= NEED) {
            st.ended = true;
            const top = st.finishers.slice(0, NEED).map((ci, idx) => ({ country: COUNTRIES[ci], place: idx + 1 }));
            setPodium(top);
            setAnnounce(
              `Race finished. Gold ${top[0].country.name}, silver ${top[1].country.name}, bronze ${top[2].country.name}.`,
            );
            setPhase("done");
          }
        }
      }
      // pop timers always run
      for (const r of st.active) if (r.pop > 0) r.pop = Math.max(0, r.pop - dt * 2.2);
      for (const r of st.active) if (r.spawn > 0) r.spawn = Math.max(0, r.spawn - dt * 3);

      separate(st.active, g);
      drawScenery(ctx, g);
      drawTrack(ctx, g);
      drawFires(ctx, g, st.fires, st.elapsed);
      drawFinish(ctx, g);
      drawMarbles(ctx, g, st.active, st.sprites);
      if (st.countdown > 0 || st.goFlash > 0) {
        drawCountdown(ctx, g, st.countdown, st.goFlash);
      } else {
        const remaining = st.queue.length + st.active.filter((r) => !r.dead && r.place === 0).length;
        drawInfo(ctx, g, remaining, st.finishers.length);
      }

      st.raf = requestAnimationFrame(draw);
    };
    s.raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(s.raf);
      window.removeEventListener("resize", resize);
    };
  }, [phase, startRace, spawn]);

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Live race of country flag marbles around a track, dodging fires"
        className="block h-full w-full"
      />
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <p className="text-lg font-semibold">Loading 194 racers…</p>
        </div>
      )}

      {phase === "done" && podium.length === NEED && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="pop mb-8 text-3xl font-bold sm:text-5xl">Podium</h1>
          <div className="pop flex items-end gap-4 sm:gap-8">
            {[1, 0, 2].map((k) => {
              const w = podium[k];
              const medal = ["🥇", "🥈", "🥉"][w.place - 1];
              const size = w.place === 1 ? "h-28 w-40 sm:h-36 sm:w-52" : "h-20 w-32 sm:h-28 sm:w-44";
              const lift = w.place === 1 ? "mb-6" : "";
              return (
                <div key={w.country.code} className={`flex flex-col items-center ${lift}`}>
                  <div className="mb-2 text-4xl sm:text-5xl">{medal}</div>
                  <Image
                    src={`/flags/${w.country.code}.png`}
                    alt={w.country.name}
                    width={208}
                    height={139}
                    className={`${size} rounded-xl object-cover shadow-lg ring-2 ring-white/20`}
                    priority
                  />
                  <p className="mt-2 text-base font-bold sm:text-xl">{w.country.name}</p>
                </div>
              );
            })}
          </div>
          <button
            onClick={startRace}
            className="mt-10 rounded-full bg-white px-8 py-3 text-base font-bold text-black transition hover:scale-105 active:scale-95"
          >
            Race Again
          </button>
        </div>
      )}
    </main>
  );
}
