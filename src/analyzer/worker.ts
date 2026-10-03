/**
 * TypeLoad measurement worker.
 *
 * Plain-Node CLI, spawned by the VSCode extension (or run directly):
 *
 *   node out/analyzer/worker.js <tsconfig.json> [--out results.json]
 *
 * - Resolves `typescript` from the TARGET PROJECT's node_modules first, so
 *   measurements match the compiler version the project actually uses.
 *   Falls back to this extension's bundled TypeScript.
 * - Streams progress as NDJSON lines on stdout prefixed with "@@".
 * - Prints the final ProjectMeasurement JSON on stdout.
 *   Exit code 0 on success, 1 on failure (error JSON on stdout).
 */

import * as fs from "fs";
import * as path from "path";
/* eslint-disable @typescript-eslint/no-explicit-any */
// Compiled to CommonJS: plain `require` is available at runtime (typed by @types/node).

declare function require(id: string): any;

interface MiniProjectMeasurement {
  typescriptSource: "project" | "bundled";
}

function resolveTypeScript(projectDir: string): {
  ts: typeof import("typescript");
  source: "project" | "bundled";
} {
  const candidates = [
    path.join(projectDir, "node_modules", "typescript", "lib", "typescript.js"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const ts = require(p);
        if (ts && typeof ts.version === "string") {
          return { ts, source: "project" };
        }
      }
    } catch {
      // keep trying
    }
  }
  const ts = require("typescript");
  return { ts, source: "bundled" };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tsconfigArg = argv[0];
  if (!tsconfigArg) {
    process.stdout.write(
      JSON.stringify({ error: "usage: worker.js <tsconfig.json> [--out file]" })
    );
    process.exit(1);
  }
  const outIdx = argv.indexOf("--out");
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const tsconfigPath = path.resolve(tsconfigArg);
  const projectDir = path.dirname(tsconfigPath);

  const emitProgress = (e: unknown): void => {
    process.stdout.write("@@" + JSON.stringify(e) + "\n");
  };

  emitProgress({ stage: "resolve-ts" });
  const { ts, source } = resolveTypeScript(projectDir);

  const { measureProject } = require("./measure.js");
  try {
    const result = measureProject(ts, tsconfigPath, {
      onProgress: emitProgress,
    });
    (result as MiniProjectMeasurement).typescriptSource = source;
    const json = JSON.stringify(result);
    if (outFile) {
      fs.writeFileSync(outFile, json);
    }
    process.stdout.write(json);
    process.exit(0);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
    );
    process.exit(1);
  }
}

void main();
