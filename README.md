# TypeLoad

**Real type load-time analytics for TypeScript — measured inside the compiler, not guessed from strings.**

TypeLoad answers one question precisely: *what does each type in your project actually cost the type checker?*

- **First-touch time (ms)** — wall-clock cost of resolving a declaration's type the first time the checker touches it.
- **Checker instantiations** — how many type instantiations the declaration triggered (the compiler's own counter, exposed by the TS 5.x checker API).
- **Types created** — how many distinct types the checker had to materialise.

All three come from the TypeScript compiler API itself. There is no proxy measurement and no string heuristics.

## Why this is different

Existing tools either time language-service responses (noisy, includes editor overhead) or score "complexity" by counting characters, unions and nesting in the rendered type string (a proxy that ignores caching, laziness and aliasing). TypeLoad drives the project's **own** TypeScript version in a fresh process and reads the checker's real counters around each declaration's first resolution — the same technique used by `@definitelytyped/perf` to find the slowest types in DefinitelyTyped.

Attribution semantics: a declaration's first-touch cost is the time and instantiation delta of the *first* `getTypeAtLocation` on it in a fresh program. Shared prerequisites (already resolved via an earlier declaration) are not double-counted; what you see is the marginal cost of introducing that declaration to the checker — exactly what you feel when a file is opened or a build cold-starts.

## Features

- `TypeLoad: Measure Project Types` — measures every type alias, interface, class, enum, function, method, typed property and typed variable in the project.
- **CodeLens** above each declaration: `⚡ 6.8 ms · 161 inst · 130 types`.
- `TypeLoad: Show Slowest Types` — leaderboard webview with ranked declarations, per-file aggregates, click-to-jump.
- `TypeLoad: Measure Type at Cursor (isolated)` — re-measures the project fresh and reports the declaration nearest your cursor.
- Runs the measurement in a **fresh worker process** so runs are comparable and nothing pollutes your editor's language service.
- Uses the **project's own TypeScript** from `node_modules` when present (version-accurate results); falls back to bundled TypeScript.
- Progress streaming, cancellable-safe, no editor slowdown when idle.

## Install

```bash
# from source
git clone https://github.com/AmirDiaz/typeload
cd typeload
npm install
npm run compile
# then open in VS Code with the Extension Development Host:
#   code --extensionDevelopmentPath=$(pwd)
```

## Usage

1. Open a TypeScript project.
2. Run **TypeLoad: Measure Project Types** from the command palette.
3. Pick a `tsconfig.json` if you have several.
4. Read the CodeLens metrics in the editor, or open **TypeLoad: Show Slowest Types** for the leaderboard.

## How it works

```
VS Code extension          worker process (fresh node)
      │                            │
      │ spawn ────────────────────►│ resolve project's typescript
      │                            │ create LanguageService
      │                            │ collect declarations (AST walk)
      │ @@progress NDJSON ◄────────│ first-touch sweep:
      │                            │   for each declaration:
      │                            │     t0 = hrtime()
      │                            │     checker.getTypeAtLocation(node)
      │                            │     dt, Δinstantiations, Δtypes
      │                            │ force full semantic check
      │ final JSON ◄───────────────│ write results
```

The first-touch sweep never calls the checker before it starts, so the first `getTypeAtLocation` per declaration is genuinely its first materialisation. The forced full check afterwards gives project-level context (`fullCheckMs`, total instantiations) and validates the sweep.

## Configuration

| Setting | Default | Meaning |
|---|---|---|
| `typeload.codeLens.enabled` | `true` | Show per-declaration CodeLens after a measurement. |
| `typeload.codeLens.thresholdMs` | `0` | Only show CodeLens for declarations costing at least this much. |
| `typeload.codeLens.topPerFile` | `5` | At most this many CodeLens entries per file. |
| `typeload.worker.maxBufferMb` | `256` | Worker stdout buffer cap. |

## Development

```bash
npm install
npm run compile     # tsc -> out/
npm test            # node --test test/ — engine + worker CLI tests
```

The measurement engine (`src/analyzer/measure.ts`) is plain Node with **zero VS Code imports**, so it is fully testable headlessly — `test/engine.test.mjs` runs it against `client/`, a showcase project full of deliberately expensive types (deep conditional chains, recursive flatteners, wide intersections, literal-template unions).

## Credits

- Technique inspired by `@definitelytyped/perf` (Microsoft).
- Built for the [TSPerf challenge](https://algora.io/challenges/tsperf) on Algora.

## License

[MIT](./LICENSE)
