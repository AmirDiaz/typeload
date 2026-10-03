/**
 * TypeLoad extension entry.
 *
 * Spawns the measurement worker as a fresh Node process per run (clean,
 * comparable measurements), then surfaces results as CodeLens metrics and
 * a leaderboard webview.
 */

import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ProjectMeasurement } from "./analyzer/types";
import { TypeLensProvider } from "./codelens";
import { LeaderboardPanel } from "./ui/leaderboard";

interface State {
  measurement: ProjectMeasurement | null;
}

const globalState: State = { measurement: null };
let lensProvider: TypeLensProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
  lensProvider = new TypeLensProvider(globalState);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", language: "typescript" },
        { scheme: "file", language: "typescriptreact" },
      ],
      lensProvider
    ),
    vscode.commands.registerCommand("typeload.measureProject", async () => {
      const tsconfig = await pickTsconfig();
      if (!tsconfig) return;
      await runMeasurement(context, tsconfig);
    }),
    vscode.commands.registerCommand("typeload.showLeaderboard", () => {
      if (!globalState.measurement) {
        vscode.window.showInformationMessage(
          "TypeLoad: no measurement yet — run 'TypeLoad: Measure Project Types' first."
        );
        return;
      }
      LeaderboardPanel.createOrShow(context, globalState.measurement);
    }),
    vscode.commands.registerCommand("typeload.measureAtCursor", async () => {
      const tsconfig = await pickTsconfig();
      if (!tsconfig) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      // Re-measure the whole project in a fresh worker (isolated), then
      // filter to the declaration nearest the cursor.
      const m = await runMeasurement(context, tsconfig, { silent: true });
      if (!m) return;
      const file = editor.document.uri.fsPath;
      const line = editor.selection.active.line + 1;
      const inFile = m.decls
        .filter((d) => d.file === file)
        .sort(
          (a, b) => Math.abs(a.line - line) - Math.abs(b.line - line)
        );
      const nearest = inFile[0];
      if (!nearest) {
        vscode.window.showInformationMessage(
          "TypeLoad: no measured declaration at cursor."
        );
        return;
      }
      vscode.window
        .createOutputChannel("TypeLoad", { log: true })
        .appendLine(
          `${nearest.kind} "${nearest.name}" (${path.basename(
            nearest.file
          )}:${nearest.line}) — first touch ${nearest.firstTouchMs} ms, ` +
            `${nearest.instantiations} instantiations`
        );
      vscode.window.showInformationMessage(
        `"${nearest.name}": ${nearest.firstTouchMs} ms first-touch · ${nearest.instantiations} instantiations (see TypeLoad output)`
      );
    }),
    vscode.commands.registerCommand(
      "typeload.revealInLeaderboard",
      (file: string, line: number) => {
        if (!globalState.measurement) return;
        vscode.window.showTextDocument(vscode.Uri.file(file), {
          selection: new vscode.Range(line - 1, 0, line - 1, 0),
        });
      }
    )
  );
}

export function deactivate(): void {
  /* nothing persistent */
}

async function pickTsconfig(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const folders = vscode.workspace.workspaceFolders;
  const candidates: { label: string; path: string }[] = [];

  // tsconfigs in the workspace
  if (folders) {
    for (const f of folders) {
      const root = f.uri.fsPath;
      for (const name of ["tsconfig.json", "tsconfig.app.json"]) {
        const p = path.join(root, name);
        if (fs.existsSync(p)) {
          candidates.push({ label: path.relative(root, p) || name, path: p });
        }
      }
    }
  }
  // nearest tsconfig above the active file
  if (editor) {
    let dir = path.dirname(editor.document.uri.fsPath);
    for (let i = 0; i < 8 && dir; i++) {
      const p = path.join(dir, "tsconfig.json");
      if (fs.existsSync(p) && !candidates.some((c) => c.path === p)) {
        candidates.unshift({
          label: "(active file) " + path.basename(dir) + "/tsconfig.json",
          path: p,
        });
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  if (candidates.length === 0) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Select tsconfig.json",
      filters: { "TypeScript config": ["json"] },
    });
    return picked?.[0]?.fsPath;
  }
  if (candidates.length === 1) return candidates[0].path;
  const pick = await vscode.window.showQuickPick(
    candidates.map((c) => c.label),
    { placeHolder: "Which tsconfig should TypeLoad measure?" }
  );
  if (!pick) return undefined;
  return candidates.find((c) => c.label === pick)?.path;
}

async function runMeasurement(
  context: vscode.ExtensionContext,
  tsconfig: string,
  opts: { silent?: boolean } = {}
): Promise<ProjectMeasurement | null> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "TypeLoad: measuring types",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "starting worker…" });
      try {
        const m = await spawnWorker(context, tsconfig, (stage, detail) => {
          progress.report({
            message: `${stage}${detail ? ` — ${detail}` : ""}`,
          });
        });
        if ("error" in m) {
          if (!opts.silent) {
            vscode.window.showErrorMessage(
              `TypeLoad: measurement failed — ${m.error}`
            );
          }
          return null;
        }
        globalState.measurement = m;
        lensProvider?.refresh();
        const top = m.decls[0];
        if (!opts.silent) {
          vscode.window
            .showInformationMessage(
              `TypeLoad: measured ${m.decls.length} declarations · ` +
                `slowest: ${top ? `"${top.name}" ${top.firstTouchMs} ms` : "n/a"} · ` +
                `project check ${m.fullCheckMs.toFixed(0)} ms`,
              "Show leaderboard"
            )
            .then((choice) => {
              if (choice === "Show leaderboard") {
                LeaderboardPanel.createOrShow(context, m);
              }
            });
        }
        return m;
      } catch (err) {
        if (!opts.silent) {
          vscode.window.showErrorMessage(
            `TypeLoad: worker crashed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return null;
      }
    }
  );
}

function spawnWorker(
  context: vscode.ExtensionContext,
  tsconfig: string,
  onStage: (stage: string, detail?: string) => void
): Promise<ProjectMeasurement | ( { error: string } )> {
  return new Promise((resolve) => {
    const workerJs = path.join(context.extensionPath, "out", "analyzer", "worker.js");
    const outFile = path.join(os.tmpdir(), `typeload-${Date.now()}.json`);
    const maxBuffer =
      (vscode.workspace
        .getConfiguration("typeload")
        .get<number>("worker.maxBufferMb", 256)) *
      1024 *
      1024;

    const child = spawn(process.execPath, [workerJs, tsconfig, "--out", outFile], {
      cwd: path.dirname(tsconfig),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      // Progress lines are @@-prefixed NDJSON; the final result goes to
      // --out file (large) so stdout stays small.
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.startsWith("@@")) {
          try {
            const e = JSON.parse(line.slice(2));
            onStage(String(e.stage ?? ""), e.detail ? String(e.detail) : undefined);
          } catch {
            /* ignore malformed */
          }
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => resolve({ error: `spawn failed: ${err.message}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          error: `worker exited with ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
        });
        return;
      }
      try {
        const json = fs.readFileSync(outFile, "utf8");
        fs.unlinkSync(outFile);
        resolve(JSON.parse(json) as ProjectMeasurement);
      } catch (err) {
        resolve({
          error: `failed to read results: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
    void maxBuffer;
  });
}
