import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGeo,
  pathPoint,
  uOf,
  crossed,
  separate,
  type Body,
  type Stage,
} from "../lib/geometry.ts";

// buildGeo only stores the stage; it never calls decor, so a stub is fine.
const STAGE = {
  name: "test",
  bg: "#000",
  road: "#000",
  infield: "#000",
  line: "#000",
  edge: "#000",
  song: "x",
  decor: () => {},
} as Stage;

test("buildGeo makes a rounded oval whose inner-edge radius stays above zero", () => {
  const g = buildGeo(800, 600, 1, STAGE);
  // r - bandHalf > 0 is what keeps the infield a smooth curve, never a square corner.
  assert.ok(g.cl.r - g.bandHalf > 0, "inner hole radius must be positive");
  assert.ok(g.perim > 0);
  assert.equal(g.segs.length, 9);
});

test("pathPoint returns a finite on-track point for any u (wraps past 1)", () => {
  const g = buildGeo(800, 600, 1, STAGE);
  for (const u of [0, 0.25, 0.5, 1.25, -0.3]) {
    const p = pathPoint(g, u);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(Number.isFinite(p.nx) && Number.isFinite(p.ny));
  }
});

test("uOf wraps distance + offset into [0,1)", () => {
  const at = (o: Partial<Body>): number =>
    uOf({ dist: 0, startU: 0, uAdj: 0, laneN: 0, scale: 1, ...o });
  assert.equal(at({}), 0);
  const w = at({ startU: -0.25 });
  assert.ok(w >= 0 && w < 1);
});

test("crossed detects a finish-line pass, including wrap-around", () => {
  assert.equal(crossed(0.1, 0.3, 0.2), true);
  assert.equal(crossed(0.1, 0.3, 0.5), false);
  assert.equal(crossed(0.9, 0.1, 0.0), true); // stepped across the 1->0 seam
});

test("separate pushes overlapping marbles apart in real screen space", () => {
  const g = buildGeo(800, 600, 1, STAGE);
  const spread = g.bandHalf - g.size * 0.5;
  const bodies: Body[] = Array.from({ length: 8 }, () => ({
    dist: 0,
    startU: 0,
    uAdj: 0,
    laneN: 0,
    scale: 1,
  }));
  separate(bodies, g);
  const pos = (b: Body) => {
    const p = pathPoint(g, uOf(b));
    return { x: p.x + p.nx * b.laneN * spread, y: p.y + p.ny * b.laneN * spread };
  };
  const minD = g.size * 1.06;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = pos(bodies[i]);
      const b = pos(bodies[j]);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(d >= minD * 0.8, `pair ${i},${j} still overlapping: ${d.toFixed(1)}`);
    }
  }
});
