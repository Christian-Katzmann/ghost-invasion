import assert from "node:assert/strict";
import test from "node:test";
import { parseSeed } from "../dist/seed.js";

test("a bare integer seed is used verbatim", () => {
  assert.equal(parseSeed("1337"), 1337);
  assert.equal(parseSeed("0"), 0);
  assert.equal(parseSeed("-5"), -5);
  assert.equal(parseSeed("  42  "), 42);
});

test("a numeric-leading SHA is no longer silently truncated (S-044)", () => {
  // Number.parseInt("36f5b42a1c", 10) === 36 — the corruption this fixes.
  const seed = parseSeed("36f5b42a1c");
  assert.notEqual(seed, 36);
  assert.ok(Number.isInteger(seed));
});

test("an alpha-leading SHA hashes to a real integer instead of NaN (S-044)", () => {
  // Number.parseInt("f00ba7", 10) === NaN — which SeededRng folded to a constant.
  const seed = parseSeed("f00ba7");
  assert.ok(Number.isInteger(seed));
  assert.ok(!Number.isNaN(seed));
});

test("non-numeric seeds hash stably and distinctly (deterministic replay)", () => {
  assert.equal(parseSeed("36f5b42a1c"), parseSeed("36f5b42a1c"));
  assert.notEqual(parseSeed("36f5b42a1c"), parseSeed("36f5b42a1d"));
});

test("an all-digit value beyond MAX_SAFE_INTEGER is hashed, not lost to precision", () => {
  const huge = "36000000000000000000";
  const seed = parseSeed(huge);
  assert.ok(Number.isSafeInteger(seed));
  assert.notEqual(seed, Number(huge)); // Number(huge) is an imprecise float
});
