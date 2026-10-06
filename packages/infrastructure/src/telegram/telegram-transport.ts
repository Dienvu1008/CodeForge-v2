// TelegramTransport (P9.8) — THIN network edge for the Telegram adapter. It long-polls
// getUpdates, routes each message through TelegramCommandRouter, and sends the reply via
// sendMessage. All business logic is in the router (and ultimately ObservabilityService);
// this file only moves messages. The network client is an interface so tests inject a
// fake and the real bot (fetch to api.telegram.org) is never exercised in CI.
import type { TelegramCommandRouter, ChatMessage } from './telegram-command-router.js';

// ── Telegram API surface the transport needs (minimal) ──────────────────────────

export interface TelegramUpdate {
  readonly updateId: number;
  readonly message?: { readonly chatId: string; readonly fromId?: string; readonly text: string };
}

export interface TelegramApiClient {
  /** Long-poll for updates after `offset`. */
  getUpdates(offset: number): Promise<readonly TelegramUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
}

export interface TelegramTransportOptions {
  readonly router: TelegramCommandRouter;
  readonly client: TelegramApiClient;
}

export class TelegramTransport {
  private offset = 0;
  private running = false;

  constructor(private readonly opts: TelegramTransportOptions) {}

  /**
   * Process one batch of updates: fetch, route each message, send each reply, and advance
   * the offset past the processed updates. Returns the number of messages handled. Pure
   * control-flow — a single testable step with no timers.
   */
  async pollOnce(): Promise<number> {
    const updates = await this.opts.client.getUpdates(this.offset);
    let handled = 0;
    for (const u of updates) {
      this.offset = Math.max(this.offset, u.updateId + 1);
      if (u.message === undefined) continue;
      const msg: ChatMessage = {
        text: u.message.text, chatId: u.message.chatId,
        ...(u.message.fromId !== undefined ? { fromId: u.message.fromId } : {}),
      };
      const reply = await this.opts.router.handle(msg);
      await this.opts.client.sendMessage(reply.chatId, reply.text);
      handled += 1;
    }
    return handled;
  }

  /** Current update offset (next getUpdates starts here). */
  get currentOffset(): number { return this.offset; }

  /**
   * Run the long-poll loop until stop() is called. Intended for the real bot; tests use
   * pollOnce() instead so there are no timers to coordinate.
   */
  async run(pollIntervalMs = 1000): Promise<void> {
    this.running = true;
    while (this.running) {
      try { await this.pollOnce(); }
      catch { /* transient network error — back off and retry */ }
      await sleep(pollIntervalMs);
    }
  }

  stop(): void { this.running = false; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
