"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { COUNTRIES, type Country } from "../data/countries";
import {
  FINISH,
  TRACK_LEN,
  markFinishers,
  standings,
  stepRacer,
  type Racer,
} from "@/lib/race";

const SPRITE = 96; // baked marble sprite resolution (px)
const OBS_START = 0.46; // hurdle band (fraction of a lap)
const OBS_END = 0.54;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

// A racer plus its view-only lane offset across the track band.
type LaneRacer = Racer & { laneN: number };
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

// Randomized stages - a different scene every race.
const THEMES: Theme[] = [
  { name: "Night", bg: "#04050a", track: "#191c26", line: "rgba(255,255,255,0.5)", dashed: true, edge: "rgba(255,255,255,0.18)", decor: "stars", decorColor: "rgba(255,255,255,0.8)" },
  { name: "Grass", bg: "#08160d", track: "#2b2f38", line: "rgba(255,255,255,0.5)", dashed: true, edge: "rgba(255,255,255,0.16)", decor: "trees", decorColor: "#2e8b45" },
  { name: "Neon", bg: "#070512", track: "#151129", line: "rgba(120,225,255,0.7)", dashed: false, edge: "rgba(140,90,255,0.6)", decor: "dots", decorColor: "rgba(120,225,255,0.5)" },
  { name: "Desert", bg: "#170f04", track: "#332d22", line: "rgba(255,238,200,0.45)", dashed: true, edge: "rgba(255,255,255,0.14)", decor: "none", decorColor: "rgba(0,0,0,0)" },
];

// Bake a country's flag into a glossy marble sprite once, then just blit it.
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
  rim.addColorStop(0.75, "rgba(0,0,0,0.05)");
  rim.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = rim;
  g.fillRect(0, 0, SPRITE, SPRITE);
  const hi = g.createRadialGradient(r * 0.62, r * 0.55, 1, r * 0.62, r * 0.55, r * 0.9);
  hi.addColorStop(0, "rgba(255,255,255,0.85)");
  hi.addColorStop(0.18, "rgba(255,255,255,0.35)");
  hi.addColorStop(0.4, "rgba(255,255,255,0)");
  g.fillStyle = hi;
  g.fillRect(0, 0, SPRITE, SPRITE);
  g.restore();

  g.beginPath();
  g.arc(r, r, r - 2, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.stroke();
  return c;
}

// --- Track geometry: a rounded-rect loop hugging the screen edges ---------

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
  const inset = m * 0.018; // hug the screen edge - waste no space
  const band = m * 0.24; // wide road so the flag marbles are big and clear
  const bandHalf = band / 2;
  const size = band * 0.5;
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

  // clockwise from top-center (finish line is at u = 0)
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

type Ctx = CanvasRenderingContext2D;
type Sprites = HTMLCanvasElement[];

