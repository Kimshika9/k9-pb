import { HttpError, isRecord } from "./http";
import type { InputRichMessage } from "../../shared/editor/telegram";
export class TelegramDeliveryError extends HttpError {
  readonly uncertain: boolean;
  readonly retryable: boolean;
  readonly retryAfter: number;
  constructor(
    code: string,
    message: string,
    uncertain: boolean,
    retryable: boolean,
    retryAfter = 0,
  ) {
    super(code === "TELEGRAM_RATE_LIMIT" ? 429 : 502, code, message);
    this.uncertain = uncertain;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}
export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  date?: number;
}
export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
export interface ChatMember {
  status: string;
  can_post_messages?: boolean;
  can_delete_messages?: boolean;
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
    // Native Worker fetch requires its global receiver; injected test transports work too.
    this.transport = (input, init) => transport.call(globalThis, input, init);
  }
  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    mutation = false,
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
          // workerd supports manual/follow. Never follow token-bearing redirects.
          redirect: "manual",
        },
      );
    } catch {
      throw new TelegramDeliveryError(
        mutation ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
        mutation
          ? "Telegram delivery could not be confirmed. Inspect Telegram and reconcile; do not resend blindly."
          : "Telegram is temporarily unavailable. Try again.",
        mutation,
        !mutation,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new TelegramDeliveryError(
        mutation ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
        "Telegram returned an invalid response; delivery cannot be confirmed.",
        mutation,
        !mutation,
      );
    }
    if (
      isRecord(result) &&
      result.ok === false &&
      Number.isInteger(result.error_code)
    ) {
      const code = Number(result.error_code);
      if (code === 429) {
        const value = isRecord(result.parameters)
          ? Number(result.parameters.retry_after)
          : 30;
        const delay =
          Number.isSafeInteger(value) && value > 0
            ? Math.min(value, 86400)
            : 30;
        throw new TelegramDeliveryError(
          "TELEGRAM_RATE_LIMIT",
          `Telegram rate limit. Retry after ${delay} seconds with the same operation ID.`,
          false,
          true,
          delay,
        );
      }
      // Match categories only; never surface arbitrary descriptions or token-bearing URLs.
      const description =
        typeof result.description === "string"
          ? result.description.toLowerCase()
          : "";
      const reason = description.includes("message is not modified")
        ? "The Telegram message is unchanged."
        : description.includes("message can't be deleted") ||
            description.includes("message to delete not found")
          ? "Telegram cannot delete this message; check its age and permissions."
          : description.includes("message can't be edited") ||
              description.includes("message to edit not found")
            ? "Telegram cannot edit this message; check its age and permissions."
            : code === 403
              ? "Telegram denied bot access. Check administrator rights or start the bot privately."
              : code === 404
                ? "Telegram does not support this API method on the configured service."
                : "Telegram rejected the message. Check content and channel permissions.";
      throw new TelegramDeliveryError(
        code >= 500 ? "TELEGRAM_TEMPORARY" : "TELEGRAM_REJECTED",
        reason,
        false,
        code >= 500,
      );
    }
    if (
      !response.ok ||
      !isRecord(result) ||
      result.ok !== true ||
      result.result == null
    ) {
      // Telegram descriptions and request URLs can contain sensitive data. Never surface them.
      throw new TelegramDeliveryError(
        mutation ? "DELIVERY_UNCERTAIN" : "TELEGRAM_REJECTED",
        "Telegram returned no valid confirmation.",
        mutation,
        !mutation,
      );
    }
    return result.result as T;
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
  private message(
    value: unknown,
    chatId: string,
    messageId?: number,
  ): TelegramMessage {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.message_id) ||
      Number(value.message_id) <= 0 ||
      !isRecord(value.chat) ||
      String(value.chat.id) !== chatId ||
      (messageId !== undefined && value.message_id !== messageId)
    )
      throw new TelegramDeliveryError(
        "DELIVERY_UNCERTAIN",
        "Telegram returned an invalid message confirmation. Reconcile before retrying.",
        true,
        false,
      );
    return value as unknown as TelegramMessage;
  }
  async sendRichMessage(
    chatId: string,
    richMessage: InputRichMessage,
  ): Promise<TelegramMessage> {
    return this.message(
      await this.call(
        "sendRichMessage",
        { chat_id: chatId, rich_message: richMessage },
        true,
      ),
      chatId,
    );
  }
  async editRichMessage(
    chatId: string,
    messageId: number,
    richMessage: InputRichMessage,
  ): Promise<TelegramMessage> {
    return this.message(
      await this.call(
        "editMessageText",
        { chat_id: chatId, message_id: messageId, rich_message: richMessage },
        true,
      ),
      chatId,
      messageId,
    );
  }
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    const result = await this.call(
      "deleteMessage",
      { chat_id: chatId, message_id: messageId },
      true,
    );
    if (result !== true)
      throw new TelegramDeliveryError(
        "DELIVERY_UNCERTAIN",
        "Telegram did not confirm deletion. Reconcile before retrying.",
        true,
        false,
      );
  }
  sendOwnerText(chatId: number, text: string, url: string): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open K9 Studio", web_app: { url } }],
          [{ text: "System status", callback_data: "k9:status" }],
        ],
      },
    });
  }
  answerCallback(id: string, text: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }
}
