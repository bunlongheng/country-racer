"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { COUNTRIES, type Country } from "../data/countries";
import { TRACK_LEN, stepRacer, standings } from "@/lib/race";
import { sound } from "@/lib/sound";
import SoundToggle from "./SoundToggle";
import type { MarbleRender } from "./RaceMarbles";

// True 3D WebGL marbles - client only.
const PodiumMarble3D = dynamic(() => import("./PodiumMarble3D"), { ssr: false });
const RaceMarbles = dynamic(() => import("./RaceMarbles"), { ssr: false });

const SPRITE = 96; // baked marble sprite resolution (px)
const RACERS = 10; // fixed field - ten marbles, no more
const NEED = 3; // finishers needed to end the race
const OB_SEED = 6; // obstacles present when the race starts
const OB_MAX = 18; // never more than this many alive at once
const OB_SPAWN_EVERY = 1; // seconds between spawn ticks
const OB_SPAWN_COUNT = 2; // obstacles that pop in each tick
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
type Obstacle = { u: number; laneN: number; type: ObType; lit: number; life: number; maxLife: number };

// A fresh obstacle at a random spot / lane / type, with a random lifetime so the
// field is never the same twice and marbles keep appearing and fading out.
function spawnObstacle(): Obstacle {
  const maxLife = 4 + Math.random() * 3.5; // lives 4 - 7.5s
  return {
    u: Math.random(),
    laneN: (Math.random() * 2 - 1) * 0.8,
    type: OB_TYPES[Math.floor(Math.random() * OB_TYPES.length)],
    lit: 0,
    life: maxLife,
    maxLife,
  };
}

// Pop-in / pop-out envelope (0..1) for size + opacity, driven by lifetime.
function obGrow(ob: Obstacle): number {
  const IN = 0.28; // grow-in time
  const OUT = 0.6; // fade-out time
  const age = ob.maxLife - ob.life;
  if (age < IN) return age / IN;
  if (ob.life < OUT) return Math.max(0, ob.life / OUT);
  return 1;
}
const OB: Record<ObType, { shape: ObShape; good: boolean; mul?: number; time?: number; scale?: number }> = {
  boost: { shape: "bolt", good: true, mul: 1.8, time: 1.2 }, // speed up
  mud: { shape: "droplet", good: false, mul: 0.55, time: 1.3 }, // slow
  tar: { shape: "skull", good: false, mul: 0.4, time: 1.6 }, // slowest
  banana: { shape: "banana", good: false, mul: 0.45, time: 1.1 }, // slip
  shrink: { shape: "down", good: true, scale: 0.78 }, // small -> faster
  grow: { shape: "up", good: false, scale: 1.28 }, // big -> slower
};
const OB_TYPES: ObType[] = ["boost", "mud", "tar", "banana", "shrink", "grow"];

// A stage = the whole look of the track: outer background, running surface,
// infield fill, line colours, and a painter that decorates the centre infield.
type Stage = {
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
  stage: Stage;
};

