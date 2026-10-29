import type { Env } from "../env";
import type { DeliverySnapshot, Publication } from "../../shared/publishing";
import type { EditorDocument } from "../../shared/editor/model";
import {
  serializeRichMessage,
  validateForTelegram,
} from "../../shared/editor/telegram";
import { isFileId } from "../../shared/editor/schema";
import { DocumentError } from "../../shared/editor/schema";
import { storedDocument, validateMediaOwnership } from "./editor-store";
import { requireAuthConfig } from "./auth";
import { requireApprovedChannel } from "./channels";
import { HttpError } from "./http";
import { TelegramClient, TelegramDeliveryError } from "./telegram";
import { MEDIA_LIMITS } from "./media";

export type DeliveryKind =
  "publish" | "preview" | "republish" | "edit" | "delete";
export interface DeliveryInput {
  operationId: string;
  kind: DeliveryKind;
  postId?: string;
  postRevision?: number;
  channelId?: string;
  publicationId?: string;
  revision?: number;
}
interface Operation {
  id: string;
  owner_telegram_id: string;
  kind: DeliveryKind;
  fingerprint: string;
  request_json: string;
  publication_id: string | null;
  status: "preparing" | "sending" | "succeeded" | "failed" | "uncertain";
  lease_token: string;
  lease_until: number;
  retryable: number;
  retry_after: number;
  last_error_code: string | null;
}
export interface JobExecution {
  id: string;
  token: string;
  snapshot: DeliverySnapshot;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export const publicPublicationColumns =
  "id,post_id,edit_draft_id,origin_post_id,channel_id,kind,title,document_json,source_revision,revision,status,telegram_message_id,telegram_chat_id,message_url,operation_id,active_operation_id,last_error_code,published_at,created_at,updated_at";
export async function requirePublishingSchema(env: Env): Promise<void> {
  const guard = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='publications_active_source'",
  ).first<{ sql: string }>();
  if (!guard?.sql.includes("'uncertain'"))
    throw new HttpError(
      503,
      "SCHEMA_NOT_READY",
      "Publishing migrations are not ready. Apply the reviewed pending migrations before enabling delivery.",
    );
}
export async function getPublication(
  env: Env,
  id: string,
): Promise<Publication> {
  const row = await env.DB.prepare(
    `SELECT ${publicPublicationColumns} FROM publications WHERE id=? AND owner_telegram_id=?`,
  )
    .bind(id, env.OWNER_TELEGRAM_ID)
    .first<Publication>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Publication not found.");
  return row;
}
export async function getPostSnapshot(
  env: Env,
  id: string,
  revision?: number,
): Promise<DeliverySnapshot> {
  const row = await env.DB.prepare(
    "SELECT id,title,document_json,revision,status FROM posts WHERE id=? AND (owner_telegram_id=? OR owner_telegram_id IS NULL)",
  )
    .bind(id, env.OWNER_TELEGRAM_ID)
    .first<{
      id: string;
      title: string;
      document_json: string;
      revision: number;
      status: string;
    }>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Source post not found.");
  if (revision !== undefined && row.revision !== revision)
    throw new HttpError(
      409,
      "VERSION_CONFLICT",
      "The source draft changed. Reload before sending.",
    );
  return {
    postId: row.id,
    title: row.title,
    revision: row.revision,
    document: storedDocument(row.document_json),
  };
}
export function publicationHistory(
  env: Env,
  publicationId: string,
  action: string,
  postId: string | null = null,
  details: Record<string, unknown> = {},
) {
  return env.DB.prepare(
    "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) VALUES(?,?,?,?,?)",
  ).bind(
    crypto.randomUUID(),
    postId,
    env.OWNER_TELEGRAM_ID,
    action,
    JSON.stringify({ publicationId, ...details }),
  );
}
export async function recoverExpiredOperations(env: Env): Promise<void> {
  const now = nowSeconds();
  const rows = await env.DB.prepare(
    "SELECT * FROM publishing_operations WHERE owner_telegram_id=? AND status IN ('preparing','sending') AND lease_until<? LIMIT 5",
  )
    .bind(env.OWNER_TELEGRAM_ID, now)
    .all<Operation>();
  for (const op of rows.results) {
    const uncertain = op.status === "sending";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE publishing_operations SET status=?,retryable=?,last_error_code=?,updated_at=? WHERE id=? AND lease_token=? AND status=? AND lease_until<?",
      ).bind(
        uncertain ? "uncertain" : "failed",
        uncertain ? 0 : 1,
        uncertain ? "DELIVERY_UNCERTAIN" : "PREPARATION_EXPIRED",
        new Date().toISOString(),
        op.id,
        op.lease_token,
        op.status,
        now,
      ),
      env.DB.prepare(
        `UPDATE publications SET status=?,last_error_code=?,active_operation_id=?,delivery_key=CASE WHEN ?=1 THEN delivery_key ELSE NULL END WHERE active_operation_id=? AND owner_telegram_id=? AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=? AND status=?)`,
      ).bind(
        uncertain
          ? "uncertain"
          : op.kind === "edit" || op.kind === "delete"
            ? "published"
            : "failed",
        uncertain ? "DELIVERY_UNCERTAIN" : "PREPARATION_EXPIRED",
        uncertain ? op.id : null,
        uncertain || op.kind === "edit" || op.kind === "delete" ? 1 : 0,
        op.id,
        env.OWNER_TELEGRAM_ID,
        op.id,
        uncertain ? "uncertain" : "failed",
      ),
    ]);
  }
}
async function acquire(
  env: Env,
  input: DeliveryInput,
): Promise<{ op: Operation; done: boolean }> {
  await recoverExpiredOperations(env);
  const fingerprint = await sha256(canonical(input)),
    token = crypto.randomUUID(),
    now = nowSeconds();
  const created = await env.DB.prepare(
    "INSERT INTO publishing_operations(id,owner_telegram_id,kind,fingerprint,request_json,status,lease_token,lease_until) VALUES(?,?,?,?,?,'preparing',?,?) ON CONFLICT(id) DO NOTHING RETURNING *",
  )
    .bind(
      input.operationId,
      env.OWNER_TELEGRAM_ID,
      input.kind,
      fingerprint,
      JSON.stringify({ input }),
      token,
      now + 180,
    )
    .first<Operation>();
  if (created) return { op: created, done: false };
  const previous = await env.DB.prepare(
    "SELECT * FROM publishing_operations WHERE id=? AND owner_telegram_id=?",
  )
    .bind(input.operationId, env.OWNER_TELEGRAM_ID)
    .first<Operation>();
  if (!previous || previous.fingerprint !== fingerprint)
    throw new HttpError(
      409,
      "OPERATION_CONFLICT",
      "This operation ID belongs to a different request.",
    );
  if (previous.status === "succeeded") return { op: previous, done: true };
  if (previous.status === "uncertain")
    throw new HttpError(
      409,
      "DELIVERY_UNCERTAIN",
      "Inspect Telegram and reconcile this operation before trying again.",
    );
  if (previous.status !== "failed")
    throw new HttpError(
      409,
      "OPERATION_IN_PROGRESS",
      "This operation is already running. Refresh its status instead of sending again.",
    );
  if (!previous.retryable)
    throw new HttpError(
      409,
      previous.last_error_code ?? "DELIVERY_FAILED",
      "This operation failed definitively. Correct the issue and start a new operation.",
    );
  if (previous.lease_until > now)
    throw new HttpError(
      429,
      "TELEGRAM_RATE_LIMIT",
      `Retry in ${previous.lease_until - now} seconds using the same operation ID.`,
    );
  const reclaimed = await env.DB.prepare(
    "UPDATE publishing_operations SET status='preparing',lease_token=?,lease_until=?,last_error_code=NULL WHERE id=? AND status='failed' AND retryable=1 AND lease_until<=? RETURNING *",
  )
    .bind(token, now + 180, previous.id, now)
    .first<Operation>();
  if (!reclaimed)
    throw new HttpError(
      409,
      "OPERATION_IN_PROGRESS",
      "Another request is already retrying this operation.",
    );
  return { op: reclaimed, done: false };
}
export async function checkChannelPermissions(
  env: Env,
  channelId: string,
  deleting = false,
) {
  const channel = await requireApprovedChannel(env, channelId),
    bot = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  const chat = await bot.getChat(channel.telegram_chat_id),
    me = await bot.getMe();
  if (
    chat.type !== "channel" ||
    String(chat.id) !== channel.telegram_chat_id ||
    !Number.isSafeInteger(me.id) ||
    me.id <= 0
  )
    throw new HttpError(
      400,
      "INVALID_CHANNEL",
      "Telegram did not confirm the approved channel.",
    );
  const [member, owner] = await Promise.all([
    bot.getChatMember(channel.telegram_chat_id, me.id),
    bot.getChatMember(channel.telegram_chat_id, Number(env.OWNER_TELEGRAM_ID)),
  ]);
  if (
    member.status !== "administrator" ||
    !(
      member.can_post_messages === true ||
      (deleting && member.can_delete_messages === true)
    )
  )
    throw new HttpError(
      403,
      "BOT_PERMISSION",
      "The bot needs channel administrator permissions for this action.",
    );
  if (!["administrator", "creator"].includes(owner.status))
    throw new HttpError(
      403,
      "CHANNEL_PERMISSION",
      "The owner no longer has administrator access to this channel.",
    );
  return { ...channel, username: chat.username ?? channel.username };
}
export async function validateSnapshot(
  env: Env,
  snapshot: DeliverySnapshot,
  verifyFiles = true,
) {
  const issues = validateForTelegram(snapshot.document);
  if (issues.length)
    throw new HttpError(
      422,
      "INVALID_MESSAGE",
      issues.map((x) => x.message).join("\n"),
    );
  await validateMediaOwnership(env, snapshot.document, env.OWNER_TELEGRAM_ID);
  const mediaIds = new Set<string>();
  function collect(blocks: EditorDocument["blocks"]) {
    for (const block of blocks) {
      if (block.type === "details" || block.type === "blockquote")
        collect(block.blocks);
      if (
        (block.type === "photo" ||
          block.type === "video" ||
          block.type === "document") &&
        block.media
      )
        mediaIds.add(block.media.fileId);
    }
  }
  collect(snapshot.document.blocks);
  if (mediaIds.size > 10)
    throw new HttpError(
      422,
      "STUDIO_MEDIA_LIMIT",
      "Studio live deliveries support at most 10 distinct media files per message to stay within the Worker request budget. Split this post.",
    );
  if (!verifyFiles) return;
  const ids = new Set<string>(),
    bot = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  async function walk(blocks: EditorDocument["blocks"]) {
    for (const block of blocks) {
      if (block.type === "details" || block.type === "blockquote")
        await walk(block.blocks);
      if (
        (block.type === "photo" ||
          block.type === "video" ||
          block.type === "document") &&
        block.media &&
        !ids.has(block.media.fileId)
      ) {
        ids.add(block.media.fileId);
        const file = await bot.getFile(block.media.fileId);
        if (
          !isFileId(file.file_id) ||
          !file.file_unique_id ||
          (file.file_size !== undefined &&
            (!Number.isSafeInteger(file.file_size) ||
              file.file_size < 0 ||
              file.file_size > MEDIA_LIMITS[block.type]))
        )
          throw new HttpError(
            422,
            "INVALID_MEDIA",
            "Telegram did not confirm a supported media file.",
          );
      }
    }
  }
  await walk(snapshot.document.blocks);
}
export async function validateScheduledSnapshot(
  env: Env,
  snapshot: DeliverySnapshot,
) {
  await validateSnapshot(env, snapshot, false);
}
function previewPayload(snapshot: DeliverySnapshot) {
  const document = structuredClone(snapshot.document);
  function safe(blocks: EditorDocument["blocks"]) {
    for (const b of blocks) {
      if (b.type === "details" || b.type === "blockquote") safe(b.blocks);
      if (b.type === "buttons")
        for (const button of b.buttons)
          if (button.action.type === "callback")
            button.action.value = "k9:preview";
    }
  }
  safe(document.blocks);
  const rich = serializeRichMessage(document);
  rich.blocks.unshift({
    type: "heading",
    size: 6,
    text: ["K9 · TEST PREVIEW — not published"],
  });
  return rich;
}
export function messageUrl(
  chatId: string,
  username: string | null | undefined,
  id: number,
): string | null {
  if (username && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))
    return `https://t.me/${username}/${id}`;
  return /^-100\d+$/.test(chatId)
    ? `https://t.me/c/${chatId.slice(4)}/${id}`
    : null;
}
export async function performDelivery(
  env: Env,
  input: DeliveryInput,
  job?: JobExecution,
): Promise<Publication> {
  requireAuthConfig(env);
  await requirePublishingSchema(env);
  const { op, done } = await acquire(env, input);
  if (done && op.publication_id) return getPublication(env, op.publication_id);
  let publication: Publication | null = null,
    dispatched = false,
    confirmedId: number | null = null;
  const mutating = input.kind === "edit" || input.kind === "delete";
  try {
    const saved = JSON.parse(op.request_json) as {
      snapshot?: DeliverySnapshot;
    };
    const target = input.publicationId
      ? await getPublication(env, input.publicationId)
      : null;
    if (
      mutating &&
      (!target ||
        target.kind === "preview" ||
        target.revision !== input.revision ||
        (target.status !== "published" && target.active_operation_id !== op.id))
    )
      throw new HttpError(
        409,
        "VERSION_CONFLICT",
        "Refresh the published message before changing it.",
      );
    if (
      input.kind === "republish" &&
      (!target ||
        target.revision !== input.revision ||
        !["published", "deleted", "failed"].includes(target.status))
    )
      throw new HttpError(
        409,
        "RECONCILIATION_REQUIRED",
        "Refresh or reconcile the source publication before making a copy.",
      );
    let snapshot: DeliverySnapshot;
    if (input.kind === "republish" || input.kind === "delete") {
      if (!target)
        throw new HttpError(404, "NOT_FOUND", "Publication not found.");
      snapshot = {
        postId: target.post_id ?? target.origin_post_id,
        title: target.title,
        revision: target.source_revision,
        document:
          input.kind === "delete"
            ? { version: 2, blocks: [] }
            : storedDocument(target.document_json),
      };
    } else
      snapshot =
        job?.snapshot ??
        saved.snapshot ??
        (await getPostSnapshot(env, input.postId!, input.postRevision));
    // A scheduled or retried send may use an immutable snapshot, but never a deleted/foreign source.
    if (
      input.kind === "publish" ||
      input.kind === "preview" ||
      input.kind === "edit"
    )
      await getPostSnapshot(env, snapshot.postId);
    if (input.kind !== "delete") await validateSnapshot(env, snapshot);
    const channelId = mutating
      ? target!.channel_id
      : input.kind === "preview"
        ? null
        : input.channelId!;
    const channel = channelId
      ? await checkChannelPermissions(env, channelId, input.kind === "delete")
      : null;
    const chatId = channel?.telegram_chat_id ?? env.OWNER_TELEGRAM_ID;
    if (
      input.kind === "delete" &&
      (!target!.telegram_message_id ||
        !target!.published_at ||
        !Number.isFinite(Date.parse(target!.published_at)) ||
        Date.now() - Date.parse(target!.published_at) >= 48 * 60 * 60 * 1000)
    )
      throw new HttpError(
        400,
        "DELETE_WINDOW_EXPIRED",
        "Telegram deletion is limited to recent messages (normally under 48 hours). The draft and history are preserved.",
      );
    const source = await env.DB.prepare(
      "SELECT id FROM posts WHERE id=? AND (owner_telegram_id=? OR owner_telegram_id IS NULL)",
    )
      .bind(snapshot.postId, env.OWNER_TELEGRAM_ID)
      .first<{ id: string }>();
    const deliveryKey =
      input.kind === "publish"
        ? job
          ? `schedule:${job.id}`
          : `${snapshot.postId}:${snapshot.revision}:${channelId}`
        : null;
    const requestJSON = JSON.stringify({ input, snapshot });
    if (mutating) {
      publication = await env.DB.prepare(
        "UPDATE publications SET status='preparing',active_operation_id=?,last_error_code=NULL WHERE id=? AND owner_telegram_id=? AND revision=? AND (status='published' OR active_operation_id=?) RETURNING " +
          publicPublicationColumns,
      )
        .bind(op.id, target!.id, env.OWNER_TELEGRAM_ID, input.revision!, op.id)
        .first<Publication>();
      if (!publication)
        throw new HttpError(
          409,
          "PUBLICATION_BUSY",
          "The publication is already being changed.",
        );
    } else if (op.publication_id) {
      publication = await env.DB.prepare(
        "UPDATE publications SET status='preparing',active_operation_id=?,delivery_key=?,last_error_code=NULL WHERE id=? AND owner_telegram_id=? AND status IN ('failed','preparing') RETURNING " +
          publicPublicationColumns,
      )
        .bind(op.id, deliveryKey, op.publication_id, env.OWNER_TELEGRAM_ID)
        .first<Publication>();
    } else {
      publication = await env.DB.prepare(
        `INSERT INTO publications(id,post_id,origin_post_id,channel_id,owner_telegram_id,kind,title,document_json,source_revision,status,operation_id,active_operation_id,delivery_key) VALUES(?,?,?,?,?,?,?,?,?,'preparing',?,?,?) RETURNING ${publicPublicationColumns}`,
      )
        .bind(
          crypto.randomUUID(),
          source?.id ?? null,
          snapshot.postId,
          channelId,
          env.OWNER_TELEGRAM_ID,
          input.kind === "preview" ? "preview" : "publication",
          snapshot.title,
          JSON.stringify(snapshot.document),
          snapshot.revision,
          op.id,
          op.id,
          deliveryKey,
        )
        .first<Publication>();
    }
    if (!publication)
      throw new HttpError(
        409,
        "PUBLICATION_BUSY",
        "Could not reserve this publication.",
      );
    await env.DB.prepare(
      "UPDATE publishing_operations SET publication_id=?,request_json=? WHERE id=? AND lease_token=? AND status='preparing'",
    )
      .bind(publication.id, requestJSON, op.id, op.lease_token)
      .run();
    // Last approval and lease checks immediately precede the external mutation.
    if (channelId) await requireApprovedChannel(env, channelId);
    if (job) {
      const gate = await env.DB.prepare(
        "UPDATE scheduled_jobs SET delivery_state='sending' WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND delivery_state='preparing' RETURNING id",
      )
        .bind(job.id, job.token, new Date().toISOString())
        .first();
      if (!gate)
        throw new HttpError(
          409,
          "JOB_CANCELLED",
          "The scheduled job lost its lease or was cancelled.",
        );
    }
    const transition = await env.DB.batch([
      env.DB.prepare(
        "UPDATE publishing_operations SET status='sending' WHERE id=? AND status='preparing' AND lease_token=? AND lease_until>=? RETURNING id",
      ).bind(op.id, op.lease_token, nowSeconds()),
      env.DB.prepare(
        "UPDATE publications SET status='sending' WHERE id=? AND active_operation_id=? AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=? AND status='sending' AND lease_token=?) RETURNING id",
      ).bind(publication.id, op.id, op.id, op.lease_token),
    ]);
    if (!transition[0]?.results.length || !transition[1]?.results.length)
      throw new HttpError(
        409,
        "LEASE_LOST",
        "Delivery lease expired before sending.",
      );
    dispatched = true;
    const bot = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    let publishedAt = publication.published_at,
      messageId = publication.telegram_message_id;
    if (input.kind === "delete") await bot.deleteMessage(chatId, messageId!);
    else {
      const payload =
        input.kind === "preview"
          ? previewPayload(snapshot)
          : serializeRichMessage(snapshot.document);
      const message =
        input.kind === "edit"
          ? await bot.editRichMessage(chatId, messageId!, payload)
          : await bot.sendRichMessage(chatId, payload);
      messageId = message.message_id;
      confirmedId = messageId;
      if (input.kind !== "edit")
        publishedAt =
          typeof message.date === "number" && Number.isSafeInteger(message.date)
            ? new Date(message.date * 1000).toISOString()
            : new Date().toISOString();
    }
    const timestamp = new Date().toISOString(),
      status = input.kind === "delete" ? "deleted" : "published";
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE publications SET status=?,telegram_message_id=?,telegram_chat_id=?,message_url=?,published_at=?,document_json=?,title=?,source_revision=?,post_id=?,revision=revision+?,active_operation_id=NULL,last_operation_id=?,last_error_code=NULL,updated_at=? WHERE id=? AND active_operation_id=? AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=? AND status='sending' AND lease_token=?) RETURNING ${publicPublicationColumns}`,
      ).bind(
        status,
        messageId,
        chatId,
        publication.kind === "preview"
          ? null
          : messageUrl(chatId, channel?.username, messageId!),
        publishedAt,
        input.kind === "delete"
          ? target!.document_json
          : JSON.stringify(snapshot.document),
        snapshot.title,
        snapshot.revision,
        source?.id ?? null,
        mutating ? 1 : 0,
        op.id,
        timestamp,
        publication.id,
        op.id,
        op.id,
        op.lease_token,
      ),
      env.DB.prepare(
        "UPDATE publishing_operations SET status='succeeded',retryable=0,updated_at=? WHERE id=? AND lease_token=? AND EXISTS(SELECT 1 FROM publications WHERE id=? AND last_operation_id=?) RETURNING id",
      ).bind(timestamp, op.id, op.lease_token, publication.id, op.id),
      env.DB.prepare(
        "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) SELECT ?,?,?,?,? WHERE changes()>0",
      ).bind(
        crypto.randomUUID(),
        source?.id ?? null,
        env.OWNER_TELEGRAM_ID,
        `publication.${input.kind}`,
        JSON.stringify({
          publicationId: publication.id,
          operationId: op.id,
          messageId,
        }),
      ),
    ]);
    if (!results[0]?.results.length || !results[1]?.results.length)
      throw new Error("Completion not recorded");
    return results[0].results[0] as unknown as Publication;
  } catch (error) {
    const uncertain =
      dispatched &&
      (!(error instanceof HttpError) ||
        (error instanceof TelegramDeliveryError && error.uncertain));
    const failure = uncertain
      ? new TelegramDeliveryError(
          "DELIVERY_UNCERTAIN",
          "Telegram delivery or database completion is uncertain. Inspect Telegram and reconcile before resending.",
          true,
          false,
        )
      : error instanceof HttpError
        ? error
        : error instanceof DocumentError
          ? new HttpError(422, "INVALID_DOCUMENT", error.message)
          : job
            ? new TelegramDeliveryError(
                "SCHEDULE_TARGET_BUSY",
                "This target is busy. The scheduler will retry safely.",
                false,
                true,
                30,
              )
            : new HttpError(
                409,
                "PUBLICATION_CONFLICT",
                "Another publication or schedule holds this target. Refresh the workspace.",
              );
    const retryable =
      failure instanceof TelegramDeliveryError && failure.retryable;
    const retryAfter =
      failure instanceof TelegramDeliveryError ? failure.retryAfter : 0;
    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE publishing_operations SET status=?,retryable=?,retry_after=?,last_error_code=?,lease_until=?,updated_at=? WHERE id=? AND lease_token=? AND status IN ('preparing','sending') RETURNING id",
        ).bind(
          uncertain ? "uncertain" : "failed",
          retryable ? 1 : 0,
          retryAfter,
          failure.code,
          nowSeconds() + retryAfter,
          new Date().toISOString(),
          op.id,
          op.lease_token,
        ),
        env.DB.prepare(
          "UPDATE publications SET status=?,last_error_code=?,active_operation_id=?,delivery_key=CASE WHEN ?=1 THEN delivery_key ELSE NULL END,telegram_message_id=coalesce(telegram_message_id,?) WHERE id=? AND active_operation_id=? AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=? AND status=?)",
        ).bind(
          uncertain ? "uncertain" : mutating ? "published" : "failed",
          failure.code,
          uncertain ? op.id : null,
          uncertain || mutating ? 1 : 0,
          confirmedId,
          publication?.id ?? null,
          op.id,
          op.id,
          uncertain ? "uncertain" : "failed",
        ),
        publicationHistory(
          env,
          publication?.id ?? "",
          `publication.${uncertain ? "uncertain" : "failed"}`,
          null,
          { operationId: op.id, errorCode: failure.code },
        ),
      ]);
    } catch {
      /* The persisted sending lease will become uncertain, never an automatic resend. */
    }
    throw failure;
  }
}
