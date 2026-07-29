import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_SPEED,
  FINISH,
  markFinishers,
  standings,
  stepRacer,
  wobble,
  type Racer,
} from "../lib/race.ts";

function mk(over: Partial<Racer> = {}): Racer {
  return { i: 0, dist: 0, speed: 0, form: 1, place: 0, ...over };
}

test("wobble stays within roughly [-1, 1]", () => {
  for (let s = 0; s < 50; s++) {
    for (let t = 0; t < 20; t += 0.5) {
      const w = wobble(s, t);
      assert.ok(w >= -1.01 && w <= 1.01, `wobble out of range: ${w}`);
    }
  }
});

test("stepRacer advances distance and never stalls", () => {
  const r = mk({ form: 1 });
  stepRacer(r, 1, 0);
  assert.ok(r.dist > 0);
  assert.ok(r.speed >= BASE_SPEED * 0.25);
});

test("stepRacer applies the obstacle slow factor", () => {
  const fast = mk({ i: 5, form: 1 });
  const slow = mk({ i: 5, form: 1 });
  stepRacer(fast, 1, 3, BASE_SPEED, 1);
  stepRacer(slow, 1, 3, BASE_SPEED, 0.4);
  assert.ok(slow.dist < fast.dist, "slowed racer should travel less");
});

test("a finished racer stops advancing", () => {
  const r = mk({ dist: FINISH, place: 1 });
  const before = r.dist;
  stepRacer(r, 1, 0);
  assert.equal(r.dist, before);
});

test("standings puts finishers first, then by distance", () => {
  const racers = [
    mk({ i: 0, dist: 500, place: 0 }),
    mk({ i: 1, dist: FINISH, place: 1 }),
    mk({ i: 2, dist: 900, place: 0 }),
  ];
  assert.deepEqual(standings(racers), [1, 2, 0]);
});

test("markFinishers assigns places in crossing order (furthest first)", () => {
  const racers = [
    mk({ i: 0, dist: FINISH + 5 }),
    mk({ i: 1, dist: FINISH + 20 }),
    mk({ i: 2, dist: FINISH - 10 }),
  ];
  const count = markFinishers(racers, FINISH, 0);
  assert.equal(count, 2);
  assert.equal(racers[1].place, 1); // furthest across = 1st
  assert.equal(racers[0].place, 2);
  assert.equal(racers[2].place, 0); // not across yet
});

test("markFinishers continues numbering from the running count", () => {
  const racers = [mk({ i: 3, dist: FINISH + 1 })];
  const count = markFinishers(racers, FINISH, 2);
  assert.equal(count, 3);
  assert.equal(racers[0].place, 3);
});

test("markFinishers is a no-op when nobody has crossed", () => {
  const racers = [mk({ dist: FINISH - 1 }), mk({ dist: 10 })];
  assert.equal(markFinishers(racers, FINISH, 0), 0);
  assert.ok(racers.every((r) => r.place === 0));
});

test("wobble is deterministic for the same seed and time", () => {
  assert.equal(wobble(7, 3.5), wobble(7, 3.5));
  assert.notEqual(wobble(7, 3.5), wobble(8, 3.5));
});

test("a full simulated one-lap race crowns 3 finishers in a sane window", () => {
  const racers: Racer[] = Array.from({ length: 194 }, (_, i) => ({
    i,
    dist: 0,
    speed: 0,
    form: 0.9 + ((i * 37) % 30) / 100, // deterministic spread of form
    place: 0,
  }));
  let finished = 0;
  let t = 0;
  const dt = 1 / 60;
  while (finished < 3 && t < 90) {
    for (const r of racers) stepRacer(r, dt, t);
    finished = markFinishers(racers, FINISH, finished);
    t += dt;
  }
  assert.ok(finished >= 3, "at least 3 must finish");
  assert.ok(t >= 5 && t <= 40, `race length out of 5-40s window: ${t.toFixed(1)}s`);
  assert.equal(standings(racers).length, 194);
});
