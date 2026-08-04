"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CATEGORIES, type RacerItem } from "../data/categories";
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
const BOMB_EVERY = 10; // one bomb mine drops onto the track this often (rare + deadly)
// Mystery ? boxes are fixed fixtures - 2 at the 3 o'clock spot and 2 at the 9
// o'clock spot, always on the track. Opening one hides it briefly, then it refills.
const MYSTERY_SPOTS = [0.25, 0.75]; // u of the right (3 o'clock) + left (9 o'clock) sides
const MYSTERY_LANES = [-0.6, -0.2, 0.2, 0.6]; // four lanes at each spot -> 8 boxes total
const MYSTERY_REFILL = 2.2; // seconds an opened box stays gone before it refills
const MYSTERY_MAXLIFE = 1e6; // effectively never ages out (unlike pooled obstacles)
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

type Racer = {
  i: number;
  it: number; // index into this race's 10-item list
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
type Winner = { item: RacerItem; place: number };
// A one-off explosion drawn where a marble hit a bomb (position from u/laneN).
type Blast = { u: number; laneN: number; life: number; max: number };

// Obstacle types + their effect. `good` = green flash (helps you); otherwise a
// red flash (hurts you). Bombs are floor mines that eliminate; fire is the big
// speed boost, now one of the mystery-box outcomes.
type ObType = "boost" | "mud" | "tar" | "banana" | "shrink" | "grow" | "mystery" | "bomb" | "fire";
type ObShape = "bolt" | "droplet" | "skull" | "banana" | "up" | "down" | "mystery";
// `respawn` > 0 means an opened mystery box is hidden, counting down to a refill.
type Obstacle = { u: number; laneN: number; type: ObType; lit: number; life: number; maxLife: number; respawn: number };

// The 8 fixed mystery ? boxes: 4 lanes at each of the 3 o'clock + 9 o'clock spots.
// They never age out - opening one hides it for MYSTERY_REFILL seconds, then it
// pops back, so 8 are always on the track for the pack to grab each lap.
function spawnMysteryFixtures(): Obstacle[] {
  const boxes: Obstacle[] = [];
  for (const u of MYSTERY_SPOTS) {
    for (const laneN of MYSTERY_LANES) {
      boxes.push({ u, laneN, type: "mystery", lit: 0, life: MYSTERY_MAXLIFE, maxLife: MYSTERY_MAXLIFE, respawn: 0 });
    }
  }
  return boxes;
}

// A bomb mine that lies flat on the floor and lingers a good while so a marble has
// time to roll onto it. Dropped by its own ~10s timer.
function spawnCoin(type: ObType): Obstacle {
  const maxLife = 8 + Math.random() * 3; // sits for 8 - 11s
  return {
    u: Math.random(),
    laneN: (Math.random() * 2 - 1) * 0.7,
    type,
    lit: 0,
    life: maxLife,
    maxLife,
    respawn: 0,
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
  bomb: { shape: "mystery", good: false }, // floor mine - explode + eliminate
  fire: { shape: "bolt", good: true, mul: 2.4, time: 3.0 }, // big boost (mystery outcome)
};
// What a mystery box can turn into when a marble opens it (fire = big speed boost).
const MYSTERY_POOL: ObType[] = ["boost", "mud", "tar", "banana", "shrink", "grow", "fire"];


// Shared circular clip + rim shading for a leaderboard thumbnail; `paint` fills
// the clipped disc however the racer's skin needs (flag image, emoji, or colour).
function bakeSprite(paint: (g: CanvasRenderingContext2D, r: number) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SPRITE;
  const g = c.getContext("2d")!;
  const r = SPRITE / 2;
  g.save();
  g.beginPath();
  g.arc(r, r, r - 2, 0, Math.PI * 2);
  g.clip();
  paint(g, r);
  const rim = g.createRadialGradient(r, r, r * 0.35, r, r, r);
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(0.72, "rgba(0,0,0,0.06)");
  rim.addColorStop(1, "rgba(0,0,0,0.6)");
  g.fillStyle = rim;
  g.fillRect(0, 0, SPRITE, SPRITE);
  g.restore();
  return c;
}

function bakeImg(img: HTMLImageElement): HTMLCanvasElement {
  return bakeSprite((g) => {
    const s = Math.max(SPRITE / img.width, SPRITE / img.height);
    const w = img.width * s;
    const h = img.height * s;
    g.drawImage(img, (SPRITE - w) / 2, (SPRITE - h) / 2, w, h);
  });
}

function bakeEmoji(emoji: string, hue: number): HTMLCanvasElement {
  return bakeSprite((g) => {
    g.fillStyle = `hsl(${hue}, 62%, 58%)`;
    g.fillRect(0, 0, SPRITE, SPRITE);
    g.font = `${SPRITE * 0.66}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", ${FONT}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(emoji, SPRITE / 2, SPRITE * 0.54);
  });
}

function bakeColor(color: string): HTMLCanvasElement {
  return bakeSprite((g, r) => {
    const grd = g.createRadialGradient(r * 0.7, r * 0.6, r * 0.15, r, r, r);
    grd.addColorStop(0, "rgba(255,255,255,0.55)");
    grd.addColorStop(0.25, color);
    grd.addColorStop(1, color);
    g.fillStyle = grd;
    g.fillRect(0, 0, SPRITE, SPRITE);
  });
}

// Bake the right kind of thumbnail for a racer item. Image skins load async and
// invoke `done` when ready; emoji/colour skins bake synchronously and return one.
function bakeItem(item: RacerItem, done: (c: HTMLCanvasElement) => void): HTMLCanvasElement | null {
  if (item.img) {
    const img = new window.Image();
    img.onload = () => done(bakeImg(img));
    img.src = item.img;
    return null;
  }
  if (item.emoji) return bakeEmoji(item.emoji, item.hue);
  return bakeColor(item.color ?? `hsl(${item.hue}, 80%, 55%)`);
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

// A Mario-Kart mystery box: a solid gold isometric cube that floats up and down,
// showing its top + two front faces so it always reads as a 3D cube, with a bold
// "?" on the front. `phase` (from ob.u) keeps neighbouring boxes out of sync.
function drawMysteryBox(ctx: Ctx, x: number, y: number, s: number, t: number, phase: number, lit: number) {
  const bob = Math.sin(t * 2.4 + phase * 6.283) * s * 0.28; // float up/down
  const w = s * 0.62; // half the diamond width
  const q = w * 0.5; // top-diamond half-height (2:1 isometric)
  const h = s * 0.9; // height of the vertical faces
  const topY = -h / 2; // y of the diamond's horizontal midline
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
  // cube corners: top diamond + the front seam / bottom outline
  const dTop = [0, topY - q];
  const dRight = [w, topY];
  const dBot = [0, topY + q];
  const dLeft = [-w, topY];
  const bBot = [0, topY + q + h];
  const bRight = [w, topY + h];
  const bLeft = [-w, topY + h];
  const lift = lit > 0 ? 32 : 0; // brighten while a marble is opening it
  const lin = (x0: number, y0: number, x1: number, y1: number, a: string, b: string) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
  };
  const face = (pts: number[][], fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.stroke();
  };
  ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.strokeStyle = "#8a5210";
  ctx.lineJoin = "round";
  const rgb = (r: number, g: number, b: number) =>
    `rgb(${Math.min(255, r + lift)},${Math.min(255, g + lift)},${Math.min(255, b + lift)})`;
  // right face (in shadow, darkest), left face (front, lit), top (brightest)
  face([dBot, dRight, bRight, bBot], lin(0, topY, 0, topY + q + h, rgb(214, 158, 46), rgb(176, 122, 26)));
  face([dLeft, dBot, bBot, bLeft], lin(0, topY, 0, topY + q + h, rgb(238, 190, 66), rgb(200, 150, 40)));
  face([dTop, dRight, dBot, dLeft], lin(0, topY - q, 0, topY + q, rgb(255, 226, 130), rgb(250, 208, 74)));
  // bold "?" on the front (left) face, centred over that parallelogram
  const cx = (dLeft[0] + dBot[0] + bBot[0] + bLeft[0]) / 4;
  const cy = (dLeft[1] + dBot[1] + bBot[1] + bLeft[1]) / 4;
  ctx.fillStyle = "#7a3d05";
  ctx.font = `900 ${h * 0.62}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", cx, cy);
  ctx.textBaseline = "alphabetic";
  ctx.restore();
}

// Flame emblem, shown above a marble that just grabbed the fire speed boost.
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
// A land mine lying flat on the floor: a dark spiked dome ringed in hazard red
// with a white skull. No float, no spin - a static "danger, dead ahead" marker.
function drawMine(ctx: Ctx, x: number, y: number, s: number, lit: number) {
  ctx.save();
  ctx.translate(x, y);
  // red danger glow, stronger the instant a marble trips it
  const glow = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, s * 2.4);
  glow.addColorStop(0, `rgba(255,40,40,${lit > 0 ? 0.85 : 0.4})`);
  glow.addColorStop(1, "rgba(255,40,40,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(0, 0, s * 2.4, 0, Math.PI * 2);
  ctx.fill();
  // spikes poking out around the rim, squashed flat to sit on the floor
  ctx.fillStyle = "#3a1416";
  const spikes = 8;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2;
    const bx = Math.cos(a);
    const by = Math.sin(a) * 0.6;
    ctx.beginPath();
    ctx.moveTo(bx * s * 1.02, by * s * 1.02);
    ctx.lineTo(bx * s * 1.44, by * s * 1.44);
    ctx.lineTo((bx * 1.08 - by * 0.18) * s, (by * 1.08 + bx * 0.18) * s);
    ctx.closePath();
    ctx.fill();
  }
  // flattened dome body
  const body = ctx.createRadialGradient(-s * 0.3, -s * 0.3, s * 0.12, 0, 0, s);
  body.addColorStop(0, "#5a2226");
  body.addColorStop(1, "#180809");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 0, s, s * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  // hazard ring
  ctx.lineWidth = Math.max(1.5, s * 0.12);
  ctx.strokeStyle = lit > 0 ? "#ff5a5a" : "#c02a2a";
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.82, s * 0.56, 0, 0, Math.PI * 2);
  ctx.stroke();
  // white skull warning
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.beginPath();
  ctx.arc(0, -s * 0.08, s * 0.4, Math.PI, 0);
  ctx.lineTo(s * 0.28, s * 0.2);
  ctx.lineTo(s * 0.14, s * 0.2);
  ctx.lineTo(s * 0.14, s * 0.32);
  ctx.lineTo(-s * 0.14, s * 0.32);
  ctx.lineTo(-s * 0.14, s * 0.2);
  ctx.lineTo(-s * 0.28, s * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#180809";
  ctx.beginPath();
  ctx.arc(-s * 0.16, -s * 0.06, s * 0.1, 0, Math.PI * 2);
  ctx.arc(s * 0.16, -s * 0.06, s * 0.1, 0, Math.PI * 2);
  ctx.fill();
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
    const grow = obGrow(ob);
    const rad = base * (0.4 + 0.6 * grow); // pop-in / fade-out scale
    const p = pathPoint(g, ob.u);
    const x = p.x + p.nx * ob.laneN * spread;
    const y = p.y + p.ny * ob.laneN * spread;
    ctx.save();
    ctx.globalAlpha = grow;
    if (ob.type === "mystery") {
      // hidden while an opened box counts down to its refill
      if (ob.respawn <= 0) drawMysteryBox(ctx, x, y, rad * 1.25, t, ob.u, ob.lit);
    } else if (ob.type === "bomb") {
      drawMine(ctx, x, y, rad * 1.25, ob.lit);
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
function drawLeaderboard(ctx: Ctx, g: Geo, order: number[], active: Racer[], items: RacerItem[], sprites: HTMLCanvasElement[], lap: number, total: number) {
  const n = Math.min(5, order.length);
  if (n === 0) return;
  const rowH = Math.min(g.W, g.H) * 0.04; // compact - tucks into the corner
  const headerH = rowH * 0.95;
  const pad = rowH * 0.32;
  ctx.font = `600 ${rowH * 0.42}px ${FONT}`;
  let nameW = 0;
  for (let i = 0; i < n; i++) nameW = Math.max(nameW, ctx.measureText(items[active[order[i]].it].name).width);
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
    const c = items[r.it];
    const ry = py + headerH + i * rowH + rowH / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = i < 3 ? MEDAL[i] : "rgba(255,255,255,0.7)";
    ctx.font = `800 ${rowH * 0.42}px ${FONT}`;
    ctx.fillText(String(i + 1), px + pad + rowH * 0.35, ry);
    const fr = rowH * 0.32;
    const sprite = sprites[r.it];
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
  const [items, setItems] = useState<RacerItem[]>([]);
  const liveRef = useRef<HTMLParagraphElement>(null); // sr-only lead-change announcer
  const lastLeadRef = useRef(-1);
  // Player settings chosen on the setup screen. A ref mirror lets startRace read
  // the latest values without being re-created on every change.
  const [round, setRound] = useState(3);
  const [stageIndex, setStageIndex] = useState(0);
  const [categoryIndex, setCategoryIndex] = useState(0); // what the marbles are (countries, states, colours, fruit, veg)
  const [showLive, setShowLive] = useState(true); // live top-5 board
  const [autoPlay, setAutoPlay] = useState(false); // loop random races hands-free
  const [confirmReset, setConfirmReset] = useState(false);
  const settings = useRef({ round: 3, stage: 0, category: 0, showLive: true, autoPlay: false });
  settings.current = { round, stage: stageIndex, category: categoryIndex, showLive, autoPlay };
  const renderRef = useRef<MarbleRender[]>([]);
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    items: RacerItem[]; // the 10 racing this heat (aligned with sprites + Racer.it)
    stage: Stage;
    active: Racer[];
    finishers: number[];
    obstacles: Obstacle[];
    bombTimer: number; // counts up to BOMB_EVERY, then a bomb mine drops in
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
  }>({ sprites: [], items: [], stage: STAGES[0], active: [], finishers: [], obstacles: [], bombTimer: 0, blasts: [], laps: 3, finishDist: TRACK_LEN * 3, countdown: 3, goFlash: 0, lastCount: 4, elapsed: 0, raf: 0, last: 0, ended: false, podiumIn: -1, showLive: true });

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
    // Pick 10 distinct random items from the chosen category (countries, states,
    // colours, fruit, veg). A short pool (>= 10 always) is shuffled and sliced.
    const category = CATEGORIES[settings.current.category] ?? CATEGORIES[0];
    const pool = category.items.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = pool.slice(0, RACERS);
    s.items = chosen;
    // Bake each racer's leaderboard thumbnail, keyed by its slot (0-9). Image
    // skins (flags) load async and fill in; emoji/colour skins bake right away.
    s.sprites = [];
    chosen.forEach((item, k) => {
      const sprite = bakeItem(item, (c) => {
        s.sprites[k] = c;
      });
      if (sprite) s.sprites[k] = sprite;
    });
    setItems(chosen);
    renderRef.current = chosen.map(() => ({ x: 0, y: 0, r: 0, dx: 1, dy: 0, dist: 0, flash: 0, good: false, out: false }));
    s.active = chosen.map((item, k) => {
      const lane = k % 5;
      const row = Math.floor(k / 5);
      return {
        i: k,
        it: k,
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
    // The 8 mystery boxes are permanent fixtures on the track from the start; the
    // first bomb mine holds off a couple seconds so eliminations don't begin too soon.
    s.obstacles = spawnMysteryFixtures();
    s.bombTimer = 2;
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
          // Mystery boxes are fixed fixtures: they don't age. An opened one counts
          // its refill down, then pops back in. Bomb mines age out normally.
          for (const ob of st.obstacles) {
            ob.lit = Math.max(0, ob.lit - dt);
            if (ob.type === "mystery" && ob.respawn > 0) {
              ob.respawn -= dt;
              if (ob.respawn <= 0) {
                ob.respawn = 0;
                ob.life = ob.maxLife; // refill: replay the pop-in
              }
              continue;
            }
            ob.life -= dt;
          }
          st.obstacles = st.obstacles.filter((ob) => ob.life > 0);
          // A bomb mine drops onto the track on its own timer.
          st.bombTimer += dt;
          if (st.bombTimer >= BOMB_EVERY) {
            st.bombTimer -= BOMB_EVERY;
            st.obstacles.push(spawnCoin("bomb"));
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
            // mystery boxes change speed/size (or fire = big boost); bombs eliminate
            if (r.obCool <= 0) {
              for (const ob of st.obstacles) {
                if (ob.type === "mystery" && ob.respawn > 0) continue; // eaten, refilling
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
                } else {
                  // Mystery box opens into a random effect - boost / mud / tar /
                  // banana / shrink / grow, or fire (the big speed boost).
                  const effType = MYSTERY_POOL[Math.floor(Math.random() * MYSTERY_POOL.length)];
                  const def = OB[effType];
                  if (def.mul) {
                    r.effMul = def.mul;
                    r.effTime = def.time ?? 1;
                  }
                  if (def.scale) r.scale = Math.max(0.62, Math.min(1.5, r.scale * def.scale));
                  r.fx = effType; // show the effect's icon above the marble
                  r.fxTime = def.mul ? (def.time ?? 1) : 1.4;
                  sound.mystery();
                  if (effType === "fire") sound.fire(); // extra whoosh on the big boost
                  r.flashGood = def.good;
                }
                // light it up + flash the marble edge (~1s). A bomb mine is consumed;
                // an opened mystery box hides, then refills after MYSTERY_REFILL.
                ob.lit = 1;
                if (ob.type === "bomb") ob.life = 0;
                else ob.respawn = MYSTERY_REFILL;
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
            st.finishers.push(r.it);
          }
          if (st.finishers.length >= NEED && st.podiumIn < 0) {
            // Race is decided - keep the scene rolling for a moment before the podium.
            st.podiumIn = 3;
            const top = st.finishers.slice(0, NEED).map((slot, idx) => ({ item: st.items[slot], place: idx + 1 }));
            setPodium(top);
            setAnnounce(
              `Race finished. Gold ${top[0].item.name}, silver ${top[1].item.name}, bronze ${top[2].item.name}.`,
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
        const leadIt = st.active[order[0]]?.it ?? -1;
        if (leadIt !== lastLeadRef.current && leadIt >= 0 && !st.ended) {
          lastLeadRef.current = leadIt;
          if (liveRef.current) liveRef.current.textContent = `${st.items[leadIt].name} takes the lead`;
        }
        drawRankBadges(ctx, g, order, st.active);
        drawEffectBadges(ctx, g, st.active); // effect icon above each hit marble
        if (st.showLive) drawLeaderboard(ctx, g, order, st.active, st.items, st.sprites, lap, st.laps);
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
      {items.length > 0 && (
        <div className="pointer-events-none absolute inset-0">
          <RaceMarbles items={items} data={renderRef} />
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
          <h1 className="text-4xl font-extrabold text-white sm:text-5xl">Racer</h1>

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
            <p className="mb-3 text-center text-lg font-semibold text-white/70">Racers</p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
              {CATEGORIES.map((cat, i) => {
                const on = i === categoryIndex;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setCategoryIndex(i)}
                    className={`flex flex-col items-center gap-1.5 rounded-2xl border-2 px-3 py-4 text-center transition active:scale-95 ${
                      on ? "border-white bg-white/20 scale-105" : "border-white/15 bg-white/5 hover:bg-white/10"
                    }`}
                  >
                    <span className="text-3xl">{cat.icon}</span>
                    <span className="text-sm font-bold text-white">{cat.label}</span>
                  </button>
                );
              })}
            </div>
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
                <div key={w.item.id} className={`relative flex flex-col items-center ${lift}`} style={{ width: px }}>
                  <div className="relative z-10 mb-1 text-5xl sm:text-6xl">{medal}</div>
                  <div style={{ width: px, height: px }} className="drop-shadow-[0_12px_30px_rgba(0,0,0,0.6)]">
                    <PodiumMarble3D item={w.item} />
                  </div>
                  {/* Absolute so a long name never widens the column and shifts the podium off-centre. */}
                  <p className="absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap text-lg font-bold sm:text-2xl">
                    {w.item.name}
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
