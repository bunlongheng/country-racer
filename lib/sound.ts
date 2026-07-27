// Tiny Web Audio sound engine. Everything is synthesised at runtime, so the
// game ships zero audio files - no CDN, no licensing, CSP stays 'self'. Every
// call is wrapped so audio can never throw or break the race.

const STORE_KEY = "cr-muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
const listeners = new Set<(m: boolean) => void>();

if (typeof window !== "undefined") {
  muted = window.localStorage?.getItem(STORE_KEY) === "1";
}

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(o: {
  type: OscillatorType;
  from: number;
  to?: number;
  dur: number;
  gain: number;
  delay?: number;
}) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

function noiseBurst(dur: number, gain: number, lp: number, sweep = false) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.setValueAtTime(lp, t0);
  if (sweep) filt.frequency.exponentialRampToValueAtTime(lp * 4, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

export const sound = {
  unlock() {
    ensure();
  },
  // Horse-racing "call to post" bugle when the countdown appears.
  bugle() {
    const notes = [392, 523.25, 659.25, 523.25, 659.25, 783.99];
    notes.forEach((f, i) =>
      tone({ type: "triangle", from: f, dur: 0.16, gain: 0.16, delay: i * 0.14 }),
    );
  },
  // One countdown beep (3, 2, 1).
  beep() {
    tone({ type: "square", from: 620, dur: 0.16, gain: 0.2 });
  },
  // The GO horn - bright and a little longer.
  go() {
    tone({ type: "sawtooth", from: 700, to: 1150, dur: 0.4, gain: 0.24 });
    tone({ type: "square", from: 1200, dur: 0.25, gain: 0.14, delay: 0.04 });
  },
  // A racer hits a spell.
  boost() {
    tone({ type: "sawtooth", from: 300, to: 1100, dur: 0.22, gain: 0.12 });
  },
  splat() {
    noiseBurst(0.16, 0.28, 500);
  },
  slip() {
    tone({ type: "sine", from: 900, to: 200, dur: 0.28, gain: 0.14 });
  },
  size() {
    tone({ type: "triangle", from: 500, to: 760, dur: 0.12, gain: 0.12 });
  },
  // Victory fanfare on the podium.
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) =>
      tone({ type: "triangle", from: f, dur: 0.18, gain: 0.2, delay: i * 0.13 }),
    );
  },

  isMuted() {
    return muted;
  },
  setMuted(m: boolean) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.01);
    if (typeof window !== "undefined") window.localStorage?.setItem(STORE_KEY, m ? "1" : "0");
    listeners.forEach((fn) => fn(m));
  },
  toggle() {
    ensure();
    this.setMuted(!muted);
    return muted;
  },
  subscribe(fn: (m: boolean) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
