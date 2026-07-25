import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COUNTRIES } from "../app/data/countries.ts";

const flagsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "flags",
);

test("there are exactly 194 racers", () => {
  assert.equal(COUNTRIES.length, 194);
});

test("every country code is unique lowercase two letters", () => {
  const seen = new Set<string>();
  for (const c of COUNTRIES) {
    assert.match(c.code, /^[a-z]{2}$/, `bad code: ${c.code}`);
    assert.ok(!seen.has(c.code), `duplicate: ${c.code}`);
    seen.add(c.code);
  }
});

test("every racer ships a self-hosted flag PNG", () => {
  const files = new Set(readdirSync(flagsDir));
  for (const c of COUNTRIES) {
    assert.ok(files.has(`${c.code}.png`), `missing flag: ${c.code}.png`);
  }
});
