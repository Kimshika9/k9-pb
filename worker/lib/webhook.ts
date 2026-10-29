import type { Env } from "../env";
import { equalSecret, requireAuthConfig } from "./auth";
import { HttpError, isRecord, json, readJson } from "./http";
import { registerWebhookMedia } from "./media";
import { TelegramClient } from "./telegram";
import { requireWebhookSecret, requireMiniAppUrl } from "./config";
import { getBotRuntime } from "./bot-runtime";
import { commandText } from "./bot-commands";

async function claimUpdate(env: Env, id: number): Promise<number | null> {
  if (!env.DB || typeof env.DB.prepare !== "function")
    throw new HttpError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Studio storage is not configured yet.",
    );
  const now = Math.floor(Date.now() / 1000),
    lease = now + 30;
  const claim = await env.DB.prepare(
    `INSERT INTO webhook_updates(update_id,status,lease_until) VALUES(?,'processing',?) ON CONFLICT(update_id) DO UPDATE SET status='processing',lease_until=excluded.lease_until WHERE webhook_updates.status='failed' OR (webhook_updates.status='processing' AND webhook_updates.lease_until<?) RETURNING update_id`,
  )
    .bind(id, lease, now)
    .first();
  if (claim) return lease;
  const previous = await env.DB.prepare(
    "SELECT status FROM webhook_updates WHERE update_id=?",
  )
    .bind(id)
    .first<{ status: string }>();
  if (previous?.status === "completed") return null;
  throw new HttpError(
    503,
    "UPDATE_IN_PROGRESS",
    "Update is processing. Retry shortly.",
  );
}
async function finishUpdate(
  env: Env,
  id: number,
  lease: number,
  status: "completed" | "failed",
) {
  await env.DB.prepare(
    "UPDATE webhook_updates SET status=? WHERE update_id=? AND status='processing' AND lease_until=?",
  )
    .bind(status, id, lease)
    .run();
}
async function callback(
  update: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const query = update.callback_query;
  if (
    !isRecord(query) ||
    typeof query.id !== "string" ||
    query.id.length > 128 ||
    !isRecord(query.from)
  )
    throw new HttpError(400, "INVALID_CALLBACK", "Invalid callback query.");
  const lease = await claimUpdate(env, Number(update.update_id));
  if (lease === null) return json({ ok: true });
  try {
    const privateOwner =
      String(query.from.id) === env.OWNER_TELEGRAM_ID &&
      isRecord(query.message) &&
      isRecord(query.message.chat) &&
      query.message.chat.type === "private" &&
      String(query.message.chat.id) === env.OWNER_TELEGRAM_ID;
    const bot = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    await bot.answerCallback(
      query.id,
      privateOwner && query.data === "k9:preview"
        ? "Test preview only. No action was executed."
        : "Manage actions in your private K9 Studio.",
    );
    if (privateOwner && query.data === "k9:status")
      await bot.sendOwnerText(
        Number(env.OWNER_TELEGRAM_ID),
        await commandText("status", env),
        requireMiniAppUrl(env),
      );
    await finishUpdate(env, Number(update.update_id), lease, "completed");
  } catch (error) {
    await finishUpdate(env, Number(update.update_id), lease, "failed");
    throw error;
  }
  return json({ ok: true });
}

export async function webhook(request: Request, env: Env): Promise<Response> {
  requireAuthConfig(env);
  requireWebhookSecret(env);
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!provided || !(await equalSecret(provided, env.TELEGRAM_WEBHOOK_SECRET)))
    throw new HttpError(401, "INVALID_WEBHOOK", "Invalid webhook credentials.");
  if (
    env.DB &&
    typeof env.DB.prepare === "function" &&
    (await getBotRuntime(env, false)).mode !== "cloudflare"
  )
    throw new HttpError(
      503,
      "RECEIVER_FENCED",
      "The Cloudflare update receiver is paused for an explicit runtime switch.",
    );
  const update = await readJson(request);
  if (
    !isRecord(update) ||
    !Number.isSafeInteger(update.update_id) ||
    Number(update.update_id) < 0
  )
    throw new HttpError(400, "INVALID_UPDATE", "Invalid Telegram update.");
  if (update.callback_query !== undefined) return callback(update, env);
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
  const command =
    typeof message.text === "string"
      ? /^\/(start|help|studio|status|channels|posts|scheduled)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.exec(
          message.text,
        )?.[1]
      : undefined;
  const media =
    (Array.isArray(message.photo) && message.photo.length > 0) ||
    isRecord(message.video) ||
    isRecord(message.document);
  if (!command && !media) return json({ ok: true });
  const launchUrl = command ? requireMiniAppUrl(env) : null;
  if (!env.DB || typeof env.DB.prepare !== "function")
    throw new HttpError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Studio storage is not configured yet.",
    );
  const lease = await claimUpdate(env, Number(update.update_id));
  if (lease === null) return json({ ok: true });
  try {
    if (media) await registerWebhookMedia(message, env);
    else if (launchUrl && (command === "start" || command === "studio"))
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendOwnerLaunch(
        Number(env.OWNER_TELEGRAM_ID),
        launchUrl,
      );
    else if (launchUrl && command)
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendOwnerText(
        Number(env.OWNER_TELEGRAM_ID),
        await commandText(command, env),
        launchUrl,
      );
    await env.DB.prepare(
      "UPDATE webhook_updates SET status='completed' WHERE update_id=? AND status='processing' AND lease_until=?",
    )
      .bind(update.update_id, lease)
      .run();
  } catch (error) {
    await env.DB.prepare(
      "UPDATE webhook_updates SET status='failed' WHERE update_id=? AND status='processing' AND lease_until=?",
    )
      .bind(update.update_id, lease)
      .run();
    throw error;
  }
  return json({ ok: true });
}
