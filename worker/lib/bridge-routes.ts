import type { Env } from "../env";
import { json, readJson, HttpError } from "./http";
import { TelegramClient } from "./telegram";
import { registerBridgeMedia } from "./media";
import { runtimeRoutes } from "./bot-runtime";
import { requireMiniAppUrl } from "./config";
import { getBridgeActions } from "./cli-auth";
import { z } from "zod";
import {
  getPostSnapshot,
  validateSnapshot,
  checkChannelPermissions,
} from "./publishing";
export async function bridgeRoutes(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const runtime = await runtimeRoutes(request, env, url);
  if (runtime) return runtime;
  const jobMatch = /^\/api\/scheduled\/([A-Za-z0-9_-]{1,80})$/.exec(
    url.pathname,
  );
  if (jobMatch && request.method === "GET") {
    const job = await env.DB.prepare(
      "SELECT id,post_id,channel_id,title,source_revision,revision,timezone,status,run_at,delivery_state,attempts,next_attempt_at,lease_until,last_error_code,publication_id FROM scheduled_jobs WHERE id=? AND (owner_telegram_id=? OR (owner_telegram_id IS NULL AND EXISTS(SELECT 1 FROM posts WHERE id=scheduled_jobs.post_id AND (owner_telegram_id=? OR owner_telegram_id IS NULL))))",
    )
      .bind(jobMatch[1]!, env.OWNER_TELEGRAM_ID, env.OWNER_TELEGRAM_ID)
      .first();
    if (!job) throw new HttpError(404, "NOT_FOUND", "Scheduled job not found.");
    return json({ job });
  }
  const check = /^\/api\/posts\/([A-Za-z0-9_-]{1,80})\/check$/.exec(
    url.pathname,
  );
  if (check && request.method === "POST") {
    const value = z
      .strictObject({
        revision: z.number().int().positive(),
        channelId: z.string().uuid(),
      })
      .safeParse(await readJson(request));
    if (!value.success)
      throw new HttpError(
        400,
        "INVALID_INPUT",
        "Select a saved draft and approved channel.",
      );
    const snapshot = await getPostSnapshot(env, check[1]!, value.data.revision);
    await validateSnapshot(env, snapshot);
    const channel = await checkChannelPermissions(env, value.data.channelId);
    return json({
      ready: true,
      title: snapshot.title,
      revision: snapshot.revision,
      channelTitle: channel.title,
    });
  }
  if (url.pathname === "/api/identity" && request.method === "GET") {
    const me = await new TelegramClient(env.TELEGRAM_BOT_TOKEN).getMe();
    if (!Number.isSafeInteger(me.id) || me.id <= 0)
      throw new HttpError(
        502,
        "BOT_IDENTITY_INVALID",
        "Telegram could not verify the configured bot.",
      );
    return json({
      botId: me.id,
      ownerId: Number(env.OWNER_TELEGRAM_ID),
      webAppUrl: requireMiniAppUrl(env),
      bridgeActions: getBridgeActions(env),
    });
  }
  if (url.pathname === "/api/media/register" && request.method === "POST")
    return json(
      { media: await registerBridgeMedia(await readJson(request), env) },
      201,
    );
  return null;
}
