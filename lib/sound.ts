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

// --- Per-stage background music: short synth loops themed to each scene. -----
// All synthesised (zero audio files), routed through `master` so the mute toggle
// silences music too. Notes are MIDI numbers (0 = rest); each track loops on its
// own length so the parts weave. Iconic public-domain tunes where they fit
// (call-to-post, "Charge!", Jingle Bells); genre pastiche for the rest.
const MIDI = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

type Song = {
  beat: number;
  lead: number[];
  leadType: OscillatorType;
  leadGain: number;
  bass: number[];
  bassType: OscillatorType;
  bassGain: number;
  hat?: number[]; // 0/1 percussion ticks
  hatGain?: number;
};

const SONGS: Record<string, Song> = {
  // Horse race - galloping "call to the post" bugle over a hoofbeat rhythm.
  horse: {
    beat: 0.16, leadType: "triangle", leadGain: 0.07,
    lead: [67, 0, 72, 76, 0, 79, 76, 72, 76, 0, 79, 84, 0, 79, 76, 72],
    bassType: "triangle", bassGain: 0.1, bass: [43, 0, 43, 0, 43, 0, 43, 0],
    hat: [1, 0, 1, 1, 0, 1, 1, 0], hatGain: 0.05,
  },
  // Soccer - a rousing, bouncy terrace chant.
  soccer: {
    beat: 0.26, leadType: "square", leadGain: 0.055,
    lead: [64, 64, 64, 0, 67, 64, 62, 0, 60, 60, 62, 64, 62, 0, 0, 0],
    bassType: "triangle", bassGain: 0.09, bass: [48, 0, 55, 0, 53, 0, 55, 0],
    hat: [1, 0, 0, 1, 0, 0, 1, 0], hatGain: 0.04,
  },
  // American football - a brassy marching fight-song with a snare pulse.
  football: {
    beat: 0.2, leadType: "sawtooth", leadGain: 0.05,
    lead: [67, 67, 67, 72, 76, 0, 72, 0, 74, 74, 74, 79, 0, 76, 72, 0],
    bassType: "square", bassGain: 0.08, bass: [48, 48, 43, 43],
    hat: [1, 1, 1, 1], hatGain: 0.055,
  },
  // Stadium - the classic "Charge!" rising fanfare.
  stadium: {
    beat: 0.19, leadType: "square", leadGain: 0.065,
    lead: [55, 0, 60, 0, 64, 0, 67, 0, 72, 0, 0, 0, 67, 0, 0, 0],
    bassType: "triangle", bassGain: 0.09, bass: [43, 0, 43, 0, 48, 0, 48, 0],
    hat: [1, 0, 1, 0], hatGain: 0.045,
  },
  // Airport - calm ambient lounge, slow floating pad.
  airport: {
    beat: 0.5, leadType: "sine", leadGain: 0.05,
    lead: [72, 0, 0, 0, 71, 0, 0, 0, 69, 0, 0, 0, 67, 0, 0, 0],
    bassType: "sine", bassGain: 0.07, bass: [48, 0, 0, 0, 53, 0, 0, 0],
  },
  // River side - a gentle, pastoral folk tune.
  river: {
    beat: 0.34, leadType: "triangle", leadGain: 0.05,
    lead: [64, 67, 69, 67, 64, 0, 62, 0, 60, 62, 64, 0, 62, 0, 0, 0],
    bassType: "sine", bassGain: 0.07, bass: [48, 0, 0, 55, 0, 0],
  },
  // Beach - sunny tropical steel-drum over a reggae off-beat.
  beach: {
    beat: 0.24, leadType: "triangle", leadGain: 0.055,
    lead: [72, 0, 76, 0, 79, 0, 76, 72, 74, 0, 71, 0, 67, 0, 69, 0],
    bassType: "triangle", bassGain: 0.09, bass: [0, 45, 0, 45, 0, 43, 0, 43],
    hat: [0, 1, 0, 1], hatGain: 0.035,
  },
  // Snow park - bright, jolly "Jingle Bells" with sleigh-bell ticks.
  snow: {
    beat: 0.22, leadType: "triangle", leadGain: 0.055,
    lead: [64, 64, 64, 0, 64, 64, 64, 0, 64, 67, 60, 62, 64, 0, 0, 0],
    bassType: "sine", bassGain: 0.08, bass: [48, 0, 55, 0],
    hat: [1, 1, 1, 1, 1, 1, 1, 1], hatGain: 0.03,
  },
};

let musicGain: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicStep = 0;
let musicNextT = 0;
let musicSong: Song | null = null;

function musicNote(freq: number, t: number, dur: number, gain: number, type: OscillatorType) {
  if (!ctx || !musicGain) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(musicGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function musicTick(t: number, gain: number) {
  if (!ctx || !musicGain) return;
  const len = Math.floor(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = "highpass";
  filt.frequency.value = 6000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  src.connect(filt);
  filt.connect(g);
  g.connect(musicGain);
  src.start(t);
  src.stop(t + 0.05);
}

function scheduleMusic() {
  const s = musicSong;
  if (!ctx || !musicGain || !s) return;
  while (musicNextT < ctx.currentTime + 0.3) {
    const t = musicNextT;
    const ln = s.lead[musicStep % s.lead.length];
    if (ln > 0) musicNote(MIDI(ln), t, s.beat * 1.6, s.leadGain, s.leadType);
    const bn = s.bass[musicStep % s.bass.length];
    if (bn > 0) musicNote(MIDI(bn), t, s.beat * 1.9, s.bassGain, s.bassType);
    if (s.hat && s.hat[musicStep % s.hat.length]) musicTick(t, s.hatGain ?? 0.03);
    musicStep++;
    musicNextT += s.beat;
  }
}

export const sound = {
  unlock() {
    ensure();
  },
  // Start (or switch to) the themed background loop for a stage.
  music(key: string) {
    const c = ensure();
    if (!c || !master) return;
    const song = SONGS[key];
    if (!song) return;
    if (!musicGain) {
      musicGain = c.createGain();
      musicGain.gain.value = 0.8;
      musicGain.connect(master);
    }
    musicSong = song;
    musicStep = 0;
    musicNextT = c.currentTime + 0.12;
    scheduleMusic();
    if (!musicTimer) musicTimer = setInterval(scheduleMusic, 60);
  },
  stopMusic() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
    musicSong = null;
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
  // Big celebration theme for the podium screen: a rising brass fanfare, a held
  // major chord, a sparkle arpeggio on top, and a soft cymbal swell underneath.
  celebrate() {
    [392, 523.25, 659.25, 783.99].forEach((f, i) =>
      tone({ type: "square", from: f, dur: 0.2, gain: 0.16, delay: i * 0.12 }),
    ); // rising fanfare G-C-E-G
    [523.25, 659.25, 783.99, 1046.5].forEach((f) =>
      tone({ type: "triangle", from: f, dur: 1.0, gain: 0.12, delay: 0.52 }),
    ); // held C major chord up top
    [1046.5, 1318.51, 1567.98, 2093.0].forEach((f, i) =>
      tone({ type: "sine", from: f, dur: 0.26, gain: 0.08, delay: 0.62 + i * 0.09 }),
    ); // sparkle
    noiseBurst(0.55, 0.12, 4200, true); // cymbal swell
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
