/**
 * CodeLens provider: shows the measured first-touch cost above each
 * declaration that was measured in the latest run.
 */

import * as vscode from "vscode";
import { ProjectMeasurement } from "./analyzer/types";

interface State {
  measurement: ProjectMeasurement | null;
}

export class TypeLensProvider implements vscode.CodeLensProvider {
  private readonly state: State;
  private readonly emitter = new vscode.EventEmitter<void>();

  public readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(state: State) {
    this.state = state;
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public provideCodeLenses(
    document: vscode.TextDocument
  ): vscode.CodeLens[] {
    const m = this.state.measurement;
    if (!m) return [];

    const cfg = vscode.workspace.getConfiguration("typeload");
    if (!cfg.get<boolean>("codeLens.enabled", true)) return [];
    const thresholdMs = cfg.get<number>("codeLens.thresholdMs", 0);
    const topPerFile = cfg.get<number>("codeLens.topPerFile", 5);

    const file = document.uri.fsPath;
    const decls = m.decls
      .filter((d) => d.file === file)
      .filter((d) => d.firstTouchMs >= thresholdMs)
      .slice(0, Math.max(0, topPerFile));

    const lenses: vscode.CodeLens[] = [];
    for (const d of decls) {
      const range = new vscode.Range(
        Math.max(0, d.line - 1),
        Math.max(0, d.col - 1),
        Math.max(0, d.line - 1),
        Math.max(0, d.col - 1)
      );
      lenses.push(
        new vscode.CodeLens(range, {
          title:
            `⚡ ${fmtMs(d.firstTouchMs)} · ${fmtInst(d.instantiations)} inst · ${fmtInst(d.typesCreated)} types` +
            (d.exported ? " · exported" : ""),
          command: "typeload.revealInLeaderboard",
          tooltip: `${d.kind} "${d.name}" — first-touch ${d.firstTouchMs} ms, ${d.instantiations} checker instantiations, ${d.typesCreated} types created`,
          arguments: [d.file, d.line],
        })
      );
    }
    return lenses;
  }
}

function fmtMs(ms: number): string {
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms * 1000)} µs`;
}

function fmtInst(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}
