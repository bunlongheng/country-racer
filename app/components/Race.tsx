"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { COUNTRIES, type Country } from "../data/countries";
import { FINISH, TRACK_LEN, stepRacer } from "@/lib/race";
import { sound } from "@/lib/sound";
import SoundToggle from "./SoundToggle";
import type { MarbleRender } from "./RaceMarbles";

// True 3D WebGL marbles - client only.
const PodiumMarble3D = dynamic(() => import("./PodiumMarble3D"), { ssr: false });
const RaceMarbles = dynamic(() => import("./RaceMarbles"), { ssr: false });

const SPRITE = 96; // baked marble sprite resolution (px)
const RACERS = 10; // fixed field - ten marbles, no more
const NEED = 3; // finishers needed to end the race
const OBSTACLES = 16; // obstacles scattered on the track
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
  flash: number; // hit-flash timer (edge glows red/green)
  flashGood: boolean; // green (good) or red (bad) flash
};
type Winner = { country: Country; place: number };

// Obstacle types + their effect. Fires are gone - nothing removes a marble.
// `good` = green flash (helps you); otherwise a red flash (hurts you).
type ObType = "boost" | "mud" | "tar" | "banana" | "shrink" | "grow";
type ObShape = "bolt" | "droplet" | "skull" | "banana" | "up" | "down";
type Obstacle = { u: number; laneN: number; type: ObType; lit: number };
const OB: Record<ObType, { shape: ObShape; good: boolean; mul?: number; time?: number; scale?: number }> = {
  boost: { shape: "bolt", good: true, mul: 1.8, time: 1.2 }, // speed up
  mud: { shape: "droplet", good: false, mul: 0.55, time: 1.3 }, // slow
  tar: { shape: "skull", good: false, mul: 0.4, time: 1.6 }, // slowest
  banana: { shape: "banana", good: false, mul: 0.45, time: 1.1 }, // slip
  shrink: { shape: "down", good: true, scale: 0.78 }, // small -> faster
  grow: { shape: "up", good: false, scale: 1.28 }, // big -> slower
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
  const band = m * 0.4; // big road
  const bandHalf = band / 2;
  const size = band * 0.2; // ten marbles -> clear
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

// Neutral, all-gray look so the colourful country marbles are the only pop.
const BG = "#0f1116";
const INFIELD = "#2c2f36"; // darker gray centre (distinct from the road, not black)
const ROAD = "#565a64"; // lighter gray racing surface

function drawScenery(ctx: Ctx, g: Geo) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, g.W, g.H);
}

function trackPath(ctx: Ctx, g: Geo) {
  ctx.beginPath();
  ctx.roundRect(g.cl.L, g.cl.T, g.cl.R - g.cl.L, g.cl.B - g.cl.T, g.cl.r);
}

