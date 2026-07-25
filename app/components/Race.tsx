"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { COUNTRIES, type Country } from "../data/countries";
import {
  FINISH,
  LAPS,
  TRACK_LEN,
  markFinishers,
  standings,
  stepRacer,
  type Racer,
} from "@/lib/race";

const SPRITE = 96; // baked marble sprite resolution (px)
const OBS_START = 0.44; // "Great Wall" hurdle band (fraction of a lap)
const OBS_END = 0.56;
const CHINA = "cn";

// A racer plus its view-only lane offset across the track band.
type LaneRacer = Racer & { laneN: number };
type Winner = { country: Country; place: number };

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
  // cover-fit the flag (flags are ~3:2, so crop sides)
  const s = Math.max(SPRITE / img.width, SPRITE / img.height);
  const w = img.width * s;
  const h = img.height * s;
  g.drawImage(img, (SPRITE - w) / 2, (SPRITE - h) / 2, w, h);
  // spherical rim shading
  const rim = g.createRadialGradient(r, r, r * 0.35, r, r, r);
  rim.addColorStop(0, "rgba(0,0,0,0)");
  rim.addColorStop(0.75, "rgba(0,0,0,0.05)");
  rim.addColorStop(1, "rgba(0,0,0,0.55)");
  g.fillStyle = rim;
  g.fillRect(0, 0, SPRITE, SPRITE);
  // glossy highlight, top-left
  const hi = g.createRadialGradient(r * 0.62, r * 0.55, 1, r * 0.62, r * 0.55, r * 0.9);
  hi.addColorStop(0, "rgba(255,255,255,0.85)");
  hi.addColorStop(0.18, "rgba(255,255,255,0.35)");
  hi.addColorStop(0.4, "rgba(255,255,255,0)");
  g.fillStyle = hi;
  g.fillRect(0, 0, SPRITE, SPRITE);
  g.restore();

  // crisp outline
  g.beginPath();
  g.arc(r, r, r - 2, 0, Math.PI * 2);
  g.lineWidth = 2;
  g.strokeStyle = "rgba(255,255,255,0.35)";
  g.stroke();
  return c;
}

