import type { Env } from "../env";
import { equalSecret, requireAuthConfig } from "./auth";
import { HttpError, isRecord, json, readJson } from "./http";
import { registerWebhookMedia } from "./media";
import { TelegramClient } from "./telegram";

export async function webhook(request: Request, env: Env): Promise<Response> {
  requireAuthConfig(env);
  if (!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET.length < 32)
    throw new HttpError(503, "NOT_CONFIGURED", "Webhook is not configured.");
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!provided || !(await equalSecret(provided, env.TELEGRAM_WEBHOOK_SECRET)))
    throw new HttpError(401, "INVALID_WEBHOOK", "Invalid webhook credentials.");
  const update = await readJson(request);
  if (
    !isRecord(update) ||
    !Number.isSafeInteger(update.update_id) ||
    Number(update.update_id) < 0
  )
    throw new HttpError(400, "INVALID_UPDATE", "Invalid Telegram update.");
  const message = update.message;
  // Only owner commands in the owner's private chat may produce a response.
  if (
    !isRecord(message) ||
    !isRecord(message.from) ||
    !isRecord(message.chat) ||
    String(message.from.id) !== env.OWNER_TELEGRAM_ID ||
    String(message.chat.id) !== env.OWNER_TELEGRAM_ID ||
    message.chat.type !== "private"
  )
    return json({ ok: true });
  if (await registerWebhookMedia(message, env)) return json({ ok: true });
  if (
    typeof message.text !== "string" ||
    !/^\/start(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.test(message.text)
  )
    return json({ ok: true });
  let url: URL;
  try {
    url = new URL(env.MINI_APP_URL);
  } catch {
    throw new HttpError(
      503,
      "NOT_CONFIGURED",
      "Mini App URL is not configured.",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new HttpError(503, "NOT_CONFIGURED", "Mini App URL must use HTTPS.");
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(
    `INSERT INTO webhook_updates (update_id, status, lease_until) VALUES (?, 'processing', ?)
    ON CONFLICT(update_id) DO UPDATE SET status='processing', lease_until=excluded.lease_until
    WHERE webhook_updates.status='failed' OR (webhook_updates.status='processing' AND webhook_updates.lease_until < ?)
    RETURNING update_id`,
  )
    .bind(update.update_id, now + 30, now)
    .first();
  if (!claim) {
    const previous = await env.DB.prepare(
      "SELECT status FROM webhook_updates WHERE update_id=?",
    )
      .bind(update.update_id)
      .first<{ status: string }>();
    if (previous?.status === "completed") return json({ ok: true });
    throw new HttpError(
      503,
      "UPDATE_IN_PROGRESS",
      "Update is processing. Retry shortly.",
    );
  }
  try {
    await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendOwnerLaunch(
      Number(env.OWNER_TELEGRAM_ID),
      url.toString(),
    );
    await env.DB.prepare(
      "UPDATE webhook_updates SET status='completed' WHERE update_id=?",
    )
      .bind(update.update_id)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE webhook_updates SET status='failed' WHERE update_id=?",
    )
      .bind(update.update_id)
      .run();
    throw error;
  }
  return json({ ok: true });
}