function drawTrack(ctx: Ctx, g: Geo) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // infield fill: the whole track area including the centre, so there is no
  // black dead space in the middle - it reads as a gray racetrack infield.
  ctx.beginPath();
  ctx.roundRect(
    g.cl.L - g.bandHalf,
    g.cl.T - g.bandHalf,
    g.cl.R - g.cl.L + g.bandHalf * 2,
    g.cl.B - g.cl.T + g.bandHalf * 2,
    g.cl.r + g.bandHalf,
  );
  ctx.fillStyle = INFIELD;
  ctx.fill();
  // the lighter gray road band (the racing surface stands out from the infield)
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2;
  ctx.strokeStyle = ROAD;
  ctx.stroke();
  // crisp edge lines at the inner + outer road boundaries = clear separation
  const edge = (inset: number) => {
    ctx.beginPath();
    ctx.roundRect(
      g.cl.L + inset,
      g.cl.T + inset,
      g.cl.R - g.cl.L - inset * 2,
      g.cl.B - g.cl.T - inset * 2,
      Math.max(1, g.cl.r + inset),
    );
    ctx.lineWidth = 2 * g.dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.stroke();
  };
  edge(-g.bandHalf); // outer edge
  edge(g.bandHalf); // inner edge
  // very dim dashed racing line down the middle of the road
  trackPath(ctx, g);
  ctx.lineWidth = 1.5 * g.dpr;
  ctx.setLineDash([9 * g.dpr, 13 * g.dpr]);
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// A single small, dim, colourless sign per spell - no colour, no glow, no orb -
// so it never competes with the country marble colours.
function obShape(ctx: Ctx, shape: ObShape, x: number, y: number, s: number, col: string) {
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  if (shape === "banana") {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.5);
    ctx.beginPath();
    ctx.arc(0, -s * 0.1, s * 0.9, Math.PI * 0.16, Math.PI * 0.88);
    ctx.lineWidth = s * 0.42;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (shape === "bolt") {
    ctx.beginPath();
    ctx.moveTo(x + s * 0.28, y - s * 0.78);
    ctx.lineTo(x - s * 0.42, y + s * 0.12);
    ctx.lineTo(x - s * 0.04, y + s * 0.12);
    ctx.lineTo(x - s * 0.24, y + s * 0.78);
    ctx.lineTo(x + s * 0.46, y - s * 0.12);
    ctx.lineTo(x + s * 0.08, y - s * 0.12);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (shape === "droplet") {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.8);
    ctx.bezierCurveTo(x + s * 0.78, y + s * 0.05, x + s * 0.5, y + s * 0.8, x, y + s * 0.8);
    ctx.bezierCurveTo(x - s * 0.5, y + s * 0.8, x - s * 0.78, y + s * 0.05, x, y - s * 0.8);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (shape === "skull") {
    ctx.beginPath();
    ctx.arc(x, y - s * 0.12, s * 0.6, Math.PI, 0);
    ctx.lineTo(x + s * 0.42, y + s * 0.28);
    ctx.lineTo(x + s * 0.2, y + s * 0.28);
    ctx.lineTo(x + s * 0.2, y + s * 0.48);
    ctx.lineTo(x - s * 0.2, y + s * 0.48);
    ctx.lineTo(x - s * 0.2, y + s * 0.28);
    ctx.lineTo(x - s * 0.42, y + s * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x - s * 0.22, y - s * 0.08, s * 0.15, 0, Math.PI * 2);
    ctx.arc(x + s * 0.22, y - s * 0.08, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  // grow = "+" (bigger), shrink = "-" (smaller).
  ctx.lineWidth = s * 0.3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - s * 0.62, y);
  ctx.lineTo(x + s * 0.62, y);
  ctx.stroke();
  if (shape === "up") {
    ctx.beginPath();
    ctx.moveTo(x, y - s * 0.62);
    ctx.lineTo(x, y + s * 0.62);
    ctx.stroke();
  }
}

function drawObstacles(ctx: Ctx, g: Geo, obstacles: Obstacle[]) {
  const spread = g.bandHalf - g.size * 0.5;
  const rad = g.size * 0.34; // small
  for (const ob of obstacles) {
    const def = OB[ob.type];
    const p = pathPoint(g, ob.u);
    const x = p.x + p.nx * ob.laneN * spread;
    const y = p.y + p.ny * ob.laneN * spread;
    // When a marble just rolled over it, the obstacle lights up (green if good,
    // red if bad) for ~1s. Otherwise it is a dim colourless sign.
    if (ob.lit > 0) {
      const c = def.good ? "80,220,120" : "235,80,70";
      const glow = ctx.createRadialGradient(x, y, rad * 0.2, x, y, rad * 2.3);
      glow.addColorStop(0, `rgba(${c},${0.5 * ob.lit})`);
      glow.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, rad * 2.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, rad * 1.35, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * g.dpr;
      ctx.strokeStyle = `rgba(${c},${ob.lit})`;
      ctx.stroke();
      obShape(ctx, def.shape, x, y, rad, `rgba(255,255,255,${0.5 + 0.5 * ob.lit})`);
    } else {
      obShape(ctx, def.shape, x, y, rad, "rgba(205,205,205,0.42)");
    }
  }
}

function drawFinish(ctx: Ctx, g: Geo) {
  const p = pathPoint(g, 0);
  ctx.save();
  ctx.lineWidth = 3 * g.dpr;
  ctx.setLineDash([7 * g.dpr, 7 * g.dpr]);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.moveTo(p.x - p.nx * g.bandHalf, p.y - p.ny * g.bandHalf);
  ctx.lineTo(p.x + p.nx * g.bandHalf, p.y + p.ny * g.bandHalf);
  ctx.stroke();
  ctx.restore();
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

// Falling confetti for the winners screen.
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: (i * 61) % 100,
        delay: (i % 16) * 0.16,
        hue: (i * 47) % 360,
        dur: 2 + (i % 6) * 0.4,
        size: 7 + (i % 4) * 3,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece absolute top-[-6%] block rounded-sm"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size,
            background: `hsl(${p.hue}, 90%, 60%)`,
            animation: `confetti-fall ${p.dur}s ${p.delay}s cubic-bezier(0.3,0.1,0.3,1) infinite`,
          }}
        />
      ))}
    </div>
  );
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const [codes, setCodes] = useState<{ code: string; hue: number }[]>([]);
  const renderRef = useRef<MarbleRender[]>([]);
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    theme: Theme;
    active: Racer[];
    finishers: number[];
    obstacles: Obstacle[];
    countdown: number;
    goFlash: number;
    lastCount: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
  }>({ sprites: [], theme: THEMES[0], active: [], finishers: [], obstacles: [], countdown: 3, goFlash: 0, lastCount: 4, elapsed: 0, raf: 0, last: 0, ended: false });

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
    setCodes(chosen.map((ci) => ({ code: COUNTRIES[ci].code, hue: COUNTRIES[ci].hue })));
    renderRef.current = chosen.map(() => ({ x: 0, y: 0, r: 0, dx: 1, dy: 0, dist: 0, flash: 0, good: false }));
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
        flash: 0,
        flashGood: false,
      };
    });
    s.finishers = [];
    // obstacles: one of each type, then random, at random spots
    s.obstacles = Array.from({ length: OBSTACLES }, (_, k) => ({
      u: (k + 0.5) / OBSTACLES + (Math.random() - 0.5) * 0.04,
      laneN: (Math.random() * 2 - 1) * 0.75,
      type: k < OB_TYPES.length ? OB_TYPES[k] : OB_TYPES[Math.floor(Math.random() * OB_TYPES.length)],
      lit: 0,
    }));
    s.countdown = 3;
    s.goFlash = 0;
    s.lastCount = 4;
    s.elapsed = 0;
    s.ended = false;
    s.last = 0;
    sound.bugle(); // "call to post"
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
          const ci = Math.ceil(st.countdown);
          if (ci < st.lastCount && ci >= 1) {
            st.lastCount = ci;
            sound.beep(); // 3 ... 2 ... 1
          }
          if (st.countdown <= 0) {
            st.goFlash = 0.8;
            sound.go(); // GO!
          }
        } else {
          st.goFlash = Math.max(0, st.goFlash - dt);
          st.elapsed += dt;
          for (const ob of st.obstacles) ob.lit = Math.max(0, ob.lit - dt);
          const spread = g.bandHalf - g.size * 0.5;
          for (const r of st.active) {
            r.flash = Math.max(0, r.flash - dt);
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
                    if (ob.type === "boost") sound.boost();
                    else if (ob.type === "banana") sound.slip();
                    else sound.splat();
                  }
                  if (def.scale) {
                    r.scale = Math.max(0.62, Math.min(1.5, r.scale * def.scale));
                    sound.size();
                  }
                  // light the obstacle up + flash the marble edge (~1s)
                  ob.lit = 1;
                  r.flash = 1;
                  r.flashGood = def.good;
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
            sound.win();
            setPhase("done");
          }
        }
      }

      separate(st.active, g);
      drawScenery(ctx, g);
      drawTrack(ctx, g);
      drawObstacles(ctx, g, st.obstacles);
      drawFinish(ctx, g);

      // Feed marble positions to the 3D overlay (CSS pixels + travel direction).
      const spr = g.bandHalf - g.size * 0.5;
      for (let i = 0; i < st.active.length; i++) {
        const r = st.active[i];
        const u = uOf(r);
        const p = pathPoint(g, u);
        const p2 = pathPoint(g, (u + 0.003) % 1);
        const x = p.x + p.nx * r.laneN * spr;
        const y = p.y + p.ny * r.laneN * spr;
        renderRef.current[i] = {
          x: x / dpr,
          y: y / dpr,
          r: (g.size * r.scale * 0.5) / dpr,
          dx: p2.x - p.x,
          dy: p2.y - p.y,
          dist: r.dist,
          flash: r.flash,
          good: r.flashGood,
        };
      }
      if (st.countdown > 0 || st.goFlash > 0) {
        drawCountdown(ctx, g, st.countdown, st.goFlash);
      }

      st.raf = requestAnimationFrame(draw);
    };
    s.raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(s.raf);
      window.removeEventListener("resize", resize);
    };
  }, [phase, startRace]);

  // Browsers block audio until the first interaction - unlock on any tap/key.
  useEffect(() => {
    const unlock = () => sound.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Live race of ten country flag marbles around a track with obstacles"
        className="block h-full w-full"
      />
      {codes.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          <RaceMarbles codes={codes} data={renderRef} />
        </div>
      )}

      <p className="sr-only" aria-live="polite" role="status">
        {announce}
      </p>

      <SoundToggle />

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <p className="text-lg font-semibold">Loading racers…</p>
        </div>
      )}

      {phase === "done" && podium.length === NEED && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center overflow-hidden bg-black/75 backdrop-blur-sm">
          <Confetti />
          <h1 className="pop mb-10 text-4xl font-bold sm:text-6xl">Winners</h1>
          <div className="pop flex items-end gap-2 sm:gap-8">
            {[1, 0, 2].map((k) => {
              const w = podium[k];
              const medal = ["🥇", "🥈", "🥉"][w.place - 1];
              const px = w.place === 1 ? 168 : 104;
              const lift = w.place === 1 ? "mb-8" : "";
              return (
                <div key={w.country.code} className={`flex flex-col items-center ${lift}`}>
                  <div className="mb-2 text-5xl sm:text-6xl">{medal}</div>
                  <div style={{ width: px, height: px }} className="drop-shadow-[0_12px_30px_rgba(0,0,0,0.6)]">
                    <PodiumMarble3D code={w.country.code} hue={w.country.hue} />
                  </div>
                  <p className="mt-3 text-lg font-bold sm:text-2xl">{w.country.name}</p>
                </div>
              );
            })}
          </div>
          <button
            onClick={startRace}
            className="mt-12 rounded-full bg-white px-10 py-3.5 text-lg font-bold text-black transition hover:scale-105 active:scale-95"
          >
            Race Again
          </button>
        </div>
      )}
    </main>
  );
}
