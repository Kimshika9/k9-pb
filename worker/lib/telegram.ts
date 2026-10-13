import { HttpError } from "./http";
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
export interface ChatMember {
  status: string;
  can_post_messages?: boolean;
}
export interface TelegramBot {
  id: number;
  username: string;
}
export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}
export class TelegramClient {
  private readonly token: string;
  private readonly transport: typeof fetch;
  constructor(token: string, transport: typeof fetch = fetch) {
    this.token = token;
    this.transport = transport;
  }
  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.transport(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new HttpError(
        502,
        "TELEGRAM_UNAVAILABLE",
        "Telegram is temporarily unavailable. Try again.",
      );
    }
    let result: { ok?: boolean; result?: T };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      throw new HttpError(
        502,
        "TELEGRAM_UNAVAILABLE",
        "Telegram returned an invalid response.",
      );
    }
    if (!response.ok || result.ok !== true || result.result === undefined) {
      // Telegram descriptions and request URLs can contain sensitive data. Never surface them.
      throw new HttpError(
        502,
        "TELEGRAM_REJECTED",
        "Telegram rejected the request. Check the channel and bot permissions.",
      );
    }
    return result.result;
  }
  getFile(fileId: string): Promise<TelegramFile> {
    return this.call("getFile", { file_id: fileId });
  }
  getMe(): Promise<TelegramBot> {
    return this.call("getMe", {});
  }
  getChat(chatId: string): Promise<TelegramChat> {
    return this.call("getChat", { chat_id: chatId });
  }
  getChatMember(chatId: string, userId: number): Promise<ChatMember> {
    return this.call("getChatMember", { chat_id: chatId, user_id: userId });
  }
  sendOwnerLaunch(chatId: number, url: string): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: "Welcome to K9 Post Studio. Your private channel workspace is ready.",
      reply_markup: {
        inline_keyboard: [[{ text: "Open K9 Post Studio", web_app: { url } }]],
      },
    });
  }
  // Channel publication is deliberately absent in Phase 1. Add it only behind approval checks.
}
