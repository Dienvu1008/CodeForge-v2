// FetchTelegramClient (P9.8) — the real TelegramApiClient over the Bot API using global
// fetch. Small and isolated at the network edge; NOT exercised in CI (needs a bot token).
// All logic lives in TelegramCommandRouter; this only translates the two calls the
// transport needs to/from the Telegram HTTP shapes.
import type { TelegramApiClient, TelegramUpdate } from './telegram-transport.js';

interface RawUpdate {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

export interface FetchTelegramClientOptions {
  readonly botToken: string;
  /** Long-poll timeout in seconds (Telegram getUpdates `timeout`). Default 25. */
  readonly longPollSeconds?: number;
  /** Override base URL (for a proxy). Default https://api.telegram.org. */
  readonly baseUrl?: string;
}

export class FetchTelegramClient implements TelegramApiClient {
  private readonly base: string;
  private readonly longPoll: number;

  constructor(private readonly opts: FetchTelegramClientOptions) {
    this.base = `${opts.baseUrl ?? 'https://api.telegram.org'}/bot${opts.botToken}`;
    this.longPoll = opts.longPollSeconds ?? 25;
  }

  async getUpdates(offset: number): Promise<readonly TelegramUpdate[]> {
    const res = await fetch(`${this.base}/getUpdates?offset=${offset}&timeout=${this.longPoll}`);
    const body = (await res.json()) as { ok: boolean; result?: RawUpdate[] };
    if (!body.ok || body.result === undefined) return [];
    return body.result
      .filter((u) => u.message?.text !== undefined)
      .map((u) => ({
        updateId: u.update_id,
        message: {
          chatId: String(u.message!.chat.id),
          ...(u.message!.from !== undefined ? { fromId: String(u.message!.from.id) } : {}),
          text: u.message!.text!,
        },
      }));
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}
