"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { COUNTRIES, type Country } from "../data/countries";
import { FINISH, TRACK_LEN, stepRacer } from "@/lib/race";

const SPRITE = 96; // baked marble sprite resolution (px)
const RACERS = 10; // fixed field - ten marbles, no more
const NEED = 3; // finishers needed to end the race
const OBSTACLES = 10; // obstacles scattered on the track
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

type Racer = {
  i: number;
  ci: number; // country index
  dist: number;
  speed: number;
  form: number;
  place: number;
  laneN: number;
  startU: number;
  uAdj: number; // visual anti-overlap nudge (not race distance)
  scale: number; // 1 = normal; <1 small+fast, >1 big+slow
  effMul: number; // active speed multiplier from an obstacle
  effTime: number; // seconds remaining on that multiplier
  obCool: number; // debounce so one obstacle fires once per pass
};
type Winner = { country: Country; place: number };

// Obstacle types + their effect. Fires are gone - nothing removes a marble.
type ObType = "boost" | "mud" | "tar" | "banana" | "shrink" | "grow";
type ObShape = "boost" | "plain" | "banana" | "up" | "down";
type Obstacle = { u: number; laneN: number; type: ObType };
const OB: Record<ObType, { color: string; shape: ObShape; mul?: number; time?: number; scale?: number }> = {
  boost: { color: "#33c65a", shape: "boost", mul: 1.8, time: 1.2 }, // green mud - speed up
  mud: { color: "#7a4a24", shape: "plain", mul: 0.55, time: 1.3 }, // brown mud - slow
  tar: { color: "#171922", shape: "plain", mul: 0.4, time: 1.6 }, // black mud - slower
  banana: { color: "#f6d743", shape: "banana", mul: 0.45, time: 1.1 }, // banana - slip
  shrink: { color: "#2aa8ff", shape: "down", scale: 0.78 }, // small -> faster
  grow: { color: "#b45cff", shape: "up", scale: 1.28 }, // big -> slower
};
const OB_TYPES: ObType[] = ["boost", "mud", "tar", "banana", "shrink", "grow"];

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
  const rim = g.createRadialGradient(r, r, r * 0.35, r, r, r);
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(0.72, "rgba(0,0,0,0.06)");
  rim.addColorStop(1, "rgba(0,0,0,0.6)");
  g.fillStyle = rim;
  g.fillRect(0, 0, SPRITE, SPRITE);
  g.restore();
  return c;
}

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

// --- Track geometry ---------------------------------------------------------

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
  const inset = m * 0.016;
  const band = m * 0.33;
  const bandHalf = band / 2;
  const size = band * 0.24; // ten marbles -> a bit bigger and clear
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

// Full 2D anti-overlap using each marble's actual (scaled) radius.
function separate(active: Racer[], g: Geo) {
  const spread = g.bandHalf - g.size * 0.5;
  if (spread <= 0) return;
  for (const r of active) r.uAdj *= 0.9;
  for (let iter = 0; iter < 6; iter++) {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const minD = (g.size * active[i].scale * 0.5 + g.size * active[j].scale * 0.5) * 1.04;
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

function obShape(ctx: Ctx, shape: ObShape, x: number, y: number, s: number) {
  if (shape === "plain") return;
  if (shape === "banana") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.5);
    ctx.beginPath();
    ctx.arc(0, -s * 0.15, s, Math.PI * 0.15, Math.PI * 0.9);
    ctx.lineWidth = s * 0.55;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#8a5a10";
    ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  if (shape === "up" || shape === "down") {
    const d = shape === "up" ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y + d * s * 0.7);
    ctx.lineTo(x - s * 0.72, y - d * s * 0.5);
    ctx.lineTo(x + s * 0.72, y - d * s * 0.5);
    ctx.closePath();
    ctx.fill();
  } else if (shape === "boost") {
    ctx.strokeStyle = "rgba(255,255,255,0.96)";
    ctx.lineWidth = s * 0.28;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const dy of [-s * 0.3, s * 0.28]) {
      ctx.beginPath();
      ctx.moveTo(x - s * 0.6, y + dy + s * 0.28);
      ctx.lineTo(x, y + dy - s * 0.18);
      ctx.lineTo(x + s * 0.6, y + dy + s * 0.28);
      ctx.stroke();
    }
  }
}

