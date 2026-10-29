import type { Env } from "../env";
import { HttpError } from "./http";

export const isOwnerId = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  /^[1-9]\d*$/.test(value) &&
  Number.isSafeInteger(Number(value));

// Check BotFather token shape, not whether Telegram has issued/revoked it.
export const isBotToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length <= 512 &&
  /^[1-9]\d*:[A-Za-z0-9_-]{30,}$/.test(value);

export function requireWebhookSecret(env: Env): void {
  if (
    typeof env.TELEGRAM_WEBHOOK_SECRET !== "string" ||
    env.TELEGRAM_WEBHOOK_SECRET !== env.TELEGRAM_WEBHOOK_SECRET.trim() ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)
  )
    throw new HttpError(503, "NOT_CONFIGURED", "Webhook is not configured.");
}

export function requireMiniAppUrl(env: Env): string {
  try {
    const url = new URL(env.MINI_APP_URL);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      env.MINI_APP_URL !== env.MINI_APP_URL.trim()
    )
      throw new Error();
    return url.toString();
  } catch {
    throw new HttpError(
      503,
      "NOT_CONFIGURED",
      "Mini App URL is not configured.",
    );
  }
}