// small deterministic hash so decor never flickers frame to frame
function h1(i: number, salt: number) {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function drawScenery(ctx: Ctx, g: Geo) {
  ctx.fillStyle = g.theme.bg;
  ctx.fillRect(0, 0, g.W, g.H);
  const t = g.theme;
  if (t.decor === "stars" || t.decor === "dots") {
    const n = 70;
    for (let i = 0; i < n; i++) {
      const x = h1(i, 1) * g.W;
      const y = h1(i, 2) * g.H;
      const rad = (0.6 + h1(i, 3) * 1.6) * g.dpr;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = t.decorColor;
      ctx.fill();
    }
  } else if (t.decor === "trees") {
    const n = 22;
    for (let i = 0; i < n; i++) {
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
  // band
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2;
  ctx.strokeStyle = g.theme.track;
  ctx.stroke();
  // edges
  trackPath(ctx, g);
  ctx.lineWidth = g.bandHalf * 2 + 2 * g.dpr;
  ctx.strokeStyle = g.theme.edge;
  ctx.globalCompositeOperation = "destination-over";
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  // centre lane line
  trackPath(ctx, g);
  ctx.lineWidth = 2 * g.dpr;
  ctx.setLineDash(g.theme.dashed ? [10 * g.dpr, 12 * g.dpr] : []);
  ctx.strokeStyle = g.theme.line;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawObstacle(ctx: Ctx, g: Geo) {
  const N = 18;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const p = pathPoint(g, OBS_START + ((OBS_END - OBS_START) * i) / N);
    const x = p.x + p.nx * g.bandHalf;
    const y = p.y + p.ny * g.bandHalf;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = N; i >= 0; i--) {
    const p = pathPoint(g, OBS_START + ((OBS_END - OBS_START) * i) / N);
    ctx.lineTo(p.x - p.nx * g.bandHalf, p.y - p.ny * g.bandHalf);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(230,70,40,0.32)";
  ctx.fill();
  ctx.restore();
}

function drawFinish(ctx: Ctx, g: Geo) {
  const p = pathPoint(g, 0);
  ctx.save();
  ctx.lineWidth = 4 * g.dpr;
  ctx.setLineDash([6 * g.dpr, 6 * g.dpr]);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.moveTo(p.x - p.nx * g.bandHalf, p.y - p.ny * g.bandHalf);
  ctx.lineTo(p.x + p.nx * g.bandHalf, p.y + p.ny * g.bandHalf);
  ctx.stroke();
  ctx.restore();
}

function drawMarbles(ctx: Ctx, g: Geo, racers: LaneRacer[], sprites: Sprites, order: number[], elapsed: number) {
  const rankOf = new Map<number, number>();
  order.forEach((idx, k) => rankOf.set(idx, k));
  const spread = g.bandHalf - g.size * 0.5;
  for (let idx = 0; idx < racers.length; idx++) {
    const r = racers[idx];
    const u = (((r.dist % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / TRACK_LEN;
    const p = pathPoint(g, u);
    const off = r.laneN * spread + Math.sin(elapsed * 2 + r.i) * g.size * 0.12;
    const x = p.x + p.nx * off;
    const y = p.y + p.ny * off;
    const sp = sprites[r.i];
    const rank = rankOf.get(idx) ?? 999;
    const ms = rank < 3 ? g.size * 1.3 : g.size;
    if (sp && sp.width) ctx.drawImage(sp, x - ms / 2, y - ms / 2, ms, ms);
    if (rank < 3) {
      ctx.beginPath();
      ctx.arc(x, y, ms / 2 + 1.5 * g.dpr, 0, Math.PI * 2);
      ctx.lineWidth = 3 * g.dpr;
      ctx.strokeStyle = ["#ffd24a", "#cfd6e0", "#e0a06a"][rank];
      ctx.stroke();
    }
  }
}

// Live top-10 standings, drawn in the centre hole - rank + flag only, so the
// panel stays narrow and the road can stay wide.
function drawStandings(ctx: Ctx, g: Geo, racers: LaneRacer[], sprites: Sprites, order: number[]) {
  const { hole } = g;
  const N = Math.min(10, order.length);
  // compact report - small rows so the road can be as big as possible
  const rowH = Math.min(hole.h / 16, g.size * 0.62);
  const flag = rowH * 0.82;
  const numW = rowH * 0.78;
  const gap = rowH * 0.24;
  const rowW = numW + gap + flag;
  const listH = rowH * (N + 1.6);
  const top = hole.y + (hole.h - listH) / 2;
  const midX = hole.x + hole.w / 2;

  ctx.save();
  // narrow panel for readability
  const panelW = rowW + rowH * 1.2;
  ctx.fillStyle = "rgba(0,0,0,0.34)";
  ctx.beginPath();
  ctx.roundRect(midX - panelW / 2, top - rowH * 0.35, panelW, listH + rowH * 0.35, 12 * g.dpr);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `700 ${Math.round(rowH * 0.62)}px ${FONT}`;
  ctx.fillText("TOP 10", midX, top + rowH * 0.5);

  const medals = ["#ffd24a", "#cfd6e0", "#e0a06a"];
  for (let k = 0; k < N; k++) {
    const r = racers[order[k]];
    const y = top + rowH * (k + 1.7);
    const medal = k < 3 ? medals[k] : "rgba(255,255,255,0.8)";
    const x = midX - rowW / 2;

    ctx.textAlign = "right";
    ctx.fillStyle = medal;
    ctx.font = `700 ${Math.round(rowH * 0.62)}px ${FONT}`;
    ctx.fillText(`${k + 1}`, x + numW * 0.85, y + flag * 0.66);

    const fx = x + numW + gap;
    const sp = sprites[r.i];
    if (sp && sp.width) ctx.drawImage(sp, fx, y, flag, flag);
    if (k < 3) {
      ctx.beginPath();
      ctx.arc(fx + flag / 2, y + flag / 2, flag / 2 + 1.5 * g.dpr, 0, Math.PI * 2);
      ctx.lineWidth = 2.5 * g.dpr;
      ctx.strokeStyle = medal;
      ctx.stroke();
    }
  }
  ctx.restore();
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    racers: LaneRacer[];
    theme: Theme;
    finished: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
  }>({ sprites: [], racers: [], theme: THEMES[0], finished: 0, elapsed: 0, raf: 0, last: 0, ended: false });

  // Load flags + bake sprites once.
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
    s.racers = COUNTRIES.map((_, i) => ({
      i,
      dist: Math.random() * 150, // small stagger so the field starts spread out
      speed: 0,
      form: 0.9 + Math.random() * 0.3,
      place: 0,
      laneN: Math.random() * 2 - 1,
    }));
    s.finished = 0;
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
    if (s.racers.length === 0) startRace();

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
        st.elapsed += dt;
        for (const r of st.racers) {
          const u = (((r.dist % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / TRACK_LEN;
          const slow = u >= OBS_START && u <= OBS_END ? 0.5 : 1;
          stepRacer(r, dt, st.elapsed, undefined, slow);
        }
        st.finished = markFinishers(st.racers, FINISH, st.finished);
        if (st.finished >= 3) {
          st.ended = true;
          const order = standings(st.racers).slice(0, 3);
          const top = order.map((idx, k) => ({ country: COUNTRIES[st.racers[idx].i], place: k + 1 }));
          setPodium(top);
          setAnnounce(
            `Race finished. Gold ${top[0].country.name}, silver ${top[1].country.name}, bronze ${top[2].country.name}.`,
          );
          setPhase("done");
        }
      }

      drawScenery(ctx, g);
      drawTrack(ctx, g);
      drawObstacle(ctx, g);
      drawFinish(ctx, g);
      const order = standings(st.racers);
      drawMarbles(ctx, g, st.racers, st.sprites, order, st.elapsed);
      drawStandings(ctx, g, st.racers, st.sprites, order);

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
        aria-label="Live race of all 194 country flag marbles around a track"
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

      {phase === "done" && podium.length === 3 && (
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
