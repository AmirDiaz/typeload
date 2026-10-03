/**
 * TypeLoad measurement engine.
 *
 * Measures the REAL cost of each type declaration in a TypeScript project by
 * driving the project's own TypeScript compiler API in-process:
 *
 *  1. Create a fresh LanguageService for the project tsconfig.
 *  2. Walk the AST and collect interesting declarations.
 *  3. For each declaration, call the checker for its type for the FIRST time,
 *     measuring elapsed wall time and the checker's global instantiation
 *     counter delta. This is the declaration's "first-touch" cost: the
 *     price the checker pays the first time this type is materialised.
 *  4. Force a full semantic check and time it, for project-level context.
 *
 * The engine never imports `typescript` directly: the module is injected so
 * the worker can use the version from the target project's node_modules,
 * which keeps measurements version-accurate.
 */

import type * as TsTypes from "typescript";
import {
  DeclMeasurement,
  FileMeasurement,
  ProjectMeasurement,
  ProgressEvent,
} from "./types";

type TS = typeof TsTypes;

export interface MeasureOptions {
  /** Emit progress events (called synchronously from the engine). */
  onProgress?: (e: ProgressEvent) => void;
  /** Skip measurement of declarations in declaration files. Default true. */
  skipDeclarationFiles?: boolean;
  /** Hard cap on measured declarations per run (safety). Default 100000. */
  maxDeclarations?: number;
}

interface CollectedDecl {
  source: TsTypes.SourceFile;
  node: TsTypes.Node;
  name: string;
  kind: string;
  exported: boolean;
}

const KIND_LABELS: Record<string, string> = {
  TypeAliasDeclaration: "type alias",
  InterfaceDeclaration: "interface",
  ClassDeclaration: "class",
  FunctionDeclaration: "function",
  MethodDeclaration: "method",
  PropertyDeclaration: "property",
  PropertySignature: "property",
  VariableStatement: "variable",
  EnumDeclaration: "enum",
};

function kindLabel(ts: TS, node: TsTypes.Node): string {
  const name = ts.SyntaxKind[node.kind] as unknown as string;
  return KIND_LABELS[name] ?? name.toLowerCase();
}

/** Best-effort export detection: looks for an `export` modifier on the
 *  statement owning the declaration. */
function isExported(ts: TS, node: TsTypes.Node): boolean {
  let n: TsTypes.Node = node;
  // climb to the statement level
  while (n.parent && n.parent.kind !== ts.SyntaxKind.SourceFile) {
    n = n.parent;
  }
  const mods = (n as unknown as { modifiers?: TsTypes.Node[] }).modifiers;
  if (
    Array.isArray(mods) &&
    mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    return true;
  }
  // `export default function f` etc.
  const flags = (n as unknown as { flags?: number }).flags;
  return flags !== undefined && (flags & ts.NodeFlags.ExportContext) !== 0;
}

