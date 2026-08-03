"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { COUNTRIES, type Country } from "../data/countries";
import { TRACK_LEN, stepRacer, standings } from "@/lib/race";
import { buildGeo, pathPoint, uOf, crossed, separate, type Geo, type Stage, type Ctx } from "@/lib/geometry";
import { STAGES, STAGE_ICON } from "../data/stages";
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
const BOMB_EVERY = 10; // one bomb coin pops in this often (rare + deadly)
const FIRE_EVERY = 10; // one fire-speed coin pops in this often (rare + winning)
const MYSTERY_EVERY = 8; // a fresh line of 3 ? boxes across the track this often
const MYSTERY_LANES = [-0.55, 0, 0.55]; // the 3 lanes the ? boxes line up across
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
  out: boolean; // blown up by a bomb - removed from the race
  fx: ObType | null; // effect currently on this marble (shown as a floating icon)
  fxTime: number; // seconds left to show that icon
};
type Winner = { country: Country; place: number };
// A one-off explosion drawn where a marble hit a bomb (position from u/laneN).
type Blast = { u: number; laneN: number; life: number; max: number };

// Obstacle types + their effect. Fires are gone - nothing removes a marble.
// `good` = green flash (helps you); otherwise a red flash (hurts you).
type ObType = "boost" | "mud" | "tar" | "banana" | "shrink" | "grow" | "mystery" | "bomb" | "fire";
type ObShape = "bolt" | "droplet" | "skull" | "banana" | "up" | "down" | "mystery";
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

// A line of 3 mystery ? boxes across the track at one spot, so marbles in every
// lane can grab one as the pack sweeps through. They linger, and aren't consumed
// on hit, so more than one racer can open the same row.
function spawnMysteryRow(): Obstacle[] {
  const u = Math.random();
  const maxLife = 6;
  return MYSTERY_LANES.map((laneN) => ({ u, laneN, type: "mystery" as ObType, lit: 0, life: maxLife, maxLife }));
}

