/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

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
import { spawn, type ChildProcess } from 'node:child_process';
import {
  commandToControlRequest, isControlCommand, type VscodeCommandId,
} from './vscode-control-mapper.js';
import { RuntimeClient, type ChangeView } from './runtime-client.js';
import {
  sessionNodes, taskGraphNodes, governanceNodes, changeNodes, statusBarText,
  findPendingApproval, approvalDetail, type ViewNode,
} from './view-model.js';
import {
  resolveRuntimeEntry, buildRuntimeArgv, runtimeUrlForPort, resolveNodeCommand,
} from './runtime-launch.js';
import {
  newGoalEntry, withGoalId, reconcileHistory, type GoalEntry,
} from './goal-history.js';
import { goalsPanelHtml, type GoalEntryView } from './goals-webview.js';

let runtimeUrl = 'http://127.0.0.1:9500';
let sessionId = '';
let client: RuntimeClient | null = null;

// The runtime child process started by "Start Runtime Here" (null when we did not spawn one).
let runtimeProc: ChildProcess | null = null;
let runtimeOutput: vscode.OutputChannel | null = null;

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
  try {
    activateInner(context);
  } catch (err) {
    // Surface activation failures instead of a silent "no data provider" view.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    vscode.window.showErrorMessage(`CodeForge extension failed to activate: ${msg}`);
    const out = vscode.window.createOutputChannel('CodeForge');
    out.appendLine('activation error:\n' + msg);
    out.show(true);
  }
}