/** Collect declarations worth measuring from a source file. */
export function collectDeclarations(
  ts: TS,
  source: TsTypes.SourceFile,
  max: number,
  out: CollectedDecl[]
): void {
  const visit = (node: TsTypes.Node): void => {
    if (out.length >= max) return;
    switch (node.kind) {
      case ts.SyntaxKind.TypeAliasDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.FunctionDeclaration: {
        const named = node as TsTypes.NamedDeclaration;
        if (named.name && ts.isIdentifier(named.name)) {
          out.push({
            source,
            node,
            name: named.name.text,
            kind: kindLabel(ts, node),
            exported: isExported(ts, node),
          });
        }
        break;
      }
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.PropertySignature: {
        const named = node as TsTypes.NamedDeclaration;
        if (
          named.name &&
          ts.isIdentifier(named.name) &&
          (node as TsTypes.HasType).type
        ) {
          out.push({
            source,
            node,
            name: named.name.text,
            kind: kindLabel(ts, node),
            exported: isExported(ts, node),
          });
        }
        break;
      }
      case ts.SyntaxKind.VariableStatement: {
        const vs = node as TsTypes.VariableStatement;
        const hasType = vs.declarationList.declarations.some((d) => d.type);
        const firstName = vs.declarationList.declarations.find((d) =>
          ts.isIdentifier(d.name)
        )?.name as TsTypes.Identifier | undefined;
        if (hasType && firstName) {
          out.push({
            source,
            node: vs,
            name: firstName.text,
            kind: "variable",
            exported: isExported(ts, node),
          });
        }
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function now(): number {
  return Number(process.hrtime.bigint()) / 1e6; // ms with sub-ms precision
}

/**
 * Run the full measurement. Throws on unrecoverable errors.
 */
export function measureProject(
  ts: TS,
  tsconfigPath: string,
  opts: MeasureOptions = {}
): ProjectMeasurement {
  const onProgress = opts.onProgress ?? (() => undefined);
  const skipDeclFiles = opts.skipDeclarationFiles ?? true;
  const maxDeclarations = opts.maxDeclarations ?? 100000;

  // ---------- 1. parse config ----------
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    throw new Error(
      `tsconfig parse error: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config ?? {},
    ts.sys as unknown as TsTypes.ParseConfigHost,
    dirnameOf(tsconfigPath)
  );
  if (parsed.errors.length > 0 && !parsed.options) {
    throw new Error(
      `tsconfig errors: ${parsed.errors
        .map((e) => ts.flattenDiagnosticMessageText(e.messageText, " "))
        .join("; ")}`
    );
  }

  // ---------- 2. language service ----------
  const fileContents = new Map<string, string>();
  for (const f of parsed.fileNames) {
    fileContents.set(f, ts.sys.readFile(f) ?? "");
  }
  const lsHost: TsTypes.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...fileContents.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => {
      let text = fileContents.get(f);
      if (text === undefined) {
        text = ts.sys.readFile(f) ?? undefined;
        if (text !== undefined) fileContents.set(f, text);
      }
      return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
    },
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getDirectories: (p) => ts.sys.getDirectories(p),
    fileExists: (p) => ts.sys.fileExists(p),
    readFile: (p) => ts.sys.readFile(p),
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  };

  onProgress({ stage: "program", detail: `${fileContents.size} files` });
  const tProgram0 = now();
  const ls = ts.createLanguageService(
    lsHost,
    undefined,
    ts.LanguageServiceMode.Semantic
  );
  const program = ls.getProgram();
  if (!program) throw new Error("failed to create program");
  const checker = program.getTypeChecker() as TsTypes.TypeChecker & {
    instantiationCount?: number;
  };
  void checker; // referenced below via getInstCount
  const programMs = now() - tProgram0;

  const sourceFiles = program
    .getSourceFiles()
    .filter((f) => !skipDeclFiles || !f.isDeclarationFile)
    .filter((f) => f.fileName.indexOf("node_modules") === -1)
    .sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
  const inputFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile).length;

  // ---------- 3. collect declarations ----------
  onProgress({ stage: "collect" });
  const decls: CollectedDecl[] = [];
  for (const sf of sourceFiles) {
    collectDeclarations(ts, sf, maxDeclarations - decls.length, decls);
    if (decls.length >= maxDeclarations) break;
  }

  // ---------- 4. first-touch sweep ----------
  onProgress({ stage: "sweep", detail: `${decls.length} declarations` });
  const tSweep0 = now();
  const results: DeclMeasurement[] = [];
  // TS 5.x exposes getInstantiationCount()/getTypeCount(); older builds
  // exposed them as plain properties. Support both.
  const counters = (): { inst: number; types: number } => {
    const c = program.getTypeChecker() as unknown as {
      getInstantiationCount?: () => number;
      getTypeCount?: () => number;
      instantiationCount?: number;
    };
    return {
      inst: typeof c.getInstantiationCount === "function"
        ? c.getInstantiationCount()
        : (c.instantiationCount ?? 0),
      types: typeof c.getTypeCount === "function" ? c.getTypeCount() : 0,
    };
  };

  let done = 0;
  for (const d of decls) {
    const before = counters();
    const t0 = now();
    try {
      // Resolve the type of the declaration. For callables we also resolve
      // signatures because signature resolution is where the checker spends
      // most of its time for functions and methods.
      program.getTypeChecker().getTypeAtLocation(d.node);
      if (
        d.node.kind === ts.SyntaxKind.FunctionDeclaration ||
        d.node.kind === ts.SyntaxKind.MethodDeclaration
      ) {
        const checker2 = program.getTypeChecker();
        const sym = checker2.getSymbolAtLocation(
          (d.node as TsTypes.NamedDeclaration).name ?? d.node
        );
        if (sym) {
          checker2.getSignaturesOfType(
            checker2.getTypeOfSymbolAtLocation(sym, d.node),
            ts.SignatureKind.Call
          );
        }
      }
    } catch {
      // A declaration that cannot be resolved in isolation is recorded
      // with zero cost rather than aborting the sweep.
    }
    const dt = now() - t0;
    const after = counters();
    const inst = after.inst - before.inst;
    const created = after.types - before.types;

    const pos = d.node.getStart(d.source, false);
    const { line, character } = d.source.getLineAndCharacterOfPosition(pos);
    results.push({
      file: d.source.fileName,
      line: line + 1,
      col: character + 1,
      name: d.name,
      kind: d.kind,
      firstTouchMs: Math.round(dt * 1000) / 1000,
      instantiations: inst,
      typesCreated: created,
      exported: d.exported,
    });
    done++;
    if (done % 200 === 0) {
      onProgress({
        stage: "sweep",
        detail: `${done}/${decls.length}`,
        fraction: done / decls.length,
      });
    }
  }
  const sweepMs = now() - tSweep0;

  // ---------- 5. forced full check ----------
  onProgress({ stage: "fullcheck" });
  const tCheck0 = now();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    program.getSemanticDiagnostics(sf);
  }
  const fullCheckMs = now() - tCheck0;
  const totalInstantiations = counters().inst;

  // ---------- 6. aggregate ----------
  const perFile = new Map<string, FileMeasurement>();
  const worstCost = new Map<string, number>();
  for (const r of results) {
    let agg = perFile.get(r.file);
    if (!agg) {
      agg = {
        file: r.file,
        declCount: 0,
        firstTouchMs: 0,
        instantiations: 0,
        worst: null,
      };
      perFile.set(r.file, agg);
    }
    agg.declCount++;
    agg.firstTouchMs += r.firstTouchMs;
    agg.instantiations += r.instantiations;
    if (r.firstTouchMs > (worstCost.get(r.file) ?? 0)) {
      worstCost.set(r.file, r.firstTouchMs);
      agg.worst = r.name;
    }
  }
  const fileAggs = [...perFile.values()]
    .map((f) => ({
      ...f,
      firstTouchMs: Math.round(f.firstTouchMs * 1000) / 1000,
    }))
    .sort((a, b) => b.firstTouchMs - a.firstTouchMs);

  results.sort((a, b) => b.firstTouchMs - a.firstTouchMs);

  onProgress({ stage: "done", detail: `${results.length} measured` });
  return {
    tsconfig: tsconfigPath,
    typescriptVersion: ts.version,
    typescriptSource: "project",
    inputFiles,
    totalInstantiations,
    programMs: Math.round(programMs * 1000) / 1000,
    sweepMs: Math.round(sweepMs * 1000) / 1000,
    fullCheckMs: Math.round(fullCheckMs * 1000) / 1000,
    decls: results,
    files: fileAggs,
    measuredAt: new Date().toISOString(),
  };
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : ".";
}
