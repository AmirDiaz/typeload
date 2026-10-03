/**
 * Node-native test for the TypeLoad engine, using the sample project in
 * ../client. Validates that:
 *  - measurement completes and reports the project TS version
 *  - all showcase declarations are discovered
 *  - costs and instantiation counts are plausible (>= 0, some > 0)
 *  - the ranking puts heavy constructs on top
 *
 * Run with: npm test  (node --test test/)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import * as fs from "fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const root = import.meta.dirname + "/..";
/** @type {typeof import("typescript")} */
const ts = require_("typescript");

const { measureProject } = require_(
  path.join(root, "out", "analyzer", "measure.js")
);

const clientDir = path.join(root, "client");
const tsconfig = path.join(clientDir, "tsconfig.json");

test("engine measures the sample project", () => {
  const m = measureProject(ts, tsconfig);
  assert.equal(m.tsconfig, tsconfig);
  assert.equal(typeof m.typescriptVersion, "string");
  assert.ok(m.inputFiles >= 1, "at least one input file");
  assert.ok(m.decls.length >= 12, `found declarations (got ${m.decls.length})`);
});

test("expected declarations are discovered", () => {
  const m = measureProject(ts, tsconfig);
  const names = new Set(m.decls.map((d) => d.name));
  for (const expected of [
    "Digit",
    "TwoDigitNumber",
    "Depth10",
    "FlatNest",
    "AllPieces",
    "combineAll",
    "TransportMode",
    "BigInterface",
    "sample",
    "Calculator",
  ]) {
    assert.ok(names.has(expected), `missing declaration ${expected}`);
  }
});

test("costs and instantiations are plausible", () => {
  const m = measureProject(ts, tsconfig);
  for (const d of m.decls) {
    assert.ok(d.firstTouchMs >= 0, `negative cost on ${d.name}`);
    assert.ok(d.instantiations >= 0, `negative instantiations on ${d.name}`);
    assert.ok(d.line >= 1, `bad line on ${d.name}`);
  }
  const nonZero = m.decls.filter((d) => d.instantiations > 0);
  assert.ok(nonZero.length > 0, "expected some non-zero instantiation counts");
  assert.ok(m.totalInstantiations > 0, "expected total instantiations > 0");
});

test("ranking is descending by first-touch cost", () => {
  const m = measureProject(ts, tsconfig);
  const costs = m.decls.map((d) => d.firstTouchMs);
  for (let i = 1; i < costs.length; i++) {
    assert.ok(costs[i - 1] >= costs[i], "decls not sorted desc");
  }
});

test("file aggregates cover the measured file", () => {
  const m = measureProject(ts, tsconfig);
  const main = m.files.find((f) => f.file.endsWith("index.ts"));
  assert.ok(main, "sample file missing from aggregates");
  assert.ok(main.declCount >= 12);
  assert.equal(m.files.length, new Set(m.decls.map((d) => d.file)).size);
});

test("worker CLI produces the same shape via --out", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = path.join(root, "test", "tmp-worker-out.json");
  try {
    fs.unlinkSync(out);
  } catch {
    /* not present */
  }
  const workerJs = path.join(root, "out", "analyzer", "worker.js");
  const stdout = execFileSync(
    process.execPath,
    [workerJs, tsconfig, "--out", out],
    { encoding: "utf8", cwd: clientDir }
  );
  assert.ok(fs.existsSync(out), "worker did not write --out file");
  const m = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.ok(m.decls.length >= 12);
  assert.ok(typeof m.totalInstantiations === "number");
  // stdout final JSON should also parse (after progress lines)
  const lastLine = stdout.trim().split("\n").filter((l) => l && !l.startsWith("@@")).pop();
  assert.ok(lastLine, "worker printed no final JSON");
  assert.equal(JSON.parse(lastLine).decls.length, m.decls.length);
  fs.unlinkSync(out);
});
