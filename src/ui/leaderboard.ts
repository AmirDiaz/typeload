/**
 * Leaderboard webview: ranked slowest declarations + per-file aggregates,
 * with click-to-jump back into the editor.
 */

import * as vscode from "vscode";
import * as path from "path";
import { ProjectMeasurement } from "../analyzer/types";

export class LeaderboardPanel {
  private static panel: vscode.WebviewPanel | null = null;

  public static createOrShow(
    context: vscode.ExtensionContext,
    m: ProjectMeasurement
  ): void {
    if (LeaderboardPanel.panel) {
      LeaderboardPanel.panel.reveal();
      LeaderboardPanel.panel.webview.html = LeaderboardPanel.html(m);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "typeloadLeaderboard",
      "TypeLoad — slowest types",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    panel.webview.html = LeaderboardPanel.html(m);
    panel.webview.onDidReceiveMessage(
      (msg: { file: string; line: number }) => {
        if (msg && typeof msg.file === "string") {
          vscode.window.showTextDocument(vscode.Uri.file(msg.file), {
            selection: new vscode.Range(
              Math.max(0, msg.line - 1),
              0,
              Math.max(0, msg.line - 1),
              0
            ),
          });
        }
      },
      undefined,
      context.subscriptions
    );
    panel.onDidDispose(() => {
      LeaderboardPanel.panel = null;
    });
    LeaderboardPanel.panel = panel;
  }

  private static html(m: ProjectMeasurement): string {
    const esc = (s: string): string =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const fmtMs = (ms: number): string =>
      ms >= 100
        ? `${Math.round(ms)} ms`
        : ms >= 1
          ? `${ms.toFixed(1)} ms`
          : `${Math.round(ms * 1000)} µs`;

    const declRows = m.decls
      .slice(0, 200)
      .map(
        (d, i) => `
        <tr data-file="${esc(d.file)}" data-line="${d.line}">
          <td class="rank">${i + 1}</td>
          <td class="name"><span class="kind">${esc(d.kind)}</span> <b>${esc(d.name)}</b>
            <div class="loc">${esc(shortPath(d.file))}:${d.line}</div></td>
          <td class="num">${fmtMs(d.firstTouchMs)}</td>
          <td class="num">${d.instantiations.toLocaleString()}</td>
          <td class="num">${d.typesCreated.toLocaleString()}</td>
        </tr>`
      )
      .join("");

    const fileRows = m.files
      .slice(0, 50)
      .map(
        (f, i) => `
        <tr data-file="${esc(f.file)}" data-line="1">
          <td class="rank">${i + 1}</td>
          <td class="name"><b>${esc(shortPath(f.file))}</b>
            <div class="loc">${f.declCount} declarations · worst: ${esc(f.worst ?? "—")}</div></td>
          <td class="num">${fmtMs(f.firstTouchMs)}</td>
          <td class="num">${f.instantiations.toLocaleString()}</td>
          <td class="num"></td>
        </tr>`
      )
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 0 0 60px 0; margin: 0; }
  header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border);
           display: flex; gap: 18px; align-items: baseline; flex-wrap: wrap; }
  h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  h2 { font-size: 13px; margin: 18px 18px 6px; font-weight: 600;
       text-transform: uppercase; letter-spacing: .04em; opacity: .85; }
  table { border-collapse: collapse; width: calc(100% - 36px); margin: 0 18px; }
  th, td { text-align: left; padding: 5px 10px; font-size: 12.5px; }
  th { color: var(--vscode-descriptionForeground); font-weight: 500;
       border-bottom: 1px solid var(--vscode-panel-border); }
  tr:hover td { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.rank { color: var(--vscode-descriptionForeground); width: 34px; }
  .loc { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; }
  .kind { opacity: .75; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  .summary { display: flex; gap: 26px; }
  .summary div span { display: block; color: var(--vscode-descriptionForeground);
                      font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .summary div b { font-size: 15px; }
</style>
</head>
<body>
<header>
  <h1>TypeLoad</h1>
  <div class="meta">
    TS ${esc(m.typescriptVersion)} (${esc(m.typescriptSource)}) ·
    ${m.inputFiles} input files · measured ${new Date(m.measuredAt).toLocaleString()}
  </div>
  <div class="summary">
    <div><span>first-touch sweep</span><b>${fmtMs(m.sweepMs)}</b></div>
    <div><span>full check</span><b>${fmtMs(m.fullCheckMs)}</b></div>
    <div><span>instantiations</span><b>${m.totalInstantiations.toLocaleString()}</b></div>
  </div>
</header>

<h2>Slowest declarations (first-touch cost)</h2>
<table id="decls">
  <thead><tr><th></th><th>declaration</th><th style="text-align:right">first touch</th>
  <th style="text-align:right">instantiations</th><th style="text-align:right">types created</th></tr></thead>
  <tbody>${declRows}</tbody>
</table>

<h2>Heaviest files</h2>
<table id="files">
  <thead><tr><th></th><th>file</th><th style="text-align:right">sum first touch</th>
  <th style="text-align:right">instantiations</th><th style="text-align:right"></th></tr></thead>
  <tbody>${fileRows}</tbody>
</table>

<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll("tr[data-file]").forEach((tr) => {
    tr.addEventListener("click", () => {
      vscode.postMessage({ file: tr.dataset.file, line: Number(tr.dataset.line) });
    });
  });
</script>
</body>
</html>`;
  }
}

function shortPath(p: string): string {
  const parts = p.split(/[\\\\/]/);
  return parts.slice(-2).join("/");
}
