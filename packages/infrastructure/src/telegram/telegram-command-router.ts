// TelegramCommandRouter (P9.8) — OFFLINE-TESTABLE translation of a chat command into a
// read query or a ControlRequest, routed through the SAME ObservabilityService that the
// dashboard uses. Enforces OB-006 (one control path): a Telegram "/pause" and a dashboard
// "Pause" build the same ControlRequest (surface = 'telegram') and admit identically.
//
// No network here. The router takes a plain-data chat message and returns reply text; the
// thin TelegramTransport feeds it messages and sends the replies. Telegram is an adapter,
// never an authority — every mutating command goes via submitControl -> ControlPlane.
import type { ControlIntent, ControlRequest } from '@codeforge/agent-core';
import type { ObservabilityService } from '../observability-server/observability-service.js';

// ── Chat message (plain data — adapter-agnostic) ────────────────────────────────

export interface ChatMessage {
  /** Raw text, e.g. "/pause" or "/approve TC123". */
  readonly text: string;
  /** Telegram chat id (also used as the default actor id). */
  readonly chatId: string;
  /** Optional explicit actor id; defaults to chatId. */
  readonly fromId?: string;
}

export interface RouterReply {
  readonly chatId: string;
  readonly text: string;
}

const CONTROL_INTENTS: ReadonlySet<string> = new Set([
  'pause', 'resume', 'cancel', 'approve', 'deny', 'retry', 'checkpoint',
]);

const HELP = [
  'CodeForge control bot. Bind a session first:',
  '  /use <sessionId>',
  'Read:',
  '  /status   — agent state',
  '  /task     — task tree',
  '  /graph    — task graph summary',
  '  /log      — recent activity',
  'Control (via Control Plane):',
  '  /pause  /resume  /cancel  /checkpoint',
  '  /approve <toolCallId>   /deny <toolCallId> [reason]',
  '  /retry <taskId>',
].join('\n');

export interface TelegramCommandRouterDeps {
  readonly service: ObservabilityService;
}

export class TelegramCommandRouter {
  /** chatId -> bound sessionId. A chat must bind a session before most commands work. */
  private readonly boundSession = new Map<string, string>();

  constructor(private readonly deps: TelegramCommandRouterDeps) {}

  /** Pre-bind a chat to a session (used by the transport default / tests). */
  bind(chatId: string, sessionId: string): void {
    this.boundSession.set(chatId, sessionId);
  }

  /**
   * Handle one chat message and produce a reply. Deterministic given the service state.
   * Mutating commands go through ObservabilityService.submitControl (OB-006).
   */
  async handle(msg: ChatMessage): Promise<RouterReply> {
    const text = msg.text.trim();
    const reply = (t: string): RouterReply => ({ chatId: msg.chatId, text: t });

    if (text === '' || text === '/help' || text === '/start') return reply(HELP);

    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = (rawCmd ?? '').replace(/^\//, '').toLowerCase();
    const arg = rest[0];

    if (cmd === 'use') {
      if (arg === undefined) return reply('Usage: /use <sessionId>');
      this.boundSession.set(msg.chatId, arg);
      return reply(`Bound to session ${arg}.`);
    }

    const sessionId = this.boundSession.get(msg.chatId);
    if (sessionId === undefined) return reply('No session bound. Use /use <sessionId> first.');

    switch (cmd) {
      case 'status': return reply(await this.status(sessionId));
      case 'task':   return reply(await this.tasks(sessionId));
      case 'graph':  return reply(await this.graph(sessionId));
      case 'log':    return reply(await this.log(sessionId));
      default: break;
    }

    if (CONTROL_INTENTS.has(cmd)) {
      return reply(await this.control(sessionId, cmd as ControlIntent, msg, arg, rest.slice(1).join(' ')));
    }

    return reply(`Unknown command: ${rawCmd}\n\n${HELP}`);
  }

  // ── read formatters ─────────────────────────────────────────────────────────

  private async status(sessionId: string): Promise<string> {
    const st = await this.deps.service.getState(sessionId);
    if (st === null) return `Session ${sessionId} not found.`;
    const b = st.budget ? ` | budget ${Math.round(st.budget.pressure * 100)}%` : '';
    return [
      `session ${st.sessionId} — ${st.sessionState}`,
      `graph v${st.graphVersion} | model ${st.model ?? '-'}${b}`,
      `tasks ${st.counts.total}: ${st.counts.passed} passed, ${st.counts.active} active, ${st.counts.blocked} blocked, ${st.counts.failed} failed`,
    ].join('\n');
  }

  private async tasks(sessionId: string): Promise<string> {
    const st = await this.deps.service.getState(sessionId);
    if (st === null) return `Session ${sessionId} not found.`;
    if (st.tasks.length === 0) return '(no tasks)';
    return st.tasks.map((t) => {
      const mark = t.isActive ? '●' : t.state === 'PASSED' ? '✓' : t.isBlocked ? '⊘' : '○';
      return `${mark} ${t.taskId} — ${t.state}`;
    }).join('\n');
  }

  private async graph(sessionId: string): Promise<string> {
    const st = await this.deps.service.getState(sessionId);
    if (st === null) return `Session ${sessionId} not found.`;
    return `graph v${st.graphVersion}: ${st.counts.total} task(s), ${st.activeRunCount} active run(s)`;
  }

  private async log(sessionId: string): Promise<string> {
    const trace = await this.deps.service.getTrace(sessionId);
    const recent = trace.entries.slice(-10);
    if (recent.length === 0) return '(no activity)';
    return recent.map((e) => `${e.at.slice(11, 19)} ${e.category} ${e.eventType}`).join('\n');
  }

  // ── control ─────────────────────────────────────────────────────────────────

  private async control(
    sessionId: string,
    intent: ControlIntent,
    msg: ChatMessage,
    firstArg: string | undefined,
    reason: string,
  ): Promise<string> {
    const wantsToolCall = (intent === 'approve' || intent === 'deny') && firstArg !== undefined;
    const wantsTask = intent === 'retry' && firstArg !== undefined;
    const request: ControlRequest = {
      intent,
      sessionId,
      requestedBy: { kind: 'user', id: msg.fromId ?? msg.chatId, surface: 'telegram' },
      ...(wantsToolCall ? { toolCallId: firstArg } : {}),
      ...(wantsTask ? { taskId: firstArg } : {}),
      ...(intent === 'deny' && reason !== '' ? { reason } : {}),
    };
    const result = await this.deps.service.submitControl(request);
    if (result.admission.admitted) {
      return `${intent}: admitted (${result.record.result}).`;
    }
    return `${intent}: rejected (${result.admission.reason}).`;
  }
}