function buildGeo(W: number, H: number, dpr: number, stage: Stage): Geo {
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

// Anti-overlap in REAL screen space. Working in flat (along-track, lane) space
// fails on the tight oval bends, because equal lane spacing maps to much smaller
// real distances on the inside of a curve - so marbles that look separated in u
// still visibly stack. Here each pair is pushed apart by its true (x,y) distance,
// then the push is split back into along-track (uAdj) and lateral (laneN) parts
// via the local track frame, so it stays correct everywhere on the track.
type Frame = { x: number; y: number; tx: number; ty: number; nx: number; ny: number };
function separate(active: Racer[], g: Geo) {
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

type Ctx = CanvasRenderingContext2D;

function drawScenery(ctx: Ctx, g: Geo) {
  // The whole map IS the field: fill the entire canvas with the stage surface.
  ctx.fillStyle = g.stage.infield;
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
  // The field already fills the whole canvas; just lay the rounded road ring on
  // top of it, so the only curves on screen are the track's (no boxy infield).
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2;
  ctx.strokeStyle = g.stage.road;
  ctx.stroke();
  // crisp edge lines at the inner + outer road boundaries = clear separation
  const edge = (inset: number) => {
    ctx.beginPath();
    ctx.roundRect(
      g.cl.L + inset,
      g.cl.T + inset,
      g.cl.R - g.cl.L - inset * 2,
      g.cl.B - g.cl.T - inset * 2,
      Math.max(1, g.cl.r - inset),
    );
    ctx.lineWidth = 2 * g.dpr;
    ctx.strokeStyle = g.stage.edge;
    ctx.stroke();
  };
  edge(-g.bandHalf); // outer edge
  edge(g.bandHalf); // inner edge
  // dim dashed racing line down the middle of the road
  trackPath(ctx, g);
  ctx.lineWidth = 1.5 * g.dpr;
  ctx.setLineDash([9 * g.dpr, 13 * g.dpr]);
  ctx.strokeStyle = g.stage.line;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Paint the stage's themed art into the centre infield (clipped so it never
// spills onto the road) plus any corner props the decorator draws itself.
function drawInfield(ctx: Ctx, g: Geo) {
  g.stage.decor(ctx, g);
}

// --- Stage decorators -------------------------------------------------------
// Each paints the ENTIRE canvas as the field (edge to edge). Surface treatments
// (grass stripes, water, markings) span the whole map; small props sit in the
// open centre so they are not hidden under the track ring drawn on top.

// Horizontal mowing stripes across the whole map.
function mowStripes(ctx: Ctx, g: Geo, a: string, b: string, n: number) {
  const sh = g.H / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? a : b;
    ctx.fillRect(0, i * sh, g.W, sh + 1);
  }
}

function stageHorse(ctx: Ctx, g: Geo) {
  // darker grass tufts scattered across the whole field
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.10)";
  for (let i = 0; i < 200; i++) {
    const x = (((i * 97) % 100) / 100) * g.W;
    const y = (((i * 53) % 100) / 100) * g.H;
    ctx.fillRect(x, y, g.dpr * 3, g.dpr * 6);
  }
  ctx.restore();
}

function stageSoccer(ctx: Ctx, g: Geo) {
  mowStripes(ctx, g, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.05)", 10);
  const cx = g.W / 2, cy = g.H / 2;
  const m = Math.min(g.W, g.H) * 0.04;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 3 * g.dpr;
  ctx.strokeRect(m, m, g.W - m * 2, g.H - m * 2); // pitch boundary
  ctx.beginPath(); // halfway line
  ctx.moveTo(m, cy);
  ctx.lineTo(g.W - m, cy);
  ctx.stroke();
  ctx.beginPath(); // centre circle
  ctx.arc(cx, cy, Math.min(g.W, g.H) * 0.13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)"; // centre spot
  ctx.beginPath();
  ctx.arc(cx, cy, 4 * g.dpr, 0, Math.PI * 2);
  ctx.fill();
  const gw = g.W * 0.22, gh = Math.min(g.W, g.H) * 0.07; // goal (penalty) boxes
  ctx.strokeRect(cx - gw / 2, m, gw, gh);
  ctx.strokeRect(cx - gw / 2, g.H - m - gh, gw, gh);
  // Goal + net at each end: a mesh grid framed by posts, on the goal line.
  const nw = g.W * 0.11, nh = Math.min(g.W, g.H) * 0.05;
  const net = (ny: number) => {
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; // mesh
    ctx.lineWidth = 1 * g.dpr;
    ctx.beginPath();
    for (let k = 0; k <= 9; k++) {
      const x = cx - nw / 2 + (k / 9) * nw;
      ctx.moveTo(x, ny);
      ctx.lineTo(x, ny + nh);
    }
    for (let k = 0; k <= 4; k++) {
      const y = ny + (k / 4) * nh;
      ctx.moveTo(cx - nw / 2, y);
      ctx.lineTo(cx + nw / 2, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; // posts + crossbar
    ctx.lineWidth = 3 * g.dpr;
    ctx.strokeRect(cx - nw / 2, ny, nw, nh);
  };
  net(m); // top goal
  net(g.H - m - nh); // bottom goal
  ctx.restore();
}

function stageFootball(ctx: Ctx, g: Geo) {
  const m = Math.min(g.W, g.H) * 0.05;
  const ez = g.W * 0.09; // end zones
  ctx.save();
  ctx.fillStyle = "rgba(40,90,200,0.5)";
  ctx.fillRect(0, 0, ez, g.H);
  ctx.fillStyle = "rgba(200,50,50,0.5)";
  ctx.fillRect(g.W - ez, 0, ez, g.H);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2 * g.dpr;
  const lines = 10; // yard lines
  for (let i = 0; i <= lines; i++) {
    const x = ez + (i / lines) * (g.W - ez * 2);
    ctx.beginPath();
    ctx.moveTo(x, m);
    ctx.lineTo(x, g.H - m);
    ctx.stroke();
  }
  ctx.restore();
}

function stageStadium(ctx: Ctx, g: Geo) {
  mowStripes(ctx, g, "rgba(255,255,255,0.04)", "rgba(0,0,0,0.06)", 9);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3 * g.dpr;
  ctx.beginPath();
  ctx.arc(g.W / 2, g.H / 2, Math.min(g.W, g.H) * 0.13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // floodlight towers at the four corners with a warm glow
  const lamp = (x: number, y: number) => {
    const r = g.bandHalf * 0.55;
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 3);
    glow.addColorStop(0, "rgba(255,244,190,0.5)");
    glow.addColorStop(1, "rgba(255,244,190,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f6efc4";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  };
  const m = g.bandHalf * 0.7;
  lamp(m, m);
  lamp(g.W - m, m);
  lamp(m, g.H - m);
  lamp(g.W - m, g.H - m);
}

function stageAirport(ctx: Ctx, g: Geo) {
  const cx = g.W / 2;
  const rw = g.W * 0.2; // runway strip, full height
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(cx - rw / 2, 0, rw, g.H);
  ctx.fillStyle = "rgba(255,255,255,0.8)"; // threshold bars
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(cx + i * rw * 0.14, g.H * 0.05, rw * 0.05, g.H * 0.04);
    ctx.fillRect(cx + i * rw * 0.14, g.H * 0.91, rw * 0.05, g.H * 0.04);
  }
  ctx.strokeStyle = "rgba(255,235,120,0.9)"; // dashed centreline
  ctx.lineWidth = 3 * g.dpr;
  ctx.setLineDash([g.H * 0.05, g.H * 0.04]);
  ctx.beginPath();
  ctx.moveTo(cx, g.H * 0.12);
  ctx.lineTo(cx, g.H * 0.88);
  ctx.stroke();
  ctx.setLineDash([]);
  // plane silhouette parked in the centre
  const py = g.H / 2, s = Math.min(g.W, g.H) * 0.1;
  ctx.fillStyle = "rgba(230,236,245,0.9)";
  ctx.beginPath();
  ctx.ellipse(cx, py, s * 0.16, s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.9, py + s * 0.1);
  ctx.lineTo(cx + s * 0.9, py + s * 0.1);
  ctx.lineTo(cx + s * 0.12, py + s * 0.35);
  ctx.lineTo(cx - s * 0.12, py + s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.35, py - s * 0.8);
  ctx.lineTo(cx + s * 0.35, py - s * 0.8);
  ctx.lineTo(cx + s * 0.06, py - s * 0.5);
  ctx.lineTo(cx - s * 0.06, py - s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function stageRiver(ctx: Ctx, g: Geo) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; // wavy water across the whole map
  ctx.lineWidth = 2 * g.dpr;
  const rows = 16;
  for (let r = 1; r < rows; r++) {
    const y = (r / rows) * g.H;
    ctx.beginPath();
    for (let x = 0; x <= g.W; x += 10 * g.dpr) {
      const yy = y + Math.sin((x / g.W) * Math.PI * 8 + r) * g.H * 0.008;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  const bank = Math.min(g.W, g.H) * 0.05; // grassy banks along top + bottom
  ctx.fillStyle = "rgba(52,140,70,0.85)";
  ctx.fillRect(0, 0, g.W, bank);
  ctx.fillRect(0, g.H - bank, g.W, bank);
  // little sail boat in the centre
  const bx = g.W / 2, by = g.H / 2, s = Math.min(g.W, g.H) * 0.09;
  ctx.fillStyle = "#8a5a30";
  ctx.beginPath();
  ctx.moveTo(bx - s, by);
  ctx.lineTo(bx + s, by);
  ctx.lineTo(bx + s * 0.6, by + s * 0.4);
  ctx.lineTo(bx - s * 0.6, by + s * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#f4f4f4";
  ctx.beginPath();
  ctx.moveTo(bx, by - s * 1.3);
  ctx.lineTo(bx, by - s * 0.05);
  ctx.lineTo(bx + s * 0.75, by - s * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function stageBeach(ctx: Ctx, g: Geo) {
  ctx.save();
  const sea = g.H * 0.22; // ocean strip along the top of the whole map
  ctx.fillStyle = "rgba(30,140,175,0.9)";
  ctx.fillRect(0, 0, g.W, sea);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2 * g.dpr;
  for (let r = 1; r < 4; r++) {
    const y = (r / 4) * sea;
    ctx.beginPath();
    for (let x = 0; x <= g.W; x += 10 * g.dpr) {
      const yy = y + Math.sin((x / g.W) * Math.PI * 7 + r) * 3 * g.dpr;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,214,90,0.95)"; // sun
  ctx.beginPath();
  ctx.arc(g.W * 0.14, sea * 0.5, Math.min(g.W, g.H) * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // beach ball just right of centre
  const bx = g.W * 0.56, by = g.H * 0.52, br = Math.min(g.W, g.H) * 0.06;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8483f";
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.arc(bx, by, br, -Math.PI / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.arc(bx, by, br, Math.PI / 2, Math.PI);
  ctx.closePath();
  ctx.fill();
  // palm tree just left of centre
  const px = g.W * 0.44, py = g.H * 0.62, ph = Math.min(g.W, g.H) * 0.2;
  ctx.strokeStyle = "#8a5a30";
  ctx.lineWidth = 4 * g.dpr;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(px - ph * 0.2, py - ph * 0.6, px + ph * 0.05, py - ph);
  ctx.stroke();
  ctx.strokeStyle = "#2e9e52";
  ctx.lineWidth = 5 * g.dpr;
  ctx.lineCap = "round";
  for (let a = 0; a < 5; a++) {
    const ang = -Math.PI / 2 + (a - 2) * 0.6;
    ctx.beginPath();
    ctx.moveTo(px + ph * 0.05, py - ph);
    ctx.lineTo(px + ph * 0.05 + Math.cos(ang) * ph * 0.5, py - ph + Math.sin(ang) * ph * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function stageSnow(ctx: Ctx, g: Geo) {
  ctx.save();
  // faint ice sheen bands across the whole field
  const n = 7;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.06)" : "rgba(120,160,200,0.06)";
    ctx.fillRect(0, (i / n) * g.H, g.W, g.H / n + 1);
  }
  // scattered snowflakes
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1.5 * g.dpr;
  for (let i = 0; i < 60; i++) {
    const x = (((i * 89) % 100) / 100) * g.W;
    const y = (((i * 47) % 100) / 100) * g.H;
    const s = (2 + (i % 3)) * g.dpr;
    for (let a = 0; a < 3; a++) {
      const ang = (a * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * s, y - Math.sin(ang) * s);
      ctx.lineTo(x + Math.cos(ang) * s, y + Math.sin(ang) * s);
      ctx.stroke();
    }
  }
  // snowman in the centre
  const cx = g.W / 2, cy = g.H / 2, u = Math.min(g.W, g.H) * 0.05;
  ctx.fillStyle = "#ffffff";
  for (const [dy, rr] of [[1.5, 1], [0.2, 0.78], [-0.9, 0.56]] as const) {
    ctx.beginPath();
    ctx.arc(cx, cy + dy * u, rr * u, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#1a1a1a"; // eyes + hat
  ctx.beginPath();
  ctx.arc(cx - 0.2 * u, cy - u, 0.09 * u, 0, Math.PI * 2);
  ctx.arc(cx + 0.2 * u, cy - u, 0.09 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 0.6 * u, cy - 1.55 * u, 1.2 * u, 0.18 * u);
  ctx.fillRect(cx - 0.42 * u, cy - 2.2 * u, 0.84 * u, 0.7 * u);
  ctx.fillStyle = "#e8843f"; // carrot nose
  ctx.beginPath();
  ctx.moveTo(cx, cy - 0.95 * u);
  ctx.lineTo(cx + 0.55 * u, cy - 0.82 * u);
  ctx.lineTo(cx, cy - 0.72 * u);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Roads are a themed TERRAIN surface for each scene (a dirt track, a mown lane, a
// red athletics track, a sandy path, packed snow...) - never a flat black band -
// so the whole map reads as one cohesive theme and the marble runs on the terrain.
const STAGES: Stage[] = [
  { name: "Horse Race", bg: "#140d05", road: "#9a6a3a", infield: "#3f7a3a", line: "rgba(255,255,255,0.22)", edge: "rgba(255,255,255,0.45)", song: "horse", decor: stageHorse },
  { name: "Soccer Field", bg: "#0a1f0d", road: "#3aa14a", infield: "#2f8f3a", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "soccer", decor: stageSoccer },
  { name: "Football Field", bg: "#0a1f0d", road: "#369640", infield: "#2c7a34", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "football", decor: stageFootball },
  { name: "Stadium", bg: "#080a10", road: "#b5533f", infield: "#2f7d3a", line: "rgba(255,255,255,0.3)", edge: "rgba(255,255,255,0.55)", song: "stadium", decor: stageStadium },
  { name: "Airport", bg: "#0b0e13", road: "#565d68", infield: "#4a4f57", line: "rgba(255,235,120,0.55)", edge: "rgba(255,255,255,0.5)", song: "airport", decor: stageAirport },
  { name: "River Side", bg: "#07171c", road: "#cbb184", infield: "#1c6f8c", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "river", decor: stageRiver },
  { name: "Beach Vibe", bg: "#062330", road: "#d8b878", infield: "#e8cd94", line: "rgba(120,90,40,0.4)", edge: "rgba(255,255,255,0.6)", song: "beach", decor: stageBeach },
  { name: "Snow Park", bg: "#0a1622", road: "#eef5fb", infield: "#d7e6f0", line: "rgba(70,110,150,0.4)", edge: "rgba(120,160,200,0.55)", song: "snow", decor: stageSnow },
];
const STAGE_ICON = ["🐎", "⚽", "🏈", "🏟️", "✈️", "🛶", "🏖️", "⛄"];

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
  const base = g.size * 0.34; // small
  for (const ob of obstacles) {
    const def = OB[ob.type];
    const grow = obGrow(ob);
    const rad = base * (0.4 + 0.6 * grow); // pop-in / fade-out scale
    const p = pathPoint(g, ob.u);
    const x = p.x + p.nx * ob.laneN * spread;
    const y = p.y + p.ny * ob.laneN * spread;
    ctx.save();
    ctx.globalAlpha = grow;
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
    ctx.restore();
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

// Live "LAP x / N" pill in the top-left corner.
function drawLaps(ctx: Ctx, g: Geo, lap: number, total: number) {
  const pad = 10 * g.dpr;
  ctx.save();
  ctx.font = `800 ${14 * g.dpr}px ${FONT}`;
  const text = `LAP ${lap} / ${total}`;
  const w = ctx.measureText(text).width + pad * 2;
  const h = 26 * g.dpr;
  const x = 12 * g.dpr, y = 12 * g.dpr;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + pad, y + h / 2 + g.dpr);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

const MEDAL = ["#ffd54a", "#d8dee6", "#d08a4e"]; // gold, silver, bronze
const MEDAL_RING = ["#b8860b", "#8a929c", "#8a5a2e"];

// Small gold/silver/bronze position badge above the top-3 marbles' heads.
function drawRankBadges(ctx: Ctx, g: Geo, order: number[], active: Racer[]) {
  const spr = g.bandHalf - g.size * 0.5;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < Math.min(3, order.length); i++) {
    const r = active[order[i]];
    const p = pathPoint(g, uOf(r));
    const mx = p.x + p.nx * r.laneN * spr;
    const my = p.y + p.ny * r.laneN * spr;
    const mr = g.size * r.scale * 0.5;
    const br = g.size * 0.22;
    const by = my - mr - br * 1.1;
    ctx.beginPath();
    ctx.arc(mx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = MEDAL[i];
    ctx.fill();
    ctx.lineWidth = 1.5 * g.dpr;
    ctx.strokeStyle = MEDAL_RING[i];
    ctx.stroke();
    ctx.fillStyle = "#1a1205";
    ctx.font = `800 ${br * 1.15}px ${FONT}`;
    ctx.fillText(String(i + 1), mx, by + g.dpr);
  }
  ctx.restore();
}

// Live top-5 standings board, anchored TOP-LEFT (under the lap counter) so the
// centre of the track stays clear for the stage centrepiece.
function drawLeaderboard(ctx: Ctx, g: Geo, order: number[], active: Racer[], sprites: HTMLCanvasElement[], lap: number, total: number) {
  const n = Math.min(5, order.length);
  if (n === 0) return;
  const rowH = Math.min(g.W, g.H) * 0.04; // compact - tucks into the corner
  const headerH = rowH * 0.95;
  const pad = rowH * 0.32;
  ctx.font = `600 ${rowH * 0.42}px ${FONT}`;
  let nameW = 0;
  for (let i = 0; i < n; i++) nameW = Math.max(nameW, ctx.measureText(COUNTRIES[active[order[i]].ci].name).width);
  const pw = Math.min(g.W * 0.38, rowH * 1.7 + nameW + pad * 1.5);
  const ph = headerH + n * rowH + pad;
  const px = 10 * g.dpr;
  const py = 10 * g.dpr; // top-left corner (replaces the standalone lap pill)
  ctx.save();
  ctx.fillStyle = "rgba(10,12,16,0.5)";
  ctx.beginPath();
  ctx.roundRect(px, py, pw, ph, rowH * 0.3);
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.font = `800 ${headerH * 0.44}px ${FONT}`;
  ctx.fillText(`LAP ${lap} / ${total}`, px + pad, py + headerH * 0.58);
  for (let i = 0; i < n; i++) {
    const r = active[order[i]];
    const c = COUNTRIES[r.ci];
    const ry = py + headerH + i * rowH + rowH / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = i < 3 ? MEDAL[i] : "rgba(255,255,255,0.7)";
    ctx.font = `800 ${rowH * 0.42}px ${FONT}`;
    ctx.fillText(String(i + 1), px + pad + rowH * 0.35, ry);
    const fr = rowH * 0.32;
    const sprite = sprites[r.ci];
    if (sprite && sprite.width > 1) ctx.drawImage(sprite, px + pad + rowH * 0.75, ry - fr, fr * 2, fr * 2);
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${rowH * 0.4}px ${FONT}`;
    const nameX = px + pad + rowH * 1.6;
    const maxW = pw - (nameX - px) - pad;
    let name = c.name;
    if (ctx.measureText(name).width > maxW) {
      while (name.length > 3 && ctx.measureText(name + "…").width > maxW) name = name.slice(0, -1);
      name += "…";
    }
    ctx.fillText(name, nameX, ry);
  }
  ctx.textBaseline = "alphabetic";
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
        delay: (i % 10) * 0.13,
        hue: (i * 47) % 360,
        dur: 2.6 + (i % 5) * 0.28,
        size: 7 + (i % 4) * 3,
      })),
    [],
  );
  return (
    // Drops once over ~5s, then the whole burst fades out (no infinite loop).
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ animation: "confetti-out 5.4s forwards" }}
    >
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece absolute top-[-6%] block rounded-full"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size,
            background: `hsl(${p.hue}, 90%, 60%)`,
            animation: `confetti-fall ${p.dur}s ${p.delay}s cubic-bezier(0.3,0.1,0.3,1) forwards`,
          }}
        />
      ))}
    </div>
  );
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "setup" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const [codes, setCodes] = useState<{ code: string; hue: number }[]>([]);
  // Player settings chosen on the setup screen. A ref mirror lets startRace read
  // the latest values without being re-created on every change.
  const [round, setRound] = useState(3);
  const [stageIndex, setStageIndex] = useState(0);
  const [showLive, setShowLive] = useState(true); // live top-5 board
  const [autoPlay, setAutoPlay] = useState(false); // loop random races hands-free
  const [confirmReset, setConfirmReset] = useState(false);
  const settings = useRef({ round: 3, stage: 0, showLive: true, autoPlay: false });
  settings.current = { round, stage: stageIndex, showLive, autoPlay };
  const renderRef = useRef<MarbleRender[]>([]);
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    stage: Stage;
    active: Racer[];
    finishers: number[];
    obstacles: Obstacle[];
    obTimer: number;
    laps: number; // total laps this race (= chosen round count)
    finishDist: number; // TRACK_LEN * laps
    countdown: number;
    goFlash: number;
    lastCount: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
    podiumIn: number; // seconds left before the podium shows (-1 = race not decided yet)
    showLive: boolean; // draw the live top-5 board
  }>({ sprites: [], stage: STAGES[0], active: [], finishers: [], obstacles: [], obTimer: 0, laps: 3, finishDist: TRACK_LEN * 3, countdown: 3, goFlash: 0, lastCount: 4, elapsed: 0, raf: 0, last: 0, ended: false, podiumIn: -1, showLive: true });

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
      setPhase("setup");
    });
    return () => {
      alive = false;
    };
  }, []);

  const startRace = useCallback(() => {
    const s = state.current;
    // Auto-play picks a fresh random stage each race so the loop stays varied.
    const stageIdx = settings.current.autoPlay
      ? Math.floor(Math.random() * STAGES.length)
      : settings.current.stage;
    s.stage = STAGES[stageIdx] ?? STAGES[0];
    setStageIndex(stageIdx);
    s.laps = Math.max(1, settings.current.round); // rounds = laps to race
    s.finishDist = TRACK_LEN * s.laps;
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
    // Seed a handful at fully-random spots, with staggered lifetimes so they
    // don't all vanish together. More pop in every second during the race.
    s.obstacles = Array.from({ length: OB_SEED }, () => {
      const ob = spawnObstacle();
      ob.life = ob.maxLife * (0.4 + Math.random() * 0.6);
      return ob;
    });
    s.obTimer = 0;
    s.countdown = 3;
    s.goFlash = 0;
    s.lastCount = 4;
    s.elapsed = 0;
    s.ended = false;
    s.podiumIn = -1;
    s.showLive = settings.current.showLive;
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
      const g = buildGeo(canvas.width, canvas.height, dpr, st.stage);

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
            sound.music(st.stage.song); // theme kicks in once the race starts
          }
        } else {
          st.goFlash = Math.max(0, st.goFlash - dt);
          st.elapsed += dt;
          // Age obstacles out, then pop new ones in on the spawn tick.
          for (const ob of st.obstacles) {
            ob.lit = Math.max(0, ob.lit - dt);
            ob.life -= dt;
          }
          st.obstacles = st.obstacles.filter((ob) => ob.life > 0);
          st.obTimer += dt;
          while (st.obTimer >= OB_SPAWN_EVERY) {
            st.obTimer -= OB_SPAWN_EVERY;
            for (let n = 0; n < OB_SPAWN_COUNT && st.obstacles.length < OB_MAX; n++) {
              st.obstacles.push(spawnObstacle());
            }
          }
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
                if (obGrow(ob) < 0.9) continue; // ignore while popping in / fading out
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
            if (r.dist >= st.finishDist) {
              r.place = st.finishers.length + 1;
              st.finishers.push(r.ci);
            }
          }
          if (st.finishers.length >= NEED && st.podiumIn < 0) {
            // Race is decided - keep the scene rolling for a moment before the podium.
            st.podiumIn = 3;
            const top = st.finishers.slice(0, NEED).map((ci, idx) => ({ country: COUNTRIES[ci], place: idx + 1 }));
            setPodium(top);
            setAnnounce(
              `Race finished. Gold ${top[0].country.name}, silver ${top[1].country.name}, bronze ${top[2].country.name}.`,
            );
          }
          if (st.podiumIn >= 0) {
            st.podiumIn -= dt;
            if (st.podiumIn <= 0) {
              st.ended = true;
              sound.stopMusic(); // swap the stage loop for a celebration theme
              sound.celebrate();
              setPhase("done"); // reveal the Winners screen after the 3s wait
            }
          }
        }
      }

      separate(st.active, g);
      drawScenery(ctx, g); // field base fills the whole canvas
      drawInfield(ctx, g); // stage decoration across the whole map
      drawTrack(ctx, g); // rounded road ring on top of the field
      drawObstacles(ctx, g, st.obstacles);
      drawFinish(ctx, g);
      // Current lap from the leader's distance.
      let lead = 0;
      for (const r of st.active) if (r.dist > lead) lead = r.dist;
      const lap = Math.min(st.laps, Math.floor(lead / TRACK_LEN) + 1);

      // Top-left HUD: the live board (with the lap as its header) when enabled,
      // otherwise just the compact lap pill. Plus 1/2/3 badges over the leaders.
      if (st.countdown <= 0) {
        const order = standings(st.active);
        drawRankBadges(ctx, g, order, st.active);
        if (st.showLive) drawLeaderboard(ctx, g, order, st.active, st.sprites, lap, st.laps);
        else drawLaps(ctx, g, lap, st.laps);
      } else {
        drawLaps(ctx, g, lap, st.laps);
      }

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

  // Silence the themed loop on the setup screen (it restarts when a race begins).
  useEffect(() => {
    if (phase === "setup" || phase === "loading") sound.stopMusic();
  }, [phase]);

  // Auto-play: once the podium shows, roll straight into the next (random) race
  // after a short beat - so it loops hands-free if you walk away.
  useEffect(() => {
    if (phase !== "done" || !settings.current.autoPlay) return;
    const id = setTimeout(() => startRace(), 4500);
    return () => clearTimeout(id);
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

      {phase === "racing" && (
        <button
          onClick={() => setConfirmReset(true)}
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm transition hover:bg-black/65 active:scale-90"
          aria-label="Reset race"
          title="Reset race"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      )}

      {confirmReset && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-[#15181f] p-7 text-center ring-1 ring-white/10">
            <h2 className="text-2xl font-bold text-white">Reset the race?</h2>
            <p className="mt-2 text-white/60">This ends the current race and returns to setup.</p>
            <div className="mt-6 flex justify-center gap-3">
              <button
                onClick={() => {
                  setConfirmReset(false);
                  setPhase("setup");
                }}
                className="rounded-full bg-white px-8 py-3 text-lg font-bold text-black transition hover:scale-105 active:scale-95"
              >
                Reset
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                className="rounded-full border-2 border-white/30 px-8 py-3 text-lg font-bold text-white transition hover:bg-white/10 active:scale-95"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70">
          <p className="text-lg font-semibold">Loading racers…</p>
        </div>
      )}

      {phase === "setup" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-7 overflow-y-auto bg-black/85 px-6 py-8 backdrop-blur-sm">
          <h1 className="text-4xl font-extrabold text-white sm:text-5xl">Country Racer</h1>

          <div className="flex items-center gap-4">
            <span className="text-lg font-semibold text-white/70">Round</span>
            <button
              onClick={() => setRound((r) => Math.max(1, r - 1))}
              className="h-11 w-11 rounded-full bg-white/15 text-2xl font-bold text-white transition hover:bg-white/25 active:scale-90"
              aria-label="Decrease round"
            >
              –
            </button>
            <span className="w-16 text-center text-3xl font-bold text-white tabular-nums">{round}</span>
            <button
              onClick={() => setRound((r) => r + 1)}
              className="h-11 w-11 rounded-full bg-white/15 text-2xl font-bold text-white transition hover:bg-white/25 active:scale-90"
              aria-label="Increase round"
            >
              +
            </button>
          </div>

          <div className="w-full max-w-2xl">
            <p className="mb-3 text-center text-lg font-semibold text-white/70">Stage</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {STAGES.map((st, i) => {
                const on = i === stageIndex;
                return (
                  <button
                    key={st.name}
                    onClick={() => setStageIndex(i)}
                    className={`flex flex-col items-center gap-1.5 rounded-2xl border-2 px-3 py-4 text-center transition active:scale-95 ${
                      on ? "border-white bg-white/20 scale-105" : "border-white/15 bg-white/5 hover:bg-white/10"
                    }`}
                  >
                    <span className="text-3xl">{STAGE_ICON[i]}</span>
                    <span className="text-sm font-bold text-white">{st.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={() => setShowLive((v) => !v)}
              className="flex items-center gap-3 rounded-full bg-white/5 px-5 py-2.5 ring-1 ring-white/15 transition hover:bg-white/10"
              role="switch"
              aria-checked={showLive}
            >
              <span className="text-base font-semibold text-white/80">Show live results</span>
              <span className={`relative h-6 w-11 rounded-full transition ${showLive ? "bg-emerald-500" : "bg-white/25"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${showLive ? "left-[22px]" : "left-0.5"}`} />
              </span>
            </button>
            <button
              onClick={() => setAutoPlay((v) => !v)}
              className="flex items-center gap-3 rounded-full bg-white/5 px-5 py-2.5 ring-1 ring-white/15 transition hover:bg-white/10"
              role="switch"
              aria-checked={autoPlay}
            >
              <span className="text-base font-semibold text-white/80">Auto play (random)</span>
              <span className={`relative h-6 w-11 rounded-full transition ${autoPlay ? "bg-emerald-500" : "bg-white/25"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${autoPlay ? "left-[22px]" : "left-0.5"}`} />
              </span>
            </button>
          </div>

          <button
            onClick={startRace}
            className="rounded-full bg-white px-12 py-4 text-xl font-extrabold text-black transition hover:scale-105 active:scale-95"
          >
            Start Race
          </button>
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
                <div key={w.country.code} className={`relative flex flex-col items-center ${lift}`} style={{ width: px }}>
                  <div className="relative z-10 mb-1 text-5xl sm:text-6xl">{medal}</div>
                  <div style={{ width: px, height: px }} className="drop-shadow-[0_12px_30px_rgba(0,0,0,0.6)]">
                    <PodiumMarble3D code={w.country.code} hue={w.country.hue} />
                  </div>
                  {/* Absolute so a long name never widens the column and shifts the podium off-centre. */}
                  <p className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-lg font-bold sm:text-2xl">
                    {w.country.name}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="mt-24 flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={startRace}
              className="rounded-full bg-white px-10 py-3.5 text-lg font-bold text-black transition hover:scale-105 active:scale-95"
            >
              Race Again
            </button>
            <button
              onClick={() => setPhase("setup")}
              className="rounded-full border-2 border-white/40 px-8 py-3.5 text-lg font-bold text-white transition hover:bg-white/10 active:scale-95"
            >
              Change Stage
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
