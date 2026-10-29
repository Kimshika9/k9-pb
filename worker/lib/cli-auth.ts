import type { Env } from "../env";
import type { TelegramUser } from "../../shared/contracts";
import { hmac, equalBytes, requireAuthConfig } from "./auth";
import { HttpError, readBody } from "./http";
import { sha256 } from "./publishing";
const scopes = new Set(["read", "preview", "publish"]);
const bridgeScopes = new Set([
  "read",
  "preview",
  "publish",
  "schedule",
  "cancel",
  "media",
  "create",
  "runtime",
]);
export function getBridgeActions(env: Env): string[] {
  return [
    ...new Set(
      (env.K9_BRIDGE_ALLOWED_ACTIONS ?? "read")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => bridgeScopes.has(x)),
    ),
  ];
}
export async function authenticateSigned(
  request: Request,
  env: Env,
  bridge = false,
): Promise<{ request: Request; user: TelegramUser; url: URL }> {
  requireAuthConfig(env);
  const secret = bridge ? env.K9_BRIDGE_SECRET : env.CLI_AUTH_SECRET;
  if (
    !secret ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(secret) ||
    secret !== secret.trim() ||
    secret.startsWith("replace_")
  )
    throw new HttpError(
      503,
      bridge ? "BRIDGE_NOT_CONFIGURED" : "CLI_NOT_CONFIGURED",
      "The private controller API is not configured.",
    );
  if (!env.DB || typeof env.DB.prepare !== "function")
    throw new HttpError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Studio storage is not configured.",
    );
  const original = new URL(request.url);
  const timestamp = request.headers.get("X-K9-Timestamp") ?? "",
    nonce = request.headers.get("X-K9-Nonce") ?? "",
    signature = request.headers.get("X-K9-Signature") ?? "";
  const now = Math.floor(Date.now() / 1000);
  if (
    !/^[1-9]\d{9,12}$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now - Number(timestamp)) > 60 ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new HttpError(
      401,
      bridge ? "INVALID_BRIDGE_AUTH" : "INVALID_CLI_AUTH",
      "Controller signature is missing, malformed or expired.",
    );
  const bytes = await readBody(request);
  const check = `${timestamp}\n${nonce}\n${request.method.toUpperCase()}\n${original.pathname + original.search}\n${await sha256(bytes)}`;
  const expected = await hmac(new TextEncoder().encode(secret), check);
  const supplied = Uint8Array.from(signature.match(/.{2}/g)!, (value) =>
    parseInt(value, 16),
  );
  if (!equalBytes(expected, supplied))
    throw new HttpError(
      401,
      bridge ? "INVALID_BRIDGE_AUTH" : "INVALID_CLI_AUTH",
      "Controller signature verification failed.",
    );
  const path = original.pathname.replace(
    bridge ? /^\/api\/bridge\// : /^\/api\/cli\//,
    "/api/",
  );
  const action = bridge
    ? bridgeAction(request.method, path)
    : request.method === "GET" &&
        /^\/api\/(doctor|status|channels|posts(?:\/[A-Za-z0-9_-]{1,80})?|scheduled|operations\/[a-f0-9-]{36})$/.test(
          path,
        )
      ? "read"
      : request.method === "POST" &&
          /^\/api\/posts\/[A-Za-z0-9_-]{1,80}\/(preview|publish)$/.test(path)
        ? path.endsWith("/preview")
          ? "preview"
          : "publish"
        : null;
  const allowed = bridge
    ? getBridgeActions(env)
    : (env.CLI_ALLOWED_ACTIONS ?? "read")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => scopes.has(x));
  if (!action || !allowed.includes(action))
    throw new HttpError(
      403,
      bridge ? "BRIDGE_SCOPE_DENIED" : "CLI_SCOPE_DENIED",
      "This controller credential does not permit that action.",
    );
  if (
    bridge &&
    !(await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_rate_limits'",
    ).first())
  )
    throw new HttpError(
      503,
      "BRIDGE_SCHEMA_NOT_READY",
      "Apply the reviewed Python bridge migration.",
    );
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cli_nonces WHERE expires_at<?").bind(now),
      env.DB.prepare(
        "INSERT INTO cli_nonces(nonce,owner_telegram_id,expires_at) VALUES(?,?,?)",
      ).bind(nonce, env.OWNER_TELEGRAM_ID, now + 180),
    ]);
  } catch {
    const replay = await env.DB.prepare(
      "SELECT nonce FROM cli_nonces WHERE nonce=?",
    )
      .bind(nonce)
      .first()
      .catch(() => null);
    if (replay)
      throw new HttpError(
        401,
        bridge ? "BRIDGE_REPLAY" : "CLI_REPLAY",
        "This signed request was already used. Sign a fresh request with a new nonce.",
      );
    throw new HttpError(
      503,
      bridge ? "BRIDGE_SCHEMA_NOT_READY" : "CLI_SCHEMA_NOT_READY",
      "The controller replay-protection migration is not ready.",
    );
  }
  if (bridge) {
    const bucket = Math.floor(now / 60),
      limit = request.method === "GET" ? 120 : 30;
    const result = await env.DB.prepare(
      "INSERT INTO bridge_rate_limits(id,window,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET window=excluded.window,count=CASE WHEN bridge_rate_limits.window=excluded.window THEN bridge_rate_limits.count+1 ELSE 1 END WHERE bridge_rate_limits.window<>excluded.window OR bridge_rate_limits.count<? RETURNING count",
    )
      .bind(
        env.OWNER_TELEGRAM_ID +
          ":" +
          (request.method === "GET" ? "read" : "write"),
        bucket,
        limit,
      )
      .first();
    if (!result)
      throw new HttpError(
        429,
        "BRIDGE_RATE_LIMIT",
        "Controller rate limit reached. Wait until the next minute; inspect writes before retrying.",
      );
  }
  original.pathname = path;
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : bytes.length
        ? (bytes as BodyInit)
        : undefined;
  const forwarded = new Request(original, {
    method: request.method,
    headers: request.headers,
    ...(body !== undefined ? { body } : {}),
  });
  return {
    request: forwarded,
    user: {
      id: Number(env.OWNER_TELEGRAM_ID),
      first_name: "Studio controller",
    },
    url: original,
  };
}

function bridgeAction(method: string, path: string): string | null {
  if (
    method === "GET" &&
    /^\/api\/(identity|runtime|doctor|status|channels|posts(?:\/[A-Za-z0-9_-]{1,80})?|drafts(?:\/[a-f0-9-]{36}(?:\/export)?)?|publications(?:\/[A-Za-z0-9_-]{1,80})?|scheduled(?:\/[A-Za-z0-9_-]{1,80})?|templates|media|operations\/[a-f0-9-]{36})$/.test(
      path,
    )
  )
    return "read";
  if (method !== "POST") return null;
  if (/^\/api\/posts\/[A-Za-z0-9_-]{1,80}\/check$/.test(path)) return "read";
  if (
    /^\/api\/posts\/[A-Za-z0-9_-]{1,80}\/(preview|publish|schedule)$/.test(path)
  )
    return path.split("/").at(-1)!;
  if (/^\/api\/scheduled\/[A-Za-z0-9_-]{1,80}\/cancel$/.test(path))
    return "cancel";
  if (path === "/api/media/register") return "media";
  if (path === "/api/drafts") return "create";
  if (path === "/api/runtime" || path === "/api/runtime/lease")
    return "runtime";
  return null;
}
export const authenticateCli = (request: Request, env: Env) =>
  authenticateSigned(request, env);
export const authenticateBridge = (request: Request, env: Env) =>
  authenticateSigned(request, env, true);