export default function Race() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"loading" | "racing" | "done">("loading");
  const [podium, setPodium] = useState<Winner[]>([]);
  const [announce, setAnnounce] = useState("");
  const state = useRef<{
    sprites: HTMLCanvasElement[];
    racers: LaneRacer[];
    finished: number;
    elapsed: number;
    raf: number;
    last: number;
    ended: boolean;
  }>({ sprites: [], racers: [], finished: 0, elapsed: 0, raf: 0, last: 0, ended: false });

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
    s.racers = COUNTRIES.map((_, i) => ({
      i,
      dist: 0,
      speed: 0,
      form: 0.9 + Math.random() * 0.3,
      place: 0,
      laneN: Math.random() * 2 - 1, // spreads racers across the track band
    }));
    s.finished = 0;
    s.elapsed = 0;
    s.ended = false;
    s.last = 0;
    setPodium([]);
    setPhase("racing");
  }, []);

  // The race loop.
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

      const W = canvas.width;
      const H = canvas.height;
      const cx = W / 2;
      const cy = H / 2;
      const rx = W * 0.4;
      const ry = H * 0.34;
      const band = Math.min(rx, ry) * 0.34;
      const size = Math.max(14 * dpr, Math.min(W, H) * 0.04);

      if (!st.ended) {
        st.elapsed += dt;
        const racers = st.racers;
        for (const r of racers) {
          const u = ((r.dist % TRACK_LEN) + TRACK_LEN) % TRACK_LEN / TRACK_LEN;
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

      // background
      ctx.clearRect(0, 0, W, H);

      // track ring (even-odd fill = oval band)
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + band, ry + band, 0, 0, Math.PI * 2);
      ctx.ellipse(cx, cy, rx - band, ry - band, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#12141c";
      ctx.fill("evenodd");
      // track edges
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + band, ry + band, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx - band, ry - band, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // obstacle band (the "Great Wall" hurdle)
      const a0 = OBS_START * Math.PI * 2 - Math.PI / 2;
      const a1 = OBS_END * Math.PI * 2 - Math.PI / 2;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx + band, ry + band, 0, a0, a1);
      ctx.ellipse(cx, cy, rx - band, ry - band, 0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = "rgba(220,60,40,0.28)";
      ctx.fill();
      ctx.restore();

      // finish line at the top (u = 0)
      const fa = -Math.PI / 2;
      ctx.save();
      ctx.lineWidth = 4 * dpr;
      ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(cx + (rx - band) * Math.cos(fa), cy + (ry - band) * Math.sin(fa));
      ctx.lineTo(cx + (rx + band) * Math.cos(fa), cy + (ry + band) * Math.sin(fa));
      ctx.stroke();
      ctx.restore();

      // center emblem: host = China marble + label
      const chinaIdx = COUNTRIES.findIndex((c) => c.code === CHINA);
      const emblem = st.sprites[chinaIdx];
      const es = Math.min(rx, ry) * 0.7;
      if (emblem && emblem.width) ctx.drawImage(emblem, cx - es / 2, cy - es / 2 - es * 0.1, es, es);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = `700 ${Math.round(size * 0.9)}px var(--font-display), sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("RACING AT CHINA", cx, cy + es * 0.55);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = `500 ${Math.round(size * 0.6)}px var(--font-display), sans-serif`;
      ctx.fillText(`${st.elapsed.toFixed(1)}s`, cx, cy + es * 0.55 + size * 0.9);

      // marbles
      const order = standings(st.racers);
      const rankOf = new Map<number, number>();
      order.forEach((idx, k) => rankOf.set(idx, k));
      const racers = st.racers;
      for (let idx = 0; idx < racers.length; idx++) {
        const r = racers[idx];
        const u = (((r.dist % TRACK_LEN) + TRACK_LEN) % TRACK_LEN) / TRACK_LEN;
        const ang = u * Math.PI * 2 - Math.PI / 2;
        const off = r.laneN * band * 0.82 + Math.sin(st.elapsed * 2 + r.i) * band * 0.08;
        const x = cx + (rx + off) * Math.cos(ang);
        const y = cy + (ry + off) * Math.sin(ang);
        const sp = st.sprites[r.i];
        const rank = rankOf.get(idx) ?? 999;
        const ms = rank < 3 ? size * 1.25 : size;
        if (sp && sp.width) ctx.drawImage(sp, x - ms / 2, y - ms / 2, ms, ms);
        if (rank < 3) {
          ctx.beginPath();
          ctx.arc(x, y, ms / 2 + 1.5 * dpr, 0, Math.PI * 2);
          ctx.lineWidth = 3 * dpr;
          ctx.strokeStyle = ["#ffd24a", "#cfd6e0", "#e0a06a"][rank];
          ctx.stroke();
        }
      }

      // live standings panel (top 5)
      const pad = 12 * dpr;
      const rowH = size * 1.15;
      ctx.textAlign = "left";
      ctx.font = `600 ${Math.round(size * 0.62)}px var(--font-display), sans-serif`;
      for (let k = 0; k < 5 && k < order.length; k++) {
        const r = racers[order[k]];
        const y = pad + k * rowH;
        const sp = st.sprites[r.i];
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(`${k + 1}`, pad, y + rowH * 0.55);
        if (sp && sp.width) ctx.drawImage(sp, pad + size * 0.8, y, rowH * 0.85, rowH * 0.85);
        const lap = Math.min(LAPS, Math.floor(r.dist / TRACK_LEN) + 1);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillText(
          `${COUNTRIES[r.i].name}  ·  lap ${lap}/${LAPS}`,
          pad + size * 0.8 + rowH,
          y + rowH * 0.55,
        );
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
        aria-label="Live race of all 194 country flag marbles around an oval track"
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
