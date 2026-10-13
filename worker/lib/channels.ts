import type { Channel, TelegramUser } from "../../shared/contracts";
import type { Env } from "../env";
import { HttpError, isRecord, readJson } from "./http";
import { TelegramClient } from "./telegram";

export async function listChannels(env: Env): Promise<Channel[]> {
  const result = await env.DB.prepare(
    "SELECT id, telegram_chat_id, title, username, approved_at, active, created_at FROM channels WHERE approved_by=? ORDER BY created_at DESC LIMIT 100",
  )
    .bind(env.OWNER_TELEGRAM_ID)
    .all<Channel>();
  return result.results;
}
export async function approveChannel(
  request: Request,
  env: Env,
  user: TelegramUser,
): Promise<Channel> {
  const body = await readJson(request);
  if (
    !isRecord(body) ||
    typeof body.chatId !== "string" ||
    !/^(-100\d{1,16}|@[a-zA-Z][a-zA-Z0-9_]{4,31})$/.test(body.chatId) ||
    body.approved !== true
  ) {
    throw new HttpError(
      400,
      "INVALID_CHANNEL",
      "Provide a channel @username or -100 chat ID and explicitly approve it.",
    );
  }
  const bot = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const chat = await bot.getChat(body.chatId);
  if (
    chat.type !== "channel" ||
    !Number.isSafeInteger(chat.id) ||
    chat.id >= 0 ||
    !chat.title
  )
    throw new HttpError(400, "NOT_CHANNEL", "Choose a Telegram channel.");
  const me = await bot.getMe();
  const [botMember, ownerMember] = await Promise.all([
    bot.getChatMember(String(chat.id), me.id),
    bot.getChatMember(String(chat.id), user.id),
  ]);
  if (
    botMember.status !== "administrator" ||
    botMember.can_post_messages !== true
  )
    throw new HttpError(
      400,
      "BOT_PERMISSION",
      "Add the bot as a channel administrator with permission to post messages.",
    );
  if (!["creator", "administrator"].includes(ownerMember.status))
    throw new HttpError(
      403,
      "CHANNEL_PERMISSION",
      "You must be an administrator of this channel.",
    );
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO channels (id, telegram_chat_id, title, username, approved_by, approved_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_chat_id) DO UPDATE SET title=excluded.title, username=excluded.username,
      approved_by=excluded.approved_by, approved_at=excluded.approved_at, active=1, updated_at=excluded.updated_at
      RETURNING id, telegram_chat_id, title, username, approved_at, active, created_at`,
    ).bind(
      id,
      String(chat.id),
      chat.title,
      chat.username ?? null,
      String(user.id),
      now,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO history (id, channel_id, actor_telegram_id, action)
      VALUES (?, (SELECT id FROM channels WHERE telegram_chat_id=?), ?, 'channel.approved')`,
    ).bind(crypto.randomUUID(), String(chat.id), String(user.id)),
  ]);
  const channel = results[0]?.results[0] as Channel | undefined;
  if (!channel) throw new Error("Channel write failed");
  return channel;
}
export async function revokeChannel(
  id: string,
  env: Env,
  user: TelegramUser,
): Promise<void> {
  const found = await env.DB.prepare(
    "SELECT id FROM channels WHERE id = ? AND approved_by=?",
  )
    .bind(id, String(user.id))
    .first();
  if (!found) throw new HttpError(404, "NOT_FOUND", "Channel not found.");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE channels SET active=0, approved_at=NULL, updated_at=? WHERE id=?",
    ).bind(new Date().toISOString(), id),
    env.DB.prepare(
      "UPDATE scheduled_jobs SET status='cancelled', updated_at=? WHERE post_id IN (SELECT id FROM posts WHERE channel_id=?) AND status IN ('pending','running')",
    ).bind(new Date().toISOString(), id),
    env.DB.prepare(
      "UPDATE posts SET status='draft', scheduled_at=NULL, updated_at=? WHERE channel_id=? AND status='scheduled'",
    ).bind(new Date().toISOString(), id),
    env.DB.prepare(
      "INSERT INTO history (id, channel_id, actor_telegram_id, action) VALUES (?, ?, ?, 'channel.revoked')",
    ).bind(crypto.randomUUID(), id, String(user.id)),
  ]);
}
// Every future publication and retry MUST call this immediately before contacting Telegram.
export async function requireApprovedChannel(
  env: Env,
  id: string,
): Promise<Channel> {
  const channel = await env.DB.prepare(
    "SELECT * FROM channels WHERE id=? AND active=1 AND approved_at IS NOT NULL AND approved_by=?",
  )
    .bind(id, env.OWNER_TELEGRAM_ID)
    .first<Channel>();
  if (!channel)
    throw new HttpError(
      403,
      "CHANNEL_NOT_APPROVED",
      "Approve this channel before publishing.",
    );
  return channel;
}
