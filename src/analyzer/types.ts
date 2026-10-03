/**
 * Shared result types for TypeLoad measurements.
 * Used by both the worker (plain Node) and the VSCode extension glue.
 */

export interface DeclMeasurement {
  /** Absolute path of the containing file. */
  file: string;
  /** 1-based line of the declaration name. */
  line: number;
  /** 1-based column of the declaration name. */
  col: number;
  /** Best-effort symbol name. */
  name: string;
  /** Syntax kind label, e.g. "type alias", "interface", "function". */
  kind: string;
  /** Milliseconds for the first resolution of this declaration's type. */
  firstTouchMs: number;
  /** Checker instantiation delta across the first touch. */
  instantiations: number;
  /** Distinct types created by the checker across the first touch. */
  typesCreated: number;
  /** True when the declaration is exported from its file. */
  exported: boolean;
}

export interface FileMeasurement {
  file: string;
  declCount: number;
  /** Sum of first-touch costs in this file. */
  firstTouchMs: number;
  instantiations: number;
  worst: string | null;
}

export interface ProjectMeasurement {
  /** tsconfig path used. */
  tsconfig: string;
  /** TypeScript version used for measurement. */
  typescriptVersion: string;
  /** How the TypeScript module was resolved. */
  typescriptSource: "project" | "bundled";
  /** Number of source files in the program (input files, not .d.ts). */
  inputFiles: number;
  /** Total checker instantiations after the full check. */
  totalInstantiations: number;
  /** Milliseconds spent creating the program (parse + bind). */
  programMs: number;
  /** Milliseconds spent on the declaration first-touch sweep. */
  sweepMs: number;
  /** Milliseconds for the forced full semantic check (after sweep). */
  fullCheckMs: number;
  /** Per-declaration measurements, sorted by firstTouchMs desc. */
  decls: DeclMeasurement[];
  /** Per-file aggregates, sorted by firstTouchMs desc. */
  files: FileMeasurement[];
  /** ISO timestamp of measurement. */
  measuredAt: string;
}

export interface ProgressEvent {
  stage:
    | "resolve-ts"
    | "program"
    | "collect"
    | "sweep"
    | "fullcheck"
    | "done";
  detail?: string;
  /** 0..1 when meaningful. */
  fraction?: number;
}
