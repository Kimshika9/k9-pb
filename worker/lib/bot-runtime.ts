import type { Env } from "../env";
import { HttpError, json, readJson } from "./http";
import { z } from "zod";
export interface BotRuntime {
  mode: "cloudflare" | "python" | "transition";
  revision: number;
  instance_id: string | null;
  lease_until: number;
}
export async function getBotRuntime(
  env: Env,
  required = true,
): Promise<BotRuntime> {
  const exists = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_runtime'",
  ).first();
  if (!exists) {
    if (required)
      throw new HttpError(
        503,
        "BRIDGE_SCHEMA_NOT_READY",
        "Apply the reviewed Python bridge migration before using this receiver.",
      );
    return {
      mode: "cloudflare",
      revision: 0,
      instance_id: null,
      lease_until: 0,
    };
  }
  const row = await env.DB.prepare(
    "SELECT mode,revision,instance_id,lease_until,owner_telegram_id FROM bot_runtime WHERE id='receiver'",
  ).first<BotRuntime & { owner_telegram_id: string }>();
  if (row && row.owner_telegram_id !== env.OWNER_TELEGRAM_ID)
    throw new HttpError(
      403,
      "RUNTIME_OWNER_MISMATCH",
      "Receiver ownership needs explicit review.",
    );
  return (
    row ?? {
      mode: "cloudflare",
      revision: 0,
      instance_id: null,
      lease_until: 0,
    }
  );
}
export async function runtimeRoutes(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!["/api/runtime", "/api/runtime/lease"].includes(url.pathname))
    return null;
  const state = await getBotRuntime(env),
    now = Math.floor(Date.now() / 1000);
  if (url.pathname === "/api/runtime" && request.method === "GET")
    return json({
      runtime: state,
      active: state.lease_until > now,
      leaseRemaining: Math.max(0, state.lease_until - now),
    });
  if (request.method !== "POST")
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
  if (url.pathname === "/api/runtime") {
    const parsed = z
      .strictObject({
        mode: z.enum(["cloudflare", "python", "transition"]),
        revision: z.number().int().nonnegative(),
        confirmed: z.literal(true),
      })
      .safeParse(await readJson(request));
    if (!parsed.success)
      throw new HttpError(
        400,
        "INVALID_RUNTIME",
        "Confirm a mode and current revision.",
      );
    const v = parsed.data;
    if (state.revision !== v.revision)
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        "Receiver state changed. Check before switching.",
      );
    if (state.lease_until > now)
      throw new HttpError(
        409,
        "PYTHON_RUNNING",
        "Stop the Python receiver gracefully before switching.",
      );
    if (v.mode !== "transition" && state.mode !== "transition")
      throw new HttpError(
        409,
        "TRANSITION_REQUIRED",
        "Fence both receivers before changing Telegram settings.",
      );
    const timestamp = new Date().toISOString();
    const mutation =
      state.revision === 0
        ? env.DB.prepare(
            "INSERT INTO bot_runtime(id,owner_telegram_id,mode,updated_at) VALUES('receiver',?,?,?) ON CONFLICT DO NOTHING RETURNING mode,revision,instance_id,lease_until",
          ).bind(env.OWNER_TELEGRAM_ID, v.mode, timestamp)
        : env.DB.prepare(
            "UPDATE bot_runtime SET mode=?,revision=revision+1,instance_id=NULL,lease_until=0,updated_at=? WHERE id='receiver' AND owner_telegram_id=? AND revision=? AND lease_until<=? RETURNING mode,revision,instance_id,lease_until",
          ).bind(v.mode, timestamp, env.OWNER_TELEGRAM_ID, v.revision, now);
    const results = await env.DB.batch([
      mutation,
      env.DB.prepare(
        "INSERT INTO history(id,actor_telegram_id,action,details_json) SELECT ?,?,'bot.runtime',? WHERE changes()>0",
      ).bind(
        crypto.randomUUID(),
        env.OWNER_TELEGRAM_ID,
        JSON.stringify({ mode: v.mode, revision: v.revision + 1 }),
      ),
    ]);
    const row = results[0]?.results[0];
    if (!row)
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        "Another controller changed the receiver state.",
      );
    return json({ runtime: row });
  }
  const parsed = z
    .strictObject({
      instanceId: z.string().uuid(),
      action: z.enum(["claim", "heartbeat", "release"]),
    })
    .safeParse(await readJson(request));
  if (!parsed.success)
    throw new HttpError(400, "INVALID_LEASE", "Invalid receiver lease.");
  const v = parsed.data;
  if (state.mode !== "python")
    throw new HttpError(
      409,
      "RUNTIME_CONFLICT",
      "Python mode is not enabled. Do not poll.",
    );
  const query =
    v.action === "claim"
      ? "UPDATE bot_runtime SET instance_id=?,lease_until=? WHERE id='receiver' AND owner_telegram_id=? AND mode='python' AND (instance_id=? OR lease_until<=?) RETURNING mode,revision,instance_id,lease_until"
      : v.action === "heartbeat"
        ? "UPDATE bot_runtime SET lease_until=? WHERE id='receiver' AND owner_telegram_id=? AND mode='python' AND instance_id=? AND lease_until>? RETURNING mode,revision,instance_id,lease_until"
        : "UPDATE bot_runtime SET instance_id=NULL,lease_until=0 WHERE id='receiver' AND owner_telegram_id=? AND mode='python' AND instance_id=? RETURNING mode,revision,instance_id,lease_until";
  const statement = env.DB.prepare(query);
  const row = await (
    v.action === "claim"
      ? statement.bind(
          v.instanceId,
          now + 120,
          env.OWNER_TELEGRAM_ID,
          v.instanceId,
          now,
        )
      : v.action === "heartbeat"
        ? statement.bind(now + 120, env.OWNER_TELEGRAM_ID, v.instanceId, now)
        : statement.bind(env.OWNER_TELEGRAM_ID, v.instanceId)
  ).first();
  if (!row)
    throw new HttpError(
      409,
      "RECEIVER_LEASE_LOST",
      "Another receiver is active or the lease expired. Stop polling.",
    );
  return json({ runtime: row });
}