// A glossy spinning power-orb with a bright white glow inside (Mario-Kart-item
// vibe), the effect colour, and an orbiting highlight so it reads as spinning.
function drawOrb(ctx: Ctx, g: Geo, x: number, y: number, rad: number, color: string, shape: ObShape, t: number) {
  const seed = (x + y) * 0.01;
  const R = rad * (0.93 + 0.07 * Math.sin(t * 5 + seed));
  const glow = ctx.createRadialGradient(x, y, R * 0.3, x, y, R * 1.85);
  glow.addColorStop(0, color + "99");
  glow.addColorStop(1, color + "00");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.85, 0, Math.PI * 2);
  ctx.fill();

  const body = ctx.createRadialGradient(x, y, 1, x, y, R);
  body.addColorStop(0, "rgba(255,255,255,0.95)");
  body.addColorStop(0.32, "rgba(255,255,255,0.55)");
  body.addColorStop(0.62, color);
  body.addColorStop(1, color);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.clip();
  obShape(ctx, shape, x, y, R * 0.5);
  // orbiting highlight = spinning
  const a = t * 2 + seed;
  const hx = x + Math.cos(a) * R * 0.34;
  const hy = y + Math.sin(a) * R * 0.34;
  const hl = ctx.createRadialGradient(hx, hy, 1, hx, hy, R * 0.7);
  hl.addColorStop(0, "rgba(255,255,255,0.85)");
  hl.addColorStop(0.5, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.fillRect(x - R, y - R, R * 2, R * 2);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.lineWidth = 1.5 * g.dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.stroke();
}

