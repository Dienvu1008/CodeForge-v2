// extension.ts (P9.11 + P12.22 native UI) — the thin VS Code API edge. ONLY compiled by the
// extension's esbuild (never root tsc), because it imports `vscode`. All decision logic lives in
// the PURE modules (runtime-client, view-model, vscode-control-mapper), which ARE unit-tested
// under root vitest. This file just binds those to VS Code: three TreeViews (Sessions / Task
// Graph / Governance), a status-bar item, control + goal commands, and the dashboard webview.
//
// The extension stays a CLIENT of the runtime (INFRASTRUCTURE_SPEC §14): it reads over HTTP and
// controls via POST /control (OB-006, same ControlRequest shape as dashboard/Telegram). No
// authority, no runtime duplication.
import * as vscode from 'vscode';
import {
  commandToControlRequest, isControlCommand, type VscodeCommandId,
} from './vscode-control-mapper.js';
import { RuntimeClient, type ChangeView } from './runtime-client.js';
import {
  sessionNodes, taskGraphNodes, governanceNodes, changeNodes, statusBarText,
  findPendingApproval, approvalDetail, type ViewNode,
} from './view-model.js';

let runtimeUrl = 'http://127.0.0.1:9500';
let sessionId = '';
let client: RuntimeClient | null = null;

// ── A generic TreeDataProvider driven by a function that yields ViewNode[] ──────
class NodeTreeProvider implements vscode.TreeDataProvider<ViewNode> {
  private readonly _onDidChange = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private roots: readonly ViewNode[] = [];

  constructor(private readonly load: () => Promise<readonly ViewNode[]>) {}

  async refresh(): Promise<void> {
    this.roots = await this.load();
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    const hasKids = node.children !== undefined && node.children.length > 0;
    const item = new vscode.TreeItem(
      node.label,
      hasKids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    if (node.description !== undefined) item.description = node.description;
    if (node.tooltip !== undefined) item.tooltip = node.tooltip;
    if (node.iconId !== undefined) item.iconPath = new vscode.ThemeIcon(node.iconId);
    if (node.contextValue !== undefined) item.contextValue = node.contextValue;
    item.id = node.id;
    // A diffable change: clicking the item opens the native side-by-side diff.
    if (node.contextValue === 'change-diff' && node.value !== undefined) {
      item.command = { command: 'codeforge.viewDiff', title: 'View Change Diff', arguments: [node.value] };
    } else if (node.contextValue === 'session' && node.value !== undefined) {
      item.command = { command: 'codeforge.attachSession', title: 'Attach', arguments: [node] };
    }
    return item;
  }

  getChildren(node?: ViewNode): ViewNode[] {
    return node === undefined ? [...this.roots] : [...(node.children ?? [])];
  }
}

// Serves the before/after content of a change under the `codeforge-diff:` scheme so vscode.diff
// can render a native side-by-side editor without writing any temp files. URI shape:
//   codeforge-diff:/<toolCallId>/<before|after>/<encoded path>
const DIFF_SCHEME = 'codeforge-diff';
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly byKey = new Map<string, string>(); // "<toolCallId>/<side>" -> content
  put(toolCallId: string, before: string, after: string): void {
    this.byKey.set(toolCallId + '/before', before);
    this.byKey.set(toolCallId + '/after', after);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    // path = /<toolCallId>/<side>/<displayPath>
    const parts = uri.path.replace(/^\//, '').split('/');
    const key = parts[0] + '/' + parts[1];
    return this.byKey.get(key) ?? '';
  }
}
const diffProvider = new DiffContentProvider();

export function activate(context: vscode.ExtensionContext): void {
  // The extension host (Node 18+) provides a global fetch; the pure RuntimeClient accepts it via
  // its FetchLike port so the module stays testable with a fake under vitest.
  const makeClient = (): RuntimeClient => new RuntimeClient({ baseUrl: runtimeUrl, fetch: globalThis.fetch as never });
  client = makeClient();

  // Latest change transcript (kept so the diff command + content provider can resolve a id).
  let latestChanges: readonly ChangeView[] = [];

  // ── Tree providers ────────────────────────────────────────────────────────
  const sessionsProvider = new NodeTreeProvider(async () => sessionNodes(await (client as RuntimeClient).listSessions(), sessionId));
  const taskProvider = new NodeTreeProvider(async () => taskGraphNodes(sessionId ? await (client as RuntimeClient).getState(sessionId) : null));
  const govProvider = new NodeTreeProvider(async () => governanceNodes(sessionId ? await (client as RuntimeClient).getEvents(sessionId) : []));
  const changesProvider = new NodeTreeProvider(async () => {
    latestChanges = sessionId ? await (client as RuntimeClient).getChanges(sessionId) : [];
    // Keep the diff content provider primed for every diffable change.
    for (const c of latestChanges) {
      if (c.before !== undefined && c.after !== undefined) diffProvider.put(c.toolCallId, c.before, c.after);
    }
    return changeNodes(latestChanges);
  });

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('codeforge.sessions', sessionsProvider),
    vscode.window.registerTreeDataProvider('codeforge.taskGraph', taskProvider),
    vscode.window.registerTreeDataProvider('codeforge.changes', changesProvider),
    vscode.window.registerTreeDataProvider('codeforge.governance', govProvider),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
  );

