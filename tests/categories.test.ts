import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { STATES } from "../app/data/states.ts";

// The racer categories (countries, US states, colours, fruit, veg) are assembled
// in categories.ts, which pulls in countries + states. That module is validated
// by tsc against the RacerItem shape; here we guard the one genuinely new,
// asset-backed pool - the 50 US states must each ship a self-hosted flag PNG.
const statesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "states");

test("there are exactly 50 US states", () => {
  assert.equal(STATES.length, 50);
});

test("every state abbr is unique lowercase two letters", () => {
  const seen = new Set<string>();
  for (const s of STATES) {
    assert.match(s.abbr, /^[a-z]{2}$/, `bad abbr: ${s.abbr}`);
    assert.ok(!seen.has(s.abbr), `duplicate: ${s.abbr}`);
    assert.ok(s.name.length > 0, `missing name for ${s.abbr}`);
    seen.add(s.abbr);
  }
});

test("every state ships a self-hosted flag PNG", () => {
  const files = new Set(readdirSync(statesDir));
  for (const s of STATES) {
    assert.ok(files.has(`${s.abbr}.png`), `missing flag: ${s.abbr}.png`);
  }
});