// A rare coin (bomb or fire) that lies on the floor and lingers a good while so
// a marble has time to roll onto it. Spawned by its own 10s timer, not the pool.
function spawnCoin(type: ObType): Obstacle {
  const maxLife = 8 + Math.random() * 3; // sits for 8 - 11s
  return {
    u: Math.random(),
    laneN: (Math.random() * 2 - 1) * 0.7,
    type,
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
  mystery: { shape: "mystery", good: true }, // ? box - rolls a random effect
  bomb: { shape: "mystery", good: false }, // coin - explode + eliminate
  fire: { shape: "mystery", good: true }, // coin - big sustained boost
};
// The auto-popping pool (2 pop in each second). The ? mystery boxes, bomb + fire
// coins have their own timers instead of riding this random pool.
const OB_TYPES: ObType[] = ["boost", "mud", "tar", "banana", "shrink", "grow"];
// What a mystery box can turn into when a marble opens it.
const MYSTERY_POOL: ObType[] = ["boost", "mud", "tar", "banana", "shrink", "grow"];


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

// A Mario-Kart mystery box: a real gold cube that floats and spins about its
// vertical axis, seen slightly from above, with a bold "?" on the front face.
// `phase` (from ob.u) keeps neighbouring boxes out of sync.
function drawMysteryBox(ctx: Ctx, x: number, y: number, s: number, t: number, phase: number, lit: number) {
  const bob = Math.sin(t * 2.4 + phase * 6.283) * s * 0.3; // float up/down
  const a = t * 1.9 + phase * 6.283; // spin angle about the vertical axis
  const d = s * 0.62; // half side length
  const tilt = 0.32; // view the cube a little from above (top face shows)
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  ctx.save();
  ctx.translate(x, y + bob);
  // soft glow behind the box
  const gc = lit > 0 ? "255,245,170" : "255,205,80";
  const glow = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 2);
  glow.addColorStop(0, `rgba(${gc},0.5)`);
  glow.addColorStop(1, `rgba(${gc},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, s * 2, 0, Math.PI * 2);
  ctx.fill();
  // 4 top-view corners, rotated about the vertical axis -> screen x + depth z
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([cx, cz]) => ({ sx: (cx * ca - cz * sa) * d, z: (cx * sa + cz * ca) * d }));
  const yAt = (z: number, vy: number) => vy - z * tilt; // fake perspective for depth
  // the 4 vertical side faces; a face is visible when its middle faces the viewer
  const faces = [0, 1, 2, 3].map((i) => {
    const c0 = corners[i];
    const c1 = corners[(i + 1) % 4];
    return { c0, c1, midZ: (c0.z + c1.z) / 2 };
  });
  faces.sort((f, g) => f.midZ - g.midZ); // far -> near
  const front = faces[faces.length - 1];
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.strokeStyle = "#8a5210";
  ctx.lineJoin = "round";
  for (const f of faces) {
    if (f.midZ <= 0.001) continue; // back-facing, hidden
    const k = Math.max(0, Math.min(1, f.midZ / d)); // 1 = head-on, 0 = edge-on
    ctx.beginPath();
    ctx.moveTo(f.c0.sx, yAt(f.c0.z, -d));
    ctx.lineTo(f.c1.sx, yAt(f.c1.z, -d));
    ctx.lineTo(f.c1.sx, yAt(f.c1.z, d));
    ctx.lineTo(f.c0.sx, yAt(f.c0.z, d));
    ctx.closePath();
    const gg = ctx.createLinearGradient(0, -d, 0, d);
    gg.addColorStop(0, `rgb(${Math.round(190 + 60 * k)},${Math.round(140 + 80 * k)},${Math.round(60 + 40 * k)})`);
    gg.addColorStop(1, `rgb(${Math.round(150 + 80 * k)},${Math.round(95 + 90 * k)},${Math.round(20 + 55 * k)})`);
    ctx.fillStyle = gg;
    ctx.fill();
    ctx.stroke();
  }
  // top face (always visible from above) - lightest
  ctx.beginPath();
  ctx.moveTo(corners[0].sx, yAt(corners[0].z, -d));
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].sx, yAt(corners[i].z, -d));
  ctx.closePath();
  ctx.fillStyle = "#fff0b0";
  ctx.fill();
  ctx.stroke();
  // "?" painted on the front face - squashed to the face's turned-away width
  const fw = front.c1.sx - front.c0.sx;
  const scaleX = Math.max(0.06, Math.abs(fw) / (2 * d));
  ctx.save();
  ctx.translate((front.c0.sx + front.c1.sx) / 2, yAt(front.midZ, 0));
  ctx.scale(scaleX, 1);
  ctx.fillStyle = "#7a3d05";
  ctx.font = `900 ${s * 0.95}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
  ctx.restore();
}

// Emblem painted on the spinning coin face.
function drawFlame(ctx: Ctx, s: number) {
  ctx.fillStyle = "#fff1c2";
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.62);
  ctx.bezierCurveTo(s * 0.5, -s * 0.1, s * 0.28, s * 0.55, 0, s * 0.55);
  ctx.bezierCurveTo(-s * 0.28, s * 0.55, -s * 0.5, -s * 0.1, 0, -s * 0.62);
  ctx.fill();
  ctx.fillStyle = "#ff7a1e";
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.28);
  ctx.bezierCurveTo(s * 0.24, s * 0.04, s * 0.14, s * 0.45, 0, s * 0.45);
  ctx.bezierCurveTo(-s * 0.14, s * 0.45, -s * 0.24, s * 0.04, 0, -s * 0.28);
  ctx.fill();
}
function drawBombIcon(ctx: Ctx, s: number) {
  ctx.fillStyle = "#12060a";
  ctx.beginPath();
  ctx.arc(0, s * 0.12, s * 0.52, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffd08a";
  ctx.lineWidth = Math.max(1.2, s * 0.1);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s * 0.2, -s * 0.34);
  ctx.quadraticCurveTo(s * 0.52, -s * 0.5, s * 0.42, -s * 0.72);
  ctx.stroke();
  ctx.fillStyle = "#fff2b0";
  ctx.beginPath();
  ctx.arc(s * 0.42, -s * 0.76, s * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

// A flat coin lying on the floor: floats a touch and spins edge-on. `fire` = the
// hot orange speed coin; otherwise the dark red bomb coin.
function drawCoin(ctx: Ctx, x: number, y: number, s: number, t: number, phase: number, lit: number, fire: boolean) {
  const bob = Math.sin(t * 2.0 + phase * 6.283) * s * 0.18;
  const face = 0.18 + 0.82 * Math.abs(Math.cos(t * 3.4 + phase * 6.283)); // spin (never fully edge-on)
  const rw = Math.max(1, s * face);
  ctx.save();
  ctx.translate(x, y + bob);
  const gc = fire ? "255,150,40" : "255,70,60";
  const glow = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 2.2);
  glow.addColorStop(0, `rgba(${gc},${lit > 0 ? 0.7 : 0.42})`);
  glow.addColorStop(1, `rgba(${gc},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, s * 2.2, 0, Math.PI * 2);
  ctx.fill();
  const fill = ctx.createLinearGradient(0, -s, 0, s);
  fill.addColorStop(0, fire ? "#ff9d3a" : "#b0242a");
  fill.addColorStop(1, fire ? "#c85a0e" : "#5c0d12");
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(0, 0, rw, s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, s * 0.14);
  ctx.strokeStyle = fire ? "#ffd08a" : "#ff7b74";
  ctx.stroke();
  ctx.scale(face, 1); // squash the emblem with the spin
  if (fire) drawFlame(ctx, s);
  else drawBombIcon(ctx, s);
  ctx.restore();
}

// Expanding fireball where a bomb went off. `prog` runs 0 -> 1 over its life.
function drawBlast(ctx: Ctx, x: number, y: number, prog: number, base: number) {
  const a = 1 - prog;
  const rad = base * (0.4 + 1.9 * prog);
  ctx.save();
  const core = ctx.createRadialGradient(x, y, rad * 0.15, x, y, rad);
  core.addColorStop(0, `rgba(255,240,180,${0.85 * a})`);
  core.addColorStop(0.5, `rgba(255,140,40,${0.6 * a})`);
  core.addColorStop(1, "rgba(255,60,30,0)");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(255,200,120,${a})`;
  ctx.lineWidth = base * 0.12 * a + 1;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = `rgba(255,170,60,${a})`;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + prog * 2;
    const rr = rad * (0.75 + 0.5 * (((i * 7) % 5) / 5));
    ctx.beginPath();
    ctx.arc(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr, base * 0.16 * a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawObstacles(ctx: Ctx, g: Geo, obstacles: Obstacle[], t: number) {
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
    // The ? box and the bomb/fire coins render themselves (floating + spinning).
    if (ob.type === "mystery") {
      drawMysteryBox(ctx, x, y, rad * 1.25, t, ob.u, ob.lit);
      ctx.restore();
      continue;
    }
    if (ob.type === "bomb" || ob.type === "fire") {
      drawCoin(ctx, x, y, rad * 1.2, t, ob.u, ob.lit, ob.type === "fire");
      ctx.restore();
      continue;
    }
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

// A small badge floating just above a marble's head showing the effect it just
// picked up (bolt, mud, skull, banana, +, -, or flame) - green ring = good for
// it, red = bad. Fades out over its last second.
function drawEffectBadges(ctx: Ctx, g: Geo, active: Racer[]) {
  const spr = g.bandHalf - g.size * 0.5;
  ctx.save();
  for (const r of active) {
    if (r.out || !r.fx || r.fxTime <= 0) continue;
    const p = pathPoint(g, uOf(r));
    const mx = p.x + p.nx * r.laneN * spr;
    const my = p.y + p.ny * r.laneN * spr;
    const mr = g.size * r.scale * 0.5;
    const br = g.size * 0.2; // badge radius
    const bx = mx - mr * 0.72; // upper-left of the head (rank badge sits up-centre)
    const by = my - mr - br * 0.5;
    ctx.globalAlpha = Math.min(1, r.fxTime); // fade out in the last second
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(15,17,22,0.82)";
    ctx.fill();
    ctx.lineWidth = 2 * g.dpr;
    ctx.strokeStyle = OB[r.fx].good ? "rgb(80,205,115)" : "rgb(232,80,70)";
    ctx.stroke();
    const isz = br * 0.6;
    if (r.fx === "fire") {
      ctx.save();
      ctx.translate(bx, by);
      drawFlame(ctx, isz);
      ctx.restore();
    } else {
      obShape(ctx, OB[r.fx].shape, bx, by, isz, "#ffffff");
    }
  }
  ctx.globalAlpha = 1;
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
  const liveRef = useRef<HTMLParagraphElement>(null); // sr-only lead-change announcer
  const lastLeadRef = useRef(-1);
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
    bombTimer: number; // counts up to BOMB_EVERY, then a bomb coin pops in
    fireTimer: number; // counts up to FIRE_EVERY, then a fire coin pops in
    mysteryTimer: number; // counts up to MYSTERY_EVERY, then a ? box row pops in
    blasts: Blast[]; // live explosions to draw
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
  }>({ sprites: [], stage: STAGES[0], active: [], finishers: [], obstacles: [], obTimer: 0, bombTimer: 0, fireTimer: 0, mysteryTimer: 0, blasts: [], laps: 3, finishDist: TRACK_LEN * 3, countdown: 3, goFlash: 0, lastCount: 4, elapsed: 0, raf: 0, last: 0, ended: false, podiumIn: -1, showLive: true });

  // Flags are baked lazily (only the 10 that race, in startRace), so a cold load
  // goes straight to the setup screen instead of baking all 194 sprites upfront.
  useEffect(() => {
    setPhase("setup");
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
    // Bake just these 10 flags into the sprite cache (indexed by country) for the
    // leaderboard thumbnails - lazily, never all 194 at once.
    for (const ci of chosen) {
      if (s.sprites[ci]) continue;
      const img = new window.Image();
      img.onload = () => {
        s.sprites[ci] = bakeMarble(img);
      };
      img.src = `/flags/${COUNTRIES[ci].code}.png`;
    }
    setCodes(chosen.map((ci) => ({ code: COUNTRIES[ci].code, hue: COUNTRIES[ci].hue })));
    renderRef.current = chosen.map(() => ({ x: 0, y: 0, r: 0, dx: 1, dy: 0, dist: 0, flash: 0, good: false, out: false }));
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
        out: false,
        fx: null,
        fxTime: 0,
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
    // Stagger the first pops: a fire coin arrives early (chance to break away),
    // the first bomb a bit later so eliminations don't start too soon.
    s.bombTimer = 2;
    s.fireTimer = 6;
    s.mysteryTimer = MYSTERY_EVERY - 3; // first row of ? boxes ~3s in
    s.blasts = [];
    s.countdown = 3;
    s.goFlash = 0;
    s.lastCount = 4;
    s.elapsed = 0;
    s.ended = false;
    s.podiumIn = -1;
    s.showLive = settings.current.showLive;
    lastLeadRef.current = -1;
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
          // Rare coins on their own timers - one bomb + one fire every ~10s.
          st.bombTimer += dt;
          if (st.bombTimer >= BOMB_EVERY) {
            st.bombTimer -= BOMB_EVERY;
            st.obstacles.push(spawnCoin("bomb"));
          }
          st.fireTimer += dt;
          if (st.fireTimer >= FIRE_EVERY) {
            st.fireTimer -= FIRE_EVERY;
            st.obstacles.push(spawnCoin("fire"));
          }
          st.mysteryTimer += dt;
          if (st.mysteryTimer >= MYSTERY_EVERY) {
            st.mysteryTimer -= MYSTERY_EVERY;
            st.obstacles.push(...spawnMysteryRow());
          }
          // Age explosions out.
          for (const b of st.blasts) b.life -= dt;
          st.blasts = st.blasts.filter((b) => b.life > 0);
          const spread = g.bandHalf - g.size * 0.5;
          for (const r of st.active) {
            r.flash = Math.max(0, r.flash - dt);
            r.fxTime = Math.max(0, r.fxTime - dt);
            if (r.place > 0 || r.out) continue; // finished or blown up = frozen
            r.effTime = Math.max(0, r.effTime - dt);
            r.obCool = Math.max(0, r.obCool - dt);
            const u0 = uOf(r);
            const slow = (r.effTime > 0 ? r.effMul : 1) / r.scale; // small=fast, big=slow
            stepRacer(r, dt, st.elapsed, undefined, slow);
            const u1 = uOf(r);
            // obstacles change speed/size; bombs eliminate; fire is a big boost
            if (r.obCool <= 0) {
              for (const ob of st.obstacles) {
                if (obGrow(ob) < 0.9) continue; // ignore while popping in / fading out
                const near = Math.abs(r.laneN - ob.laneN) * spread < g.size * 0.85;
                if (!(near && crossed(u0, u1, ob.u))) continue;
                if (ob.type === "bomb") {
                  // Only remove a marble if at least NEED can still finish.
                  const alive = st.active.filter((x) => x.place === 0 && !x.out).length;
                  if (alive > NEED - st.finishers.length) {
                    r.out = true;
                    r.speed = 0;
                    st.blasts.push({ u: ob.u, laneN: ob.laneN, life: 0.7, max: 0.7 });
                    sound.explode();
                  } else {
                    r.effMul = 0.4; // can't spare it - heavy slow instead of a kill
                    r.effTime = 1.6;
                    r.fx = "tar";
                    r.fxTime = 1.6;
                    sound.splat();
                  }
                  r.flashGood = false;
                } else if (ob.type === "fire") {
                  r.effMul = 2.4; // big, long boost - usually the winner
                  r.effTime = 3.5;
                  r.fx = "fire";
                  r.fxTime = 3.5;
                  sound.fire();
                  r.flashGood = true;
                } else {
                  // Mystery box opens into a random effect; spells fire directly.
                  const effType =
                    ob.type === "mystery"
                      ? MYSTERY_POOL[Math.floor(Math.random() * MYSTERY_POOL.length)]
                      : ob.type;
                  const def = OB[effType];
                  if (def.mul) {
                    r.effMul = def.mul;
                    r.effTime = def.time ?? 1;
                  }
                  if (def.scale) r.scale = Math.max(0.62, Math.min(1.5, r.scale * def.scale));
                  r.fx = effType; // show the effect's icon above the marble
                  r.fxTime = def.mul ? (def.time ?? 1) : 1.4;
                  if (ob.type === "mystery") sound.mystery();
                  else if (def.mul) {
                    if (effType === "boost") sound.boost();
                    else if (effType === "banana") sound.slip();
                    else sound.splat();
                  } else if (def.scale) sound.size();
                  r.flashGood = def.good;
                }
                // light the obstacle up + flash the marble edge (~1s). Coins are
                // consumed on contact so one marble can't chain-hit the pack.
                ob.lit = 1;
                if (ob.type === "bomb" || ob.type === "fire") ob.life = 0;
                r.flash = 1;
                r.obCool = 0.35;
                break;
              }
            }
          }
          // Rank anyone who crossed the line this frame by REAL distance (furthest
          // first), so a close/same-frame finish awards gold to the true leader -
          // not whoever happens to sit earlier in the marble array.
          const crossers = st.active
            .filter((r) => !r.out && r.place === 0 && r.dist >= st.finishDist)
            .sort((a, b) => b.dist - a.dist);
          for (const r of crossers) {
            r.place = st.finishers.length + 1;
            st.finishers.push(r.ci);
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

      separate(st.active.filter((r) => !r.out), g); // eliminated marbles don't block the pack
      drawScenery(ctx, g); // field base fills the whole canvas
      drawInfield(ctx, g); // stage decoration across the whole map
      drawTrack(ctx, g); // rounded road ring on top of the field
      drawObstacles(ctx, g, st.obstacles, st.elapsed);
      // Explosions on top of the road.
      for (const b of st.blasts) {
        const bp = pathPoint(g, b.u);
        const bs = g.bandHalf - g.size * 0.5;
        drawBlast(ctx, bp.x + bp.nx * b.laneN * bs, bp.y + bp.ny * b.laneN * bs, 1 - b.life / b.max, g.size);
      }
      drawFinish(ctx, g);
      // Current lap from the leader's distance.
      let lead = 0;
      for (const r of st.active) if (!r.out && r.dist > lead) lead = r.dist;
      const lap = Math.min(st.laps, Math.floor(lead / TRACK_LEN) + 1);

      // Top-left HUD: the live board (with the lap as its header) when enabled,
      // otherwise just the compact lap pill. Plus 1/2/3 badges over the leaders.
      if (st.countdown <= 0) {
        const order = standings(st.active).filter((i) => !st.active[i].out); // hide blown-up racers
        // Announce lead changes to screen readers (the canvas board is not read).
        const leadCi = st.active[order[0]]?.ci ?? -1;
        if (leadCi !== lastLeadRef.current && leadCi >= 0 && !st.ended) {
          lastLeadRef.current = leadCi;
          if (liveRef.current) liveRef.current.textContent = `${COUNTRIES[leadCi].name} takes the lead`;
        }
        drawRankBadges(ctx, g, order, st.active);
        drawEffectBadges(ctx, g, st.active); // effect icon above each hit marble
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
          out: r.out,
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
      <p ref={liveRef} className="sr-only" aria-live="polite" role="status" />

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