  // ── Status bar ──────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'codeforge.dashboard';
  statusBar.text = statusBarText(null);
  statusBar.tooltip = 'CodeForge runtime — click to open the dashboard';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Remember which pending approval we have already prompted for, so the 2s poll does not re-pop
  // the same notification. Reset when the id clears (approved/denied/resolved).
  let notifiedApproval: string | null = null;

  const maybePromptApproval = async (): Promise<void> => {
    if (!sessionId || client === null) return;
    const events = await client.getEvents(sessionId);
    const pending = findPendingApproval(events);
    if (pending === null) { notifiedApproval = null; return; }
    if (pending === notifiedApproval) return; // already prompted for this one
    notifiedApproval = pending;
    const detail = approvalDetail(pending, latestChanges);
    const choice = await vscode.window.showWarningMessage(
      `CodeForge: approval needed — ${detail}`, { modal: false }, 'Approve', 'Deny',
    );
    if (choice === 'Approve' || choice === 'Deny') {
      const intent = choice === 'Approve' ? 'approve' : 'deny';
      const res = await client.postControl({ intent, sessionId, toolCallId: pending, requestedBy: { kind: 'user', id: 'vscode-user', surface: 'vscode' } });
      vscode.window.showInformationMessage(`CodeForge ${intent}: ${res.admission?.admitted ? 'admitted' : 'rejected (' + (res.admission?.reason ?? '?') + ')'}`);
      await refreshAll();
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([sessionsProvider.refresh(), taskProvider.refresh(), changesProvider.refresh(), govProvider.refresh()]);
    const st = sessionId && client ? await client.getState(sessionId) : null;
    statusBar.text = statusBarText(st);
    void maybePromptApproval();
  };

  // Poll the runtime periodically so the views stay live (SSE streaming is a Step-3 refinement).
  const timer = setInterval(() => { void refreshAll(); }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // ── Connect: set runtime URL + session id ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.connect', async () => {
      const url = await vscode.window.showInputBox({ prompt: 'Runtime URL', value: runtimeUrl });
      if (url !== undefined && url !== '') { runtimeUrl = url; client = makeClient(); }
      // Offer to attach a session from the live list (falls back to manual entry).
      const sessions = await (client as RuntimeClient).listSessions();
      const pick = sessions.length > 0
        ? await vscode.window.showQuickPick(sessions.map((s) => ({ label: s.sessionId, description: s.state })), { placeHolder: 'Attach to a session' })
        : undefined;
      const sid = pick?.label ?? await vscode.window.showInputBox({ prompt: 'Session ID', value: sessionId });
      if (sid !== undefined) sessionId = sid;
      await refreshAll();
      vscode.window.showInformationMessage(`CodeForge: ${runtimeUrl}${sessionId ? ' · session ' + sessionId : ''}`);
    }),
    vscode.commands.registerCommand('codeforge.refresh', () => { void refreshAll(); }),
    vscode.commands.registerCommand('codeforge.attachSession', async (node?: ViewNode) => {
      if (node?.value) { sessionId = node.value; await refreshAll(); vscode.window.showInformationMessage(`CodeForge: attached to ${sessionId}`); }
    }),
    vscode.commands.registerCommand('codeforge.viewDiff', async (toolCallId?: string) => {
      if (toolCallId === undefined) return;
      const c = latestChanges.find((x) => x.toolCallId === toolCallId);
      if (c === undefined || c.before === undefined || c.after === undefined) {
        vscode.window.showInformationMessage('CodeForge: this change has no side-by-side diff.');
        return;
      }
      const name = c.path ?? c.toolCallId;
      // Virtual before/after docs under codeforge-diff: — vscode.diff renders a native editor.
      const left = vscode.Uri.parse(`${DIFF_SCHEME}:/${toolCallId}/before/${encodeURIComponent(name)}`);
      const right = vscode.Uri.parse(`${DIFF_SCHEME}:/${toolCallId}/after/${encodeURIComponent(name)}`);
      await vscode.commands.executeCommand('vscode.diff', left, right, `CodeForge: ${name} (${c.kind})`);
    }),
    vscode.commands.registerCommand('codeforge.submitGoal', async () => {
      if (client === null) return;
      const desc = await vscode.window.showInputBox({ prompt: 'Describe a goal for the runtime' });
      if (desc === undefined || desc.trim() === '') return;
      const res = await client.postGoal(desc.trim());
      vscode.window.showInformationMessage(res?.goalId ? `CodeForge: goal queued (${res.goalId})` : `CodeForge: goal submit ${res?.error ?? 'failed'}`);
    }),
  );

  // ── Dashboard webview (kept as a secondary view) ───────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.dashboard', () => {
      const panel = vscode.window.createWebviewPanel('codeforge', 'CodeForge Dashboard', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [] });
      panel.webview.html = getDashboardHtml(runtimeUrl, sessionId);
    }),
  );

  // ── Control commands (pause/resume/cancel/checkpoint) ──────────────────────
  for (const cmd of ['codeforge.pause', 'codeforge.resume', 'codeforge.cancel', 'codeforge.checkpoint'] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, async () => {
        if (sessionId === '' || client === null) { vscode.window.showWarningMessage('CodeForge: no session connected. Run "CodeForge: Connect".'); return; }
        if (!isControlCommand(cmd)) return;
        const request = commandToControlRequest(cmd as VscodeCommandId, sessionId);
        try {
          const res = await client.postControl(request);
          const ok = res.admission?.admitted;
          vscode.window.showInformationMessage(`CodeForge ${request.intent}: ${ok ? `admitted (${res.record?.result ?? 'ok'})` : `rejected (${res.admission?.reason ?? '?'})`}`);
          await refreshAll();
        } catch (err) {
          vscode.window.showErrorMessage(`CodeForge: ${err instanceof Error ? err.message : 'network error'}`);
        }
      }),
    );
  }

  void refreshAll();
}

export function deactivate(): void {
  // nothing to clean up — all authoritative state lives on the runtime
}

/** A minimal webview HTML that loads the dashboard from the runtime's HTTP server (iframe). */
function getDashboardHtml(url: string, sid: string): string {
  const csp = `default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>body{margin:0;padding:0;overflow:hidden} iframe{width:100%;height:100vh;border:none}</style>
</head>
<body>
<iframe src="${url}/?session=${encodeURIComponent(sid)}"></iframe>
</body>
</html>`;
}