function drawObstacles(ctx: Ctx, g: Geo, obstacles: Obstacle[], t: number) {
  const spread = g.bandHalf - g.size * 0.5;
  const rad = g.size * 0.62;
  for (const ob of obstacles) {
    const def = OB[ob.type];
    const p = pathPoint(g, ob.u);
    const x = p.x + p.nx * ob.laneN * spread;
    const y = p.y + p.ny * ob.laneN * spread;
    drawOrb(ctx, g, x, y, rad, def.color, def.shape, t);
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
  for (const r of active) {
    const p = pathPoint(g, uOf(r));
    const off = r.laneN * spread;
    const x = p.x + p.nx * off;
    const y = p.y + p.ny * off;
    drawBall(ctx, sprites[r.ci], x, y, g.size * r.scale, r.dist * 0.13);
  }
}

// Live top-3 in the middle: rank (gold/silver/bronze) + flag. Nothing else.
function drawTop3(ctx: Ctx, g: Geo, top: number[], sprites: Sprites) {
  const cx = g.hole.x + g.hole.w / 2;
  const cy = g.hole.y + g.hole.h / 2;
  const rowH = Math.min(g.hole.h * 0.09, g.size * 1.5);
  const flag = rowH * 0.92;
  const numW = rowH * 0.7;
  const gap = rowH * 0.24;
  const rowW = numW + gap + flag;
  const startY = cy - rowH * 1.3;
  const medals = ["#ffd24a", "#cfd6e0", "#e0a06a"];

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = `700 ${Math.round(rowH * 0.5)}px ${FONT}`;
  ctx.fillText("TOP 3", cx, startY - rowH * 0.55);

  for (let k = 0; k < top.length && k < 3; k++) {
    const y = startY + k * rowH;
    const x = cx - rowW / 2;
    ctx.textAlign = "right";
    ctx.fillStyle = medals[k];
    ctx.font = `800 ${Math.round(rowH * 0.62)}px ${FONT}`;
    ctx.fillText(`${k + 1}`, x + numW * 0.85, y + flag * 0.72);
    drawBall(ctx, sprites[top[k]], x + numW + gap + flag / 2, y + flag / 2, flag, 0);
  }
}

function drawCountdown(ctx: Ctx, g: Geo, countdown: number, goFlash: number) {
  const cx = g.hole.x + g.hole.w / 2;
  const cy = g.hole.y + g.hole.h / 2;
  const big = Math.min(g.hole.w, g.hole.h) * 0.5;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (countdown > 0) {
    ctx.globalAlpha = 0.5 + 0.5 * (countdown - Math.floor(countdown));
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

// A spinning glossy 3D marble for the podium: the flag rotates, a fixed
// highlight + rim shading make it a sphere.
function PodiumMarble({ code, name, px }: { code: string; name: string; px: number }) {
  return (
    <div
      className="relative rounded-full"
      style={{
        width: px,
        height: px,
        boxShadow: "inset -6px -9px 20px rgba(0,0,0,0.55), 0 10px 26px rgba(0,0,0,0.55)",
      }}
    >
      <div className="spin3d absolute inset-0 overflow-hidden rounded-full">
        <Image src={`/flags/${code}.png`} alt={name} fill sizes={`${px}px`} className="object-cover" priority />
      </div>
      <span
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 34% 30%, rgba(255,255,255,0.78), rgba(255,255,255,0.12) 24%, transparent 46%)",
        }}
      />
    </div>
  );
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    theme: Theme;
    active: Racer[];
    finishers: number[];
    obstacles: Obstacle[];
    countdown: number;
    goFlash: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
  }>({ sprites: [], theme: THEMES[0], active: [], finishers: [], obstacles: [], countdown: 3, goFlash: 0, elapsed: 0, raf: 0, last: 0, ended: false });

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

  const startRace = useCallback(() => {
    const s = state.current;
    s.theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    // pick 10 distinct random countries
    const pool = COUNTRIES.map((_, i) => i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = pool.slice(0, RACERS);
    s.active = chosen.map((ci, k) => {
      const lane = k % 5;
      const row = Math.floor(k / 5);
      return {
        i: ci,
        ci,
        dist: 0,
        speed: 0,
        form: 0.9 + Math.random() * 0.3,
        place: 0,
        laneN: (lane - 2) / 2 + (Math.random() * 0.16 - 0.08),
        startU: -0.02 * (row + 1),
        uAdj: 0,
        scale: 1,
        effMul: 1,
        effTime: 0,
        obCool: 0,
      };
    });
    s.finishers = [];
    // 10 obstacles: one of each type, then random, at random spots
    s.obstacles = Array.from({ length: OBSTACLES }, (_, k) => ({
      u: (k + 0.5) / OBSTACLES + (Math.random() - 0.5) * 0.06,
      laneN: (Math.random() * 2 - 1) * 0.72,
      type: k < OB_TYPES.length ? OB_TYPES[k] : OB_TYPES[Math.floor(Math.random() * OB_TYPES.length)],
    }));
    s.countdown = 3;
    s.goFlash = 0;
    s.elapsed = 0;
    s.ended = false;
    s.last = 0;
    setPodium([]);
    setPhase("racing");
  }, []);

  useEffect(() => {
    if (phase !== "racing") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const s = state.current;
    if (s.active.length === 0) startRace();

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
            if (r.place > 0) continue;
            r.effTime = Math.max(0, r.effTime - dt);
            r.obCool = Math.max(0, r.obCool - dt);
            const u0 = uOf(r);
            const slow = (r.effTime > 0 ? r.effMul : 1) / r.scale; // small=fast, big=slow
            stepRacer(r, dt, st.elapsed, undefined, slow);
            const u1 = uOf(r);
            // obstacles change speed/size, never remove
            if (r.obCool <= 0) {
              for (const ob of st.obstacles) {
                const near = Math.abs(r.laneN - ob.laneN) * spread < g.size * 0.85;
                if (near && crossed(u0, u1, ob.u)) {
                  const def = OB[ob.type];
                  if (def.mul) {
                    r.effMul = def.mul;
                    r.effTime = def.time ?? 1;
                  }
                  if (def.scale) r.scale = Math.max(0.62, Math.min(1.5, r.scale * def.scale));
                  r.obCool = 0.35;
                  break;
                }
              }
            }
            if (r.dist >= FINISH) {
              r.place = st.finishers.length + 1;
              st.finishers.push(r.ci);
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

      separate(st.active, g);
      drawScenery(ctx, g);
      drawTrack(ctx, g);
      drawObstacles(ctx, g, st.obstacles, now / 1000);
      drawFinish(ctx, g);
      drawMarbles(ctx, g, st.active, st.sprites);
      if (st.countdown > 0 || st.goFlash > 0) {
        drawCountdown(ctx, g, st.countdown, st.goFlash);
      } else {
        const racing = st.active.filter((r) => r.place === 0);
        const top = [
          ...st.finishers,
          ...racing.sort((a, b) => b.dist - a.dist).map((r) => r.ci),
        ].slice(0, 3);
        drawTop3(ctx, g, top, st.sprites);
      }

      st.raf = requestAnimationFrame(draw);
    };
    s.raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(s.raf);
      window.removeEventListener("resize", resize);
    };
  }, [phase, startRace]);

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Live race of ten country flag marbles around a track with obstacles"
        className="block h-full w-full"
      />
      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <p className="text-lg font-semibold">Loading racers…</p>
        </div>
      )}

      {phase === "done" && podium.length === NEED && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
          <h1 className="pop mb-8 text-3xl font-bold sm:text-5xl">Podium</h1>
          <div className="pop flex items-end gap-5 sm:gap-10">
            {[1, 0, 2].map((k) => {
              const w = podium[k];
              const medal = ["🥇", "🥈", "🥉"][w.place - 1];
              const px = w.place === 1 ? 138 : 100;
              const lift = w.place === 1 ? "mb-6" : "";
              return (
                <div key={w.country.code} className={`flex flex-col items-center ${lift}`}>
                  <div className="mb-2 text-4xl sm:text-5xl">{medal}</div>
                  <PodiumMarble code={w.country.code} name={w.country.name} px={px} />
                  <p className="mt-3 text-base font-bold sm:text-xl">{w.country.name}</p>
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