function activateInner(context: vscode.ExtensionContext): void {
  // The extension host (Node 18+) provides a global fetch; the pure RuntimeClient accepts it via
  // its FetchLike port so the module stays testable with a fake under vitest.
  const makeClient = (): RuntimeClient => new RuntimeClient({ baseUrl: runtimeUrl, fetch: globalThis.fetch as never });
  client = makeClient();

  // Latest change transcript (kept so the diff command + content provider can resolve a id).
  let latestChanges: readonly ChangeView[] = [];

  // ── Goals panel state ──────────────────────────────────────────────────────
  // Conversational history of goals the user submitted. Persisted across reloads via globalState
  // so the "chat" survives window reloads (the authoritative record still lives in the runtime DB;
  // this is just the local view binding goals→sessions).
  let goalHistory: GoalEntry[] = context.globalState.get<GoalEntry[]>('codeforge.goalHistory', []);
  let localIdSeq = goalHistory.length;
  let goalsPanel: vscode.WebviewPanel | null = null;

  const toEntryView = (e: GoalEntry): GoalEntryView => ({
    localId: e.localId, description: e.description, submittedAt: e.submittedAt,
    status: e.status, sessionId: e.sessionId, goalId: e.goalId,
  });

  const pushGoalsToPanel = (connected: boolean): void => {
    if (goalsPanel === null) return;
    void goalsPanel.webview.postMessage({
      type: 'history', entries: goalHistory.map(toEntryView), connected, url: runtimeUrl,
    });
  };

  const persistGoals = (): void => { void context.globalState.update('codeforge.goalHistory', goalHistory); };

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

    // Reconcile the Goals history against live sessions, then push to the panel if open.
    if (goalsPanel !== null && client !== null) {
      const sessions = await client.listSessions();
      const connected = sessions.length > 0 || (await client.health());
      const next = reconcileHistory(goalHistory, sessions);
      // Only persist/repaint when something actually changed (avoid churn every 2s).
      if (JSON.stringify(next) !== JSON.stringify(goalHistory)) {
        goalHistory = next;
        persistGoals();
      }
      pushGoalsToPanel(connected);
    }
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

  // ── Goals webview panel (conversational history of goals + live status) ─────
  const openGoalsPanel = (): void => {
    if (goalsPanel !== null) { goalsPanel.reveal(vscode.ViewColumn.Beside); return; }
    const panel = vscode.window.createWebviewPanel(
      'codeforge.goals', 'CodeForge Goals', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    goalsPanel = panel;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    panel.webview.html = goalsPanelHtml(nonce);
    panel.onDidDispose(() => { goalsPanel = null; }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (m: { type?: string; description?: string }) => {
      if (m.type === 'ready') { void refreshAll(); return; }
      if (m.type === 'submit' && typeof m.description === 'string') {
        const desc = m.description.trim();
        if (desc === '' || client === null) return;
        // Optimistically add the goal to the history, then confirm with the runtime.
        const entry = newGoalEntry(`g${++localIdSeq}`, desc, new Date().toISOString());
        goalHistory = [...goalHistory, entry];
        persistGoals();
        pushGoalsToPanel(true);
        const res = await client.postGoal(desc);
        if (res?.goalId) {
          goalHistory = goalHistory.map((e) => (e.localId === entry.localId ? withGoalId(e, res.goalId as string) : e));
          persistGoals();
        } else {
          vscode.window.showErrorMessage(
            `CodeForge: goal submit failed — ${res?.error ?? `cannot reach runtime at ${runtimeUrl}`}. Run "CodeForge: Start Runtime Here" or start a runtime on :9500.`,
          );
        }
        await refreshAll();
      }
    }, null, context.subscriptions);
  };
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.goals', openGoalsPanel));

  // ── Model picker ────────────────────────────────────────────────────────────
  // When a runtime is reachable we list its installed models via GET /models; otherwise we fall
  // back to a free-text entry (so the user can still pick a model BEFORE spawning a runtime).
  const pickModel = async (): Promise<string | undefined> => {
    const models = client !== null ? await client.getModels() : [];
    if (models.length > 0) {
      const pick = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m.name, description: [m.parameterSize, m.quantization].filter(Boolean).join(' · ') })),
        { placeHolder: 'Select a model for the runtime' },
      );
      return pick?.label;
    }
    return vscode.window.showInputBox({
      prompt: 'Model id (runtime not reachable to list — enter one, e.g. qwen2.5-coder:latest)',
      value: vscode.workspace.getConfiguration('codeforge').get<string>('model', 'qwen2.5-coder:latest'),
    });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.pickModel', async () => {
      const model = await pickModel();
      if (model !== undefined && model !== '') {
        await vscode.workspace.getConfiguration('codeforge').update('model', model, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`CodeForge: model set to ${model}`);
      }
    }),
  );

  // ── Provider picker (A+B: preset list + manual entry) ───────────────────────
  // Preset map: known provider id → { providerType, defaultEndpoint, hint }
  type ProviderPresetInfo = { provider: 'ollama' | 'openai-compatible' | 'gemini'; endpoint: string; hint: string };
  const PROVIDER_PRESETS: Record<string, ProviderPresetInfo> = {
    groq:       { provider: 'openai-compatible', endpoint: 'https://api.groq.com/openai/v1',                       hint: 'Groq — LPU inference, very fast, free tier. Get key: https://console.groq.com' },
    cerebras:   { provider: 'openai-compatible', endpoint: 'https://api.cerebras.ai/v1',                           hint: 'Cerebras — fast inference, free tier. Get key: https://cloud.cerebras.ai' },
    openrouter: { provider: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1',                         hint: 'OpenRouter — 200+ models, many free. Get key: https://openrouter.ai' },
    deepseek:   { provider: 'openai-compatible', endpoint: 'https://api.deepseek.com/v1',                          hint: 'DeepSeek — cheap ($0.14/1M), high quality. Get key: https://platform.deepseek.com' },
    sambanova:  { provider: 'openai-compatible', endpoint: 'https://api.sambanova.ai/v1',                          hint: 'SambaNova — free tier, Llama 3.1/3.3. Get key: https://cloud.sambanova.ai' },
    together:   { provider: 'openai-compatible', endpoint: 'https://api.together.xyz/v1',                          hint: 'Together AI — open models. Get key: https://api.together.ai' },
    mistral:    { provider: 'openai-compatible', endpoint: 'https://api.mistral.ai/v1',                            hint: 'Mistral AI. Get key: https://console.mistral.ai' },
    xai:        { provider: 'openai-compatible', endpoint: 'https://api.x.ai/v1',                                  hint: 'xAI / Grok. Get key: https://console.x.ai' },
    qwen:       { provider: 'openai-compatible', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',   hint: 'Qwen/Alibaba DashScope. Get key: https://dashscope.aliyun.com' },
    gemini:     { provider: 'gemini',            endpoint: '',                                                      hint: 'Google Gemini — free tier. Get key: https://aistudio.google.com' },
    lmstudio:   { provider: 'openai-compatible', endpoint: 'http://localhost:1234/v1',                             hint: 'LM Studio local server. No API key needed.' },
    ollama:     { provider: 'ollama',            endpoint: 'http://localhost:11434',                               hint: 'Ollama local server. No API key needed.' },
  };

  /** Read current provider config from settings, resolving preset → endpoint. */
  const resolveProviderSettings = (): { provider: 'ollama' | 'openai-compatible' | 'gemini'; endpoint: string; apiKey: string } => {
    const cfg = vscode.workspace.getConfiguration('codeforge');
    const preset = cfg.get<string>('providerPreset', '').trim();
    const info = preset !== '' ? PROVIDER_PRESETS[preset] : undefined;
    const provider = (info?.provider ?? cfg.get<string>('provider', 'ollama')) as 'ollama' | 'openai-compatible' | 'gemini';
    const endpoint = info?.endpoint ?? cfg.get<string>('endpoint', '').trim();
    const apiKey = cfg.get<string>('apiKey', '').trim();
    return { provider, endpoint, apiKey };
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.pickProvider', async () => {
      const cfg = vscode.workspace.getConfiguration('codeforge');
      // Step 1: pick a preset
      const presetItems = [
        { label: '$(gear) Custom', description: 'Enter provider/endpoint/apiKey manually via Settings', id: '' },
        ...Object.entries(PROVIDER_PRESETS).map(([id, info]) => ({
          label: id.charAt(0).toUpperCase() + id.slice(1),
          description: info.hint,
          id,
        })),
      ];
      const picked = await vscode.window.showQuickPick(presetItems, { placeHolder: 'Select a provider preset' });
      if (picked === undefined) return;

      await cfg.update('providerPreset', picked.id, vscode.ConfigurationTarget.Workspace);

      const info = PROVIDER_PRESETS[picked.id];
      if (info === undefined) {
        // Custom — open settings
        await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', { query: 'codeforge.provider' });
        return;
      }

      // Step 2: if cloud provider, prompt for API key
      const needsKey = info.provider !== 'ollama' && info.endpoint !== 'http://localhost:1234/v1';
      if (needsKey) {
        const existingKey = cfg.get<string>('apiKey', '');
        const key = await vscode.window.showInputBox({
          prompt: `API key for ${picked.label}`,
          placeHolder: existingKey ? '(keep existing key — leave empty)' : 'Paste your API key here',
          password: true,
          value: '',
        });
        if (key !== undefined && key.trim() !== '') {
          await cfg.update('apiKey', key.trim(), vscode.ConfigurationTarget.Workspace);
        }
      }

      // Step 3: suggest a default model for the preset
      const defaultModels: Record<string, string> = {
        groq: 'llama-3.3-70b-versatile', cerebras: 'llama3.1-70b', openrouter: 'meta-llama/llama-3.1-8b-instruct:free',
        deepseek: 'deepseek-chat', sambanova: 'Meta-Llama-3.1-70B-Instruct', together: 'meta-llama/Llama-3-70b-chat-hf',
        mistral: 'codestral-latest', xai: 'grok-3-mini-beta', qwen: 'qwen-plus',
        gemini: 'gemini-2.0-flash-exp', lmstudio: 'local-model', ollama: 'qwen2.5-coder:latest',
      };
      const suggestedModel = defaultModels[picked.id] ?? '';
      if (suggestedModel !== '') {
        const useDefault = await vscode.window.showInformationMessage(
          `Set model to "${suggestedModel}" for ${picked.label}?`,
          'Yes', 'Keep current',
        );
        if (useDefault === 'Yes') await cfg.update('model', suggestedModel, vscode.ConfigurationTarget.Workspace);
      }

      const { provider, endpoint } = resolveProviderSettings();
      vscode.window.showInformationMessage(
        `CodeForge: provider set to ${picked.label} (${provider}${endpoint ? ' · ' + endpoint : ''}). Start the runtime to use it.`,
      );
    }),
  );

  // ── Start / Stop Runtime Here (spawn a SEPARATE runtime process in the open workspace) ──
  context.subscriptions.push(
    vscode.commands.registerCommand('codeforge.startRuntime', async () => {
      if (runtimeProc !== null) { vscode.window.showInformationMessage('CodeForge: a runtime is already running (started here).'); return; }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (folder === undefined) { vscode.window.showErrorMessage('CodeForge: open a folder first — the runtime operates in the workspace.'); return; }

      const cfg = vscode.workspace.getConfiguration('codeforge');
      const configuredPath = cfg.get<string>('runtimePath', '').trim();
      // In a dev checkout the runtime lives in the same repo; when installed as a .vsix it does not
      // ship, so the user must set codeforge.runtimePath. repoRoot = the opened workspace (dev case).
      const entry = resolveRuntimeEntry({ configuredPath: configuredPath || undefined, repoRoot: folder });
      if (entry === null) {
        vscode.window.showErrorMessage('CodeForge: set "codeforge.runtimePath" to your built runtime-cli.js.');
        return;
      }

      const model = await pickModel();
      if (model === undefined || model === '') return;

      const port = cfg.get<number>('port', 9500);
      // P12.35: read provider/endpoint/apiKey from settings (preset or manual).
      const { provider, endpoint, apiKey } = resolveProviderSettings();
      const argv = buildRuntimeArgv({
        entryPath: entry, workspace: folder, model, port, autonomy: 'edits',
        ...(provider !== 'ollama' ? { provider } : {}),
        ...(endpoint !== '' ? { endpoint } : {}),
        ...(apiKey !== '' ? { apiKey } : {}),
      });
      // Use the SYSTEM node (not process.execPath, which is VS Code's Electron) so native modules
      // like better-sqlite3 load against the ABI they were built for.
      const nodeCmd = resolveNodeCommand(cfg.get<string>('nodePath', ''));

      runtimeOutput ??= vscode.window.createOutputChannel('CodeForge Runtime');
      runtimeOutput.clear();
      runtimeOutput.show(true);
      runtimeOutput.appendLine(`$ ${nodeCmd} ${argv.join(' ')}`);

      const child = spawn(nodeCmd, argv, { cwd: folder, env: process.env, shell: false });
      runtimeProc = child;
      child.stdout?.on('data', (b: Buffer) => runtimeOutput?.append(b.toString()));
      child.stderr?.on('data', (b: Buffer) => runtimeOutput?.append(b.toString()));
      child.on('exit', (code) => {
        runtimeOutput?.appendLine(`\n[runtime exited with code ${code ?? 'null'}]`);
        runtimeProc = null;
      });

      // Point the client at the spawned runtime and poll /health until it answers (max ~15s).
      runtimeUrl = runtimeUrlForPort(port);
      client = makeClient();
      vscode.window.showInformationMessage(`CodeForge: starting runtime in ${folder} on :${port}…`);
      let healthy = false;
      for (let i = 0; i < 30 && runtimeProc !== null && !healthy; i++) {
        await new Promise((r) => setTimeout(r, 500));
        healthy = await (client as RuntimeClient).health();
      }
      if (healthy) {
        vscode.window.showInformationMessage(`CodeForge: runtime ready at ${runtimeUrl}. Open "CodeForge: Goals" to send one.`);
        await refreshAll();
      } else {
        vscode.window.showWarningMessage('CodeForge: runtime did not become healthy in time — check the "CodeForge Runtime" output.');
      }
    }),
    vscode.commands.registerCommand('codeforge.stopRuntime', () => {
      if (runtimeProc === null) { vscode.window.showInformationMessage('CodeForge: no runtime was started from here.'); return; }
      runtimeProc.kill();
      runtimeProc = null;
      vscode.window.showInformationMessage('CodeForge: runtime stopped.');
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
  // Kill a runtime we spawned so we never leak a child process; the runtime holds all other
  // authoritative state, so there is nothing else to clean up here.
  if (runtimeProc !== null) { runtimeProc.kill(); runtimeProc = null; }
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
