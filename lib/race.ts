// Pure, deterministic race logic for Racer. No DOM, no randomness baked
// in (seeds/time are passed in), so every function here is unit-testable. The
// canvas component owns rendering and the real-time loop.

export type Racer = {
  i: number; // index into COUNTRIES
  dist: number; // total distance travelled along the track
  speed: number; // current speed (units / second)
  form: number; // per-racer baseline multiplier (some nations are quicker)
  place: number; // finishing place: 0 while racing, 1..N once across the line
};

export const TRACK_LEN = 1000; // distance of one lap
export const LAPS = 1;
export const FINISH = TRACK_LEN * LAPS; // total race distance
export const BASE_SPEED = 62; // tuned so the whole race runs ~35-55s

// Deterministic wobble in roughly [-1, 1] from a seed + time. Two out-of-phase
// sines give constant, lively overtaking without any real randomness.
export function wobble(seed: number, t: number): number {
  return (
    Math.sin(t * 1.3 + seed * 12.9898) * 0.6 +
    Math.sin(t * 0.7 + seed * 4.1234) * 0.4
  );
}

// Advance one racer by dt seconds. `slow` (0..1) is an obstacle multiplier the
// caller applies when the racer is inside a hazard zone.
export function stepRacer(
  r: Racer,
  dt: number,
  t: number,
  base: number = BASE_SPEED,
  slow: number = 1,
): void {
  if (r.place > 0) return; // finished racers stop advancing
  const w = wobble(r.i, t);
  let speed = base * r.form * (1 + 0.4 * w) * slow;
  if (speed < base * 0.25) speed = base * 0.25; // never fully stall
  r.speed = speed;
  r.dist += speed * dt;
}

// Current standings: finished racers first (by finishing place), then the rest
// ordered by distance. Returns racer indices into the passed array.
export function standings(racers: Racer[]): number[] {
  return racers
    .map((_, idx) => idx)
    .sort((a, b) => {
      const ra = racers[a];
      const rb = racers[b];
      const fa = ra.place > 0 ? ra.place : Infinity;
      const fb = rb.place > 0 ? rb.place : Infinity;
      if (fa !== fb) return fa - fb;
      return rb.dist - ra.dist;
    });
}

// Assign finishing places to any racer that has just crossed the line. Racers
// crossing in the same step are ordered by distance so the furthest gets the
// higher place. Returns the new finished count.
export function markFinishers(
  racers: Racer[],
  finish: number = FINISH,
  finishedCount: number = 0,
): number {
  const crossed = racers
    .filter((r) => r.place === 0 && r.dist >= finish)
    .sort((a, b) => b.dist - a.dist);
  let count = finishedCount;
  for (const r of crossed) r.place = ++count;
  return count;
}
