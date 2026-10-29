import { z } from "zod";
import type { MediaItem } from "../../shared/editor/model";
import { isFileId } from "../../shared/editor/schema";
import type { Env } from "../env";
import type { TelegramUser } from "../../shared/contracts";
import { HttpError, isRecord, json, readJson } from "./http";
import { TelegramClient } from "./telegram";
// Studio scope: no uploads/download proxy; reuse bot-owned IDs. Large video delivery is unverified.
export const MEDIA_LIMITS = {
  photo: 10 * 1024 * 1024,
  video: 20 * 1024 * 1024,
  document: 20 * 1024 * 1024,
} as const;
interface Registration {
  fileId: string;
  uniqueId: string;
  kind: "photo" | "video" | "document";
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
}
async function store(env: Env, input: Registration): Promise<MediaItem> {
  if (
    !isFileId(input.fileId) ||
    !input.uniqueId ||
    input.uniqueId.length > 1024
  )
    throw new HttpError(
      400,
      "INVALID_MEDIA",
      "Invalid Telegram media identifiers.",
    );
  if (
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    input.size > MEDIA_LIMITS[input.kind]
  )
    throw new HttpError(
      413,
      "MEDIA_LIMIT",
      `Studio supports ${input.kind} files up to ${MEDIA_LIMITS[input.kind] / 1024 / 1024} MB.`,
    );
  const item = await env.DB.prepare(
    `INSERT INTO media (id,telegram_file_id,file_unique_id,kind,owner_telegram_id,original_name,mime_type,size_bytes,width,height,duration)
 VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET file_unique_id=excluded.file_unique_id
 RETURNING id,telegram_file_id,kind,original_name,mime_type,size_bytes,width,height,duration,created_at`,
  )
    .bind(
      crypto.randomUUID(),
      input.fileId,
      input.uniqueId,
      input.kind,
      env.OWNER_TELEGRAM_ID,
      input.name.slice(0, 200),
      input.mime.slice(0, 100),
      input.size,
      input.width,
      input.height,
      input.duration,
    )
    .first<MediaItem>();
  if (!item) throw new Error("Media registration failed");
  if (item.kind !== input.kind)
    throw new HttpError(
      409,
      "MEDIA_KIND_CONFLICT",
      "This file was registered with a different media type. Choose its existing library entry.",
    );
  return item;
}
export async function mediaRoutes(
  request: Request,
  env: Env,
  user: TelegramUser,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== "/api/media") return null;
  if (request.method === "GET") {
    const kind = url.searchParams.get("kind");
    if (kind && !["photo", "video", "document"].includes(kind))
      throw new HttpError(400, "INVALID_KIND", "Invalid media kind.");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new HttpError(400, "INVALID_OFFSET", "Invalid offset.");
    const result = await env.DB.prepare(
      `SELECT id,telegram_file_id,kind,original_name,mime_type,size_bytes,width,height,duration,created_at FROM media WHERE owner_telegram_id=? AND (? IS NULL OR kind=?) ORDER BY created_at DESC,id LIMIT 51 OFFSET ?`,
    )
      .bind(String(user.id), kind, kind, offset)
      .all<MediaItem>();
    return json({
      media: result.results.slice(0, 50),
      nextOffset: result.results.length > 50 ? offset + 50 : null,
    });
  }
  if (request.method === "POST") {
    const schema = z.strictObject({
      fileId: z.string().refine(isFileId, "Enter a valid Telegram file ID."),
      kind: z.enum(["photo", "video", "document"]),
      name: z.string().trim().min(1).max(200),
    });
    const value = schema.safeParse(await readJson(request));
    if (!value.success)
      throw new HttpError(
        400,
        "INVALID_MEDIA",
        value.error.issues[0]?.message ?? "Invalid media.",
      );
    const file = await new TelegramClient(env.TELEGRAM_BOT_TOKEN).getFile(
      value.data.fileId,
    );
    if (
      !file.file_unique_id ||
      !isFileId(file.file_id) ||
      typeof file.file_size !== "number"
    )
      throw new HttpError(
        502,
        "INVALID_MEDIA",
        "Telegram could not verify this file.",
      );
    const result = await store(env, {
      fileId: file.file_id,
      uniqueId: file.file_unique_id,
      kind: value.data.kind,
      name: value.data.name,
      mime:
        value.data.kind === "photo"
          ? "image/jpeg"
          : value.data.kind === "video"
            ? "video/mp4"
            : "application/octet-stream",
      size: file.file_size,
      width: null,
      height: null,
      duration: null,
    });
    return json({ media: result }, 201);
  }
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
}
export async function registerWebhookMedia(
  message: Record<string, unknown>,
  env: Env,
): Promise<boolean> {
  let source: unknown;
  let kind: Registration["kind"];
  if (Array.isArray(message.photo) && message.photo.length) {
    source = message.photo.at(-1);
    kind = "photo";
  } else if (isRecord(message.video)) {
    source = message.video;
    kind = "video";
  } else if (isRecord(message.document)) {
    source = message.document;
    kind = "document";
  } else return false;
  if (
    !isRecord(source) ||
    typeof source.file_id !== "string" ||
    typeof source.file_unique_id !== "string"
  )
    throw new HttpError(400, "INVALID_MEDIA", "Invalid media metadata.");
  let size = source.file_size;
  if (typeof size !== "number")
    size = (
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN).getFile(source.file_id)
    ).file_size;
  if (typeof size !== "number")
    throw new HttpError(
      400,
      "INVALID_MEDIA",
      "Telegram did not provide a file size.",
    );
  const dimension = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  await store(env, {
    fileId: source.file_id,
    uniqueId: source.file_unique_id,
    kind,
    name:
      typeof source.file_name === "string"
        ? source.file_name
        : `Telegram ${kind}`,
    mime:
      typeof source.mime_type === "string"
        ? source.mime_type
        : kind === "photo"
          ? "image/jpeg"
          : kind === "video"
            ? "video/mp4"
            : "application/octet-stream",
    size,
    width: dimension(source.width),
    height: dimension(source.height),
    duration: dimension(source.duration),
  });
  return true;
}

// Only the signed bot bridge may invoke this; same-bot getFile verifies identifiers/size.
export async function registerBridgeMedia(
  raw: unknown,
  env: Env,
): Promise<MediaItem> {
  const schema = z.strictObject({
    fileId: z.string().refine(isFileId),
    uniqueId: z.string().min(1).max(1024),
    kind: z.enum(["photo", "video", "document"]),
    name: z.string().trim().min(1).max(200),
    mime: z.string().max(100).optional(),
    width: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    height: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    duration: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, "INVALID_MEDIA", "Invalid bot media metadata.");
  const value = parsed.data,
    file = await new TelegramClient(env.TELEGRAM_BOT_TOKEN).getFile(
      value.fileId,
    );
  if (
    !isFileId(file.file_id) ||
    file.file_unique_id !== value.uniqueId ||
    typeof file.file_size !== "number"
  )
    throw new HttpError(
      422,
      "INVALID_MEDIA",
      "Telegram did not confirm the media identity and size.",
    );
  return store(env, {
    fileId: file.file_id,
    uniqueId: file.file_unique_id,
    kind: value.kind,
    name: value.name,
    mime:
      value.mime ??
      (value.kind === "photo"
        ? "image/jpeg"
        : value.kind === "video"
          ? "video/mp4"
          : "application/octet-stream"),
    size: file.file_size,
    width: value.width ?? null,
    height: value.height ?? null,
    duration: value.duration ?? null,
  });
}
