import type { TelegramUser } from "../../shared/contracts";
import type { Env } from "../env";
import { HttpError, isRecord } from "./http";

const encoder = new TextEncoder();
export const MAX_AUTH_AGE_SECONDS = 900;
export async function hmac(
  key: Uint8Array,
  value: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)),
  );
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [aa, bb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return equalBytes(new Uint8Array(aa), new Uint8Array(bb));
}
export async function verifyInitData(
  raw: string,
  botToken: string,
  now = Math.floor(Date.now() / 1000),
): Promise<TelegramUser> {
  const invalid = () =>
    new HttpError(
      401,
      "INVALID_AUTH",
      "Open the studio from Telegram to authenticate.",
    );
  if (!raw || raw.length > 16_384 || /%(?![0-9a-f]{2})/i.test(raw))
    throw invalid();
  const params = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
  }
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw invalid();
  params.delete("hash");
  const dataCheckString = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = await hmac(secret, dataCheckString);
  const received = Uint8Array.from(hash.match(/.{2}/g)!, (value) =>
    parseInt(value, 16),
  );
  if (!equalBytes(expected, received)) throw invalid();
  const authDate = params.get("auth_date");
  if (!authDate || !/^\d+$/.test(authDate)) throw invalid();
  const age = now - Number(authDate);
  if (
    !Number.isSafeInteger(Number(authDate)) ||
    age > MAX_AUTH_AGE_SECONDS ||
    age < -30
  )
    throw invalid();
  let user: unknown;
  try {
    user = JSON.parse(params.get("user") ?? "") as unknown;
  } catch {
    throw invalid();
  }
  if (
    !isRecord(user) ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0 ||
    typeof user.first_name !== "string"
  )
    throw invalid();
  // Only validated fields leave the authentication boundary.
  return {
    id: user.id as number,
    first_name: user.first_name,
    ...(typeof user.last_name === "string"
      ? { last_name: user.last_name }
      : {}),
    ...(typeof user.username === "string" ? { username: user.username } : {}),
    ...(typeof user.language_code === "string"
      ? { language_code: user.language_code }
      : {}),
  };
}
export function requireAuthConfig(env: Env): void {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !/^\d+$/.test(env.OWNER_TELEGRAM_ID ?? "") ||
    Number(env.OWNER_TELEGRAM_ID) <= 0 ||
    !Number.isSafeInteger(Number(env.OWNER_TELEGRAM_ID))
  ) {
    throw new HttpError(
      503,
      "NOT_CONFIGURED",
      "The studio is not configured yet.",
    );
  }
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<TelegramUser> {
  requireAuthConfig(env);
  const header = request.headers.get("authorization");
  if (!header?.startsWith("tma "))
    throw new HttpError(
      401,
      "INVALID_AUTH",
      "Telegram authentication is required.",
    );
  const user = await verifyInitData(header.slice(4), env.TELEGRAM_BOT_TOKEN);
  if (String(user.id) !== env.OWNER_TELEGRAM_ID)
    throw new HttpError(
      403,
      "OWNER_ONLY",
      "This studio is private to its owner.",
    );
  return user;
}
