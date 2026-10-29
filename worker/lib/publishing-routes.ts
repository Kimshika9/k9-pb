import { z } from "zod";
import type { Env } from "../env";
import { HttpError, json, readJson } from "./http";
import { DocumentError } from "../../shared/editor/schema";
import { cloneDocument } from "../../shared/editor/operations";
import { storedDocument, validateMediaOwnership } from "./editor-store";
import {
  performDelivery,
  getPostSnapshot,
  getPublication,
  publicPublicationColumns,
  recoverExpiredOperations,
  validateScheduledSnapshot,
  checkChannelPermissions,
  messageUrl,
  requirePublishingSchema,
} from "./publishing";
import type { Publication, DeliverySnapshot } from "../../shared/publishing";
import { requireApprovedChannel, listChannels } from "./channels";
const uuid = z.string().uuid(),
  revision = z.number().int().positive();
const base = { operationId: uuid, revision };
const sendSchema = z.strictObject({ ...base, channelId: uuid });
const previewSchema = z.strictObject(base);
const editSchema = z.strictObject({
  ...base,
  postId: uuid,
  postRevision: revision,
});
const scheduleSchema = z.strictObject({
  ...base,
  channelId: uuid,
  runAt: z.iso.datetime(),
  timezone: z.enum(["UTC", "Asia/Yangon"]),
});
async function input<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readJson(request));
  if (!result.success)
    throw new HttpError(
      400,
      "INVALID_INPUT",
      result.error.issues[0]?.message ?? "Invalid request.",
    );
  return result.data;
}
const recordId = "([A-Za-z0-9_-]{1,80})";
function offset(url: URL): number {
  const n = Number(url.searchParams.get("offset") ?? 0);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new HttpError(400, "INVALID_OFFSET", "Invalid offset.");
  return n;
}
async function schedulePost(
  request: Request,
  env: Env,
  postId: string,
): Promise<Response> {
  const value = await input(request, scheduleSchema);
  const runAt = new Date(value.runAt).toISOString();
  const previous = await env.DB.prepare(
    "SELECT * FROM scheduled_jobs WHERE id=? AND owner_telegram_id=?",
  )
    .bind(value.operationId, env.OWNER_TELEGRAM_ID)
    .first<{
      post_id: string;
      source_revision: number;
      channel_id: string;
      run_at: string;
      timezone: string;
    }>();
  if (previous) {
    if (
      previous.post_id !== postId ||
      previous.source_revision !== value.revision ||
      previous.channel_id !== value.channelId ||
      previous.run_at !== runAt ||
      previous.timezone !== value.timezone
    )
      throw new HttpError(
        409,
        "OPERATION_CONFLICT",
        "Schedule operation ID belongs to different content or time.",
      );
    return json({ job: previous });
  }
  const snapshot = await getPostSnapshot(env, postId, value.revision);
  if (
    Date.parse(runAt) <= Date.now() ||
    Date.parse(runAt) > Date.now() + 366 * 86400000
  )
    throw new HttpError(
      400,
      "INVALID_SCHEDULE",
      "Choose a future time within the next year.",
    );
  await validateScheduledSnapshot(env, snapshot);
  await checkChannelPermissions(env, value.channelId);
  await requireApprovedChannel(env, value.channelId);
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO scheduled_jobs(id,post_id,channel_id,owner_telegram_id,document_json,title,source_revision,run_at,timezone,delivery_state,operation_id) VALUES(?,?,?,?,?,?,?,?,?,'waiting',?) RETURNING *",
      ).bind(
        value.operationId,
        postId,
        value.channelId,
        env.OWNER_TELEGRAM_ID,
        JSON.stringify(snapshot.document),
        snapshot.title,
        snapshot.revision,
        runAt,
        value.timezone,
        crypto.randomUUID(),
      ),
      env.DB.prepare(
        "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) VALUES(?,?,?,'schedule.created',?)",
      ).bind(
        crypto.randomUUID(),
        postId,
        env.OWNER_TELEGRAM_ID,
        JSON.stringify({
          jobId: value.operationId,
          channelId: value.channelId,
          runAt,
        }),
      ),
    ]);
    return json({ job: result[0]!.results[0] }, 201);
  } catch {
    throw new HttpError(
      409,
      "SCHEDULE_CONFLICT",
      "A pending schedule already exists for this post/channel. Refresh and reschedule it.",
    );
  }
}
async function reconcile(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  const value = await input(
    request,
    z.strictObject({
      revision,
      resolution: z.enum(["delivered", "not_delivered"]),
      confirmed: z.literal(true),
      messageId: z.number().int().positive().optional(),
    }),
  );
  const p = await getPublication(env, id);
  if (
    p.status !== "uncertain" ||
    p.revision !== value.revision ||
    !p.active_operation_id
  )
    throw new HttpError(
      409,
      "VERSION_CONFLICT",
      "Only the current uncertain delivery can be reconciled.",
    );
  const op = await env.DB.prepare(
    "SELECT kind,request_json,created_at FROM publishing_operations WHERE id=? AND owner_telegram_id=? AND status='uncertain'",
  )
    .bind(p.active_operation_id, env.OWNER_TELEGRAM_ID)
    .first<{ kind: string; request_json: string; created_at: string }>();
  if (!op)
    throw new HttpError(
      409,
      "OPERATION_CONFLICT",
      "Uncertain operation is unavailable.",
    );
  const delivered = value.resolution === "delivered",
    mutation = op.kind === "edit" || op.kind === "delete";
  const messageId = value.messageId ?? p.telegram_message_id;
  if (delivered && op.kind !== "delete" && !messageId)
    throw new HttpError(
      400,
      "MESSAGE_ID_REQUIRED",
      "Inspect Telegram and provide the confirmed message ID.",
    );
  const snapshot = (
    JSON.parse(op.request_json) as { snapshot: DeliverySnapshot }
  ).snapshot;
  const source = await env.DB.prepare(
    "SELECT id FROM posts WHERE id=? AND (owner_telegram_id=? OR owner_telegram_id IS NULL)",
  )
    .bind(snapshot.postId, env.OWNER_TELEGRAM_ID)
    .first<{ id: string }>();
  const status = delivered
    ? op.kind === "delete"
      ? "deleted"
      : "published"
    : mutation
      ? "published"
      : "failed";
  const destination = p.channel_id
    ? await env.DB.prepare(
        "SELECT telegram_chat_id,username FROM channels WHERE id=? AND approved_by=?",
      )
        .bind(p.channel_id, env.OWNER_TELEGRAM_ID)
        .first<{ telegram_chat_id: string; username: string | null }>()
    : null;
  const chatId =
    p.telegram_chat_id ??
    destination?.telegram_chat_id ??
    env.OWNER_TELEGRAM_ID;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE publications SET status=?,revision=revision+1,active_operation_id=NULL,last_operation_id=?,telegram_message_id=?,published_at=coalesce(published_at,?),document_json=?,title=?,source_revision=?,post_id=?,telegram_chat_id=?,message_url=?,last_error_code=?,delivery_key=CASE WHEN ?=1 THEN delivery_key ELSE NULL END,updated_at=? WHERE id=? AND owner_telegram_id=? AND revision=? AND status='uncertain' RETURNING ${publicPublicationColumns}`,
    ).bind(
      status,
      p.active_operation_id,
      delivered ? messageId : p.telegram_message_id,
      delivered ? op.created_at : null,
      delivered && op.kind !== "delete"
        ? JSON.stringify(snapshot.document)
        : p.document_json,
      delivered && op.kind !== "delete" ? snapshot.title : p.title,
      delivered ? snapshot.revision : p.source_revision,
      delivered ? (source?.id ?? null) : p.post_id,
      delivered ? chatId : p.telegram_chat_id,
      delivered && p.kind !== "preview" && messageId
        ? messageUrl(chatId, destination?.username, messageId)
        : p.message_url,
      delivered ? null : "RECONCILED_NOT_DELIVERED",
      delivered || mutation ? 1 : 0,
      new Date().toISOString(),
      id,
      env.OWNER_TELEGRAM_ID,
      value.revision,
    ),
    env.DB.prepare(
      "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) SELECT ?,?,?,'publication.reconciled',? WHERE changes()=1",
    ).bind(
      crypto.randomUUID(),
      source?.id ?? null,
      env.OWNER_TELEGRAM_ID,
      JSON.stringify({
        publicationId: id,
        operationId: p.active_operation_id,
        resolution: value.resolution,
        ownerConfirmed: true,
      }),
    ),
    env.DB.prepare(
      "UPDATE publishing_operations SET status=?,retryable=0,last_error_code=? WHERE id=? AND owner_telegram_id=? AND EXISTS(SELECT 1 FROM publications WHERE id=? AND last_operation_id=? AND status=?)",
    ).bind(
      delivered ? "succeeded" : "failed",
      delivered ? null : "RECONCILED_NOT_DELIVERED",
      p.active_operation_id,
      env.OWNER_TELEGRAM_ID,
      id,
      p.active_operation_id,
      status,
    ),
    env.DB.prepare(
      "UPDATE scheduled_jobs SET status=?,delivery_state=?,publication_id=? WHERE operation_id=? AND owner_telegram_id=? AND delivery_state='uncertain' AND EXISTS(SELECT 1 FROM publications WHERE id=? AND revision=?)",
    ).bind(
      delivered ? "succeeded" : "failed",
      delivered ? "delivered" : "rejected",
      id,
      p.active_operation_id,
      env.OWNER_TELEGRAM_ID,
      id,
      value.revision + 1,
    ),
  ]);
  if (!results[0]?.results.length)
    throw new HttpError(
      409,
      "VERSION_CONFLICT",
      "Publication changed during reconciliation.",
    );
  return json({
    publication: results[0].results[0],
    verification: "owner-confirmed",
  });
}
export async function publishingRoutes(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname,
    method = request.method;
  try {
    if (
      (path === "/api/status" || path === "/api/doctor") &&
      method === "GET"
    ) {
      await requirePublishingSchema(env);
      const counts = await env.DB.prepare(
        "SELECT (SELECT count(*) FROM publications WHERE owner_telegram_id=? AND kind='publication' AND status='published') AS published,(SELECT count(*) FROM scheduled_jobs WHERE owner_telegram_id=? AND status='pending') AS scheduled,(SELECT count(*) FROM publications WHERE owner_telegram_id=? AND status='uncertain') AS uncertain",
      )
        .bind(
          env.OWNER_TELEGRAM_ID,
          env.OWNER_TELEGRAM_ID,
          env.OWNER_TELEGRAM_ID,
        )
        .first();
      const cron = await env.DB.prepare(
        "SELECT last_run_at,last_error_code FROM scheduler_state WHERE id='cron'",
      ).first();
      return json({
        service: "K9 Post Studio",
        schema: 4,
        counts,
        schedulerEnabled: env.SCHEDULER_ENABLED === "true",
        cron,
        cliAllowedActions: (env.CLI_ALLOWED_ACTIONS ?? "read").split(","),
      });
    }
    const operation = /^\/api\/operations\/([a-f0-9-]{36})$/.exec(path);
    if (operation && method === "GET") {
      await recoverExpiredOperations(env);
      const row = await env.DB.prepare(
        "SELECT id,kind,status,publication_id,last_error_code,retryable,retry_after,created_at FROM publishing_operations WHERE id=? AND owner_telegram_id=?",
      )
        .bind(operation[1]!, env.OWNER_TELEGRAM_ID)
        .first();
      if (row) return json({ operation: row });
      const job = await env.DB.prepare(
        "SELECT id,'schedule' AS kind,status,delivery_state,publication_id,last_error_code FROM scheduled_jobs WHERE id=? AND owner_telegram_id=?",
      )
        .bind(operation[1]!, env.OWNER_TELEGRAM_ID)
        .first();
      if (!job) throw new HttpError(404, "NOT_FOUND", "Operation not found.");
      return json({ operation: job });
    }
    if (path === "/api/posts" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,title,status,revision,updated_at FROM posts WHERE (owner_telegram_id=? OR owner_telegram_id IS NULL) ORDER BY updated_at DESC LIMIT 51 OFFSET ?",
      )
        .bind(env.OWNER_TELEGRAM_ID, offset(url))
        .all();
      return json({
        posts: rows.results.slice(0, 50),
        nextOffset: rows.results.length > 50 ? offset(url) + 50 : null,
      });
    }
    const post = new RegExp(
      "^/api/posts/" + recordId + "(?:/(publish|preview|schedule))?$",
    ).exec(path);
    if (post) {
      const id = post[1]!,
        action = post[2];
      if (!action && method === "GET")
        return json({ post: await getPostSnapshot(env, id) });
      if (method !== "POST")
        throw new HttpError(
          405,
          "METHOD_NOT_ALLOWED",
          "Use POST for delivery actions.",
        );
      if (action === "schedule") return schedulePost(request, env, id);
      if (action === "publish") {
        const v = await input(request, sendSchema);
        return json({
          publication: await performDelivery(env, {
            operationId: v.operationId,
            kind: "publish",
            postId: id,
            postRevision: v.revision,
            channelId: v.channelId,
          }),
        });
      }
      if (action === "preview") {
        const v = await input(request, previewSchema);
        return json({
          publication: await performDelivery(env, {
            operationId: v.operationId,
            kind: "preview",
            postId: id,
            postRevision: v.revision,
          }),
        });
      }
    }
    if (path === "/api/publications" && method === "GET") {
      await recoverExpiredOperations(env);
      const rows = await env.DB.prepare(
        `SELECT ${publicPublicationColumns} FROM publications WHERE owner_telegram_id=? ORDER BY created_at DESC,id LIMIT 21 OFFSET ?`,
      )
        .bind(env.OWNER_TELEGRAM_ID, offset(url))
        .all<Publication>();
      return json({
        publications: rows.results.slice(0, 20),
        nextOffset: rows.results.length > 20 ? offset(url) + 20 : null,
      });
    }
    const publication = new RegExp(
      "^/api/publications/" +
        recordId +
        "(?:/(edit|delete|republish|reconcile|draft))?$",
    ).exec(path);
    if (publication) {
      const id = publication[1]!,
        action = publication[2];
      if (!action && method === "GET") {
        const p = await getPublication(env, id);
        const history = await env.DB.prepare(
          "SELECT id,action,details_json,created_at FROM history WHERE actor_telegram_id=? AND json_extract(details_json,'$.publicationId')=? ORDER BY created_at DESC LIMIT 50",
        )
          .bind(env.OWNER_TELEGRAM_ID, id)
          .all();
        const operations = await env.DB.prepare(
          "SELECT id,kind,status,last_error_code,retryable,retry_after,created_at,json_extract(request_json,'$.snapshot.revision') AS source_revision FROM publishing_operations WHERE publication_id=? AND owner_telegram_id=? ORDER BY created_at DESC LIMIT 50",
        )
          .bind(id, env.OWNER_TELEGRAM_ID)
          .all();
        return json({
          publication: p,
          history: history.results,
          operations: operations.results,
        });
      }
      if (method !== "POST")
        throw new HttpError(
          405,
          "METHOD_NOT_ALLOWED",
          "Use POST for publication actions.",
        );
      if (action === "draft") {
        const v = await input(request, previewSchema),
          p = await getPublication(env, id);
        const existing = await env.DB.prepare(
          "SELECT p.id,p.title,p.document_json,p.revision,p.channel_id AS channelId,p.created_at AS createdAt,p.updated_at AS updatedAt FROM posts p WHERE p.id=? AND p.owner_telegram_id=? AND EXISTS(SELECT 1 FROM history h WHERE h.post_id=p.id AND h.action='publication.edit_draft_created' AND json_extract(h.details_json,'$.publicationId')=? AND json_extract(h.details_json,'$.revision')=?)",
        )
          .bind(v.operationId, env.OWNER_TELEGRAM_ID, id, v.revision)
          .first<Record<string, unknown>>();
        if (existing)
          return json({
            draft: {
              ...existing,
              document: storedDocument(String(existing.document_json)),
            },
          });
        if (p.revision !== v.revision || p.status !== "published")
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Refresh the publication before creating an editing draft.",
          );
        const document = cloneDocument(storedDocument(p.document_json));
        await validateMediaOwnership(env, document, env.OWNER_TELEGRAM_ID);
        const results = await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO posts(id,title,document_json,schema_version,owner_telegram_id) SELECT ?,?,?,2,? FROM publications WHERE id=? AND revision=? AND owner_telegram_id=? AND status='published' RETURNING id,title,document_json,revision,channel_id AS channelId,created_at AS createdAt,updated_at AS updatedAt",
          ).bind(
            v.operationId,
            p.title,
            JSON.stringify(document),
            env.OWNER_TELEGRAM_ID,
            id,
            v.revision,
            env.OWNER_TELEGRAM_ID,
          ),
          env.DB.prepare(
            "UPDATE publications SET edit_draft_id=?,revision=revision+1 WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM posts WHERE id=? AND owner_telegram_id=?)",
          ).bind(
            v.operationId,
            id,
            v.revision,
            v.operationId,
            env.OWNER_TELEGRAM_ID,
          ),
          env.DB.prepare(
            "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) SELECT ?,?,?,'publication.edit_draft_created',? WHERE changes()>0",
          ).bind(
            crypto.randomUUID(),
            v.operationId,
            env.OWNER_TELEGRAM_ID,
            JSON.stringify({ publicationId: id, revision: v.revision }),
          ),
        ]);
        const created = results[0]?.results[0] as
          Record<string, unknown> | undefined;
        if (!created)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Publication changed during draft creation.",
          );
        return json(
          {
            draft: {
              ...created,
              document: storedDocument(String(created.document_json)),
            },
          },
          201,
        );
      }
      if (action === "reconcile") return reconcile(request, env, id);
      if (action === "edit") {
        const v = await input(request, editSchema);
        return json({
          publication: await performDelivery(env, {
            operationId: v.operationId,
            kind: "edit",
            publicationId: id,
            revision: v.revision,
            postId: v.postId,
            postRevision: v.postRevision,
          }),
        });
      }
      if (action === "delete") {
        const v = await input(request, previewSchema);
        return json({
          publication: await performDelivery(env, {
            operationId: v.operationId,
            kind: "delete",
            publicationId: id,
            revision: v.revision,
          }),
        });
      }
      if (action === "republish") {
        const v = await input(request, sendSchema);
        return json({
          publication: await performDelivery(env, {
            operationId: v.operationId,
            kind: "republish",
            publicationId: id,
            revision: v.revision,
            channelId: v.channelId,
          }),
        });
      }
    }
    if (path === "/api/scheduled" && method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,post_id,channel_id,title,source_revision,revision,timezone,status,run_at,delivery_state,attempts,next_attempt_at,lease_until,last_error_code,publication_id FROM scheduled_jobs WHERE owner_telegram_id=? OR (owner_telegram_id IS NULL AND EXISTS(SELECT 1 FROM posts WHERE id=scheduled_jobs.post_id AND (owner_telegram_id=? OR owner_telegram_id IS NULL))) ORDER BY CASE WHEN status IN ('pending','running') THEN 0 ELSE 1 END,run_at,id LIMIT 51 OFFSET ?",
      )
        .bind(env.OWNER_TELEGRAM_ID, env.OWNER_TELEGRAM_ID, offset(url))
        .all();
      return json({
        jobs: rows.results.slice(0, 50),
        nextOffset: rows.results.length > 50 ? offset(url) + 50 : null,
      });
    }
    const scheduled = new RegExp(
      "^/api/scheduled/" + recordId + "/(cancel|reschedule)$",
    ).exec(path);
    if (scheduled && method === "POST") {
      const id = scheduled[1]!,
        action = scheduled[2],
        v = await input(
          request,
          action === "cancel"
            ? previewSchema
            : z.strictObject({
                ...base,
                runAt: z.iso.datetime(),
                timezone: z.enum(["UTC", "Asia/Yangon"]),
              }),
        );
      const job = await env.DB.prepare(
        "SELECT * FROM scheduled_jobs WHERE id=? AND (owner_telegram_id=? OR (owner_telegram_id IS NULL AND EXISTS(SELECT 1 FROM posts WHERE id=scheduled_jobs.post_id AND (owner_telegram_id=? OR owner_telegram_id IS NULL))))",
      )
        .bind(id, env.OWNER_TELEGRAM_ID, env.OWNER_TELEGRAM_ID)
        .first<{
          post_id: string;
          channel_id: string | null;
          revision: number;
          status: string;
        }>();
      if (!job)
        throw new HttpError(404, "NOT_FOUND", "Scheduled job not found.");
      if (
        job.revision !== v.revision ||
        !["pending", "failed"].includes(job.status)
      )
        throw new HttpError(
          409,
          "JOB_IN_PROGRESS",
          "Only the current pending or definitively failed job can be changed.",
        );
      const current = await env.DB.prepare(
        "SELECT delivery_state FROM scheduled_jobs WHERE id=?",
      )
        .bind(id)
        .first<{ delivery_state: string }>();
      if (current?.delivery_state === "uncertain")
        throw new HttpError(
          409,
          "RECONCILIATION_REQUIRED",
          "Reconcile uncertain delivery before rescheduling.",
        );
      if (action === "cancel") {
        const result = await env.DB.batch([
          env.DB.prepare(
            "UPDATE scheduled_jobs SET status='cancelled',delivery_state='cancelled',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status IN ('pending','failed') RETURNING *",
          ).bind(new Date().toISOString(), id, v.revision),
          env.DB.prepare(
            "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) SELECT ?,?,?,'schedule.cancelled',? WHERE changes()=1",
          ).bind(
            crypto.randomUUID(),
            job.post_id,
            env.OWNER_TELEGRAM_ID,
            JSON.stringify({ jobId: id, operationId: v.operationId }),
          ),
        ]);
        const row = result[0]?.results[0];
        if (!row)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Job changed during cancellation.",
          );
        return json({ job: row });
      }
      const rescheduled = v as {
          operationId: string;
          revision: number;
          runAt: string;
          timezone: "UTC" | "Asia/Yangon";
        },
        runAt = new Date(rescheduled.runAt).toISOString();
      if (
        Date.parse(runAt) <= Date.now() ||
        Date.parse(runAt) > Date.now() + 366 * 86400000 ||
        !job.channel_id
      )
        throw new HttpError(
          400,
          "INVALID_SCHEDULE",
          "Choose a future time and approved channel.",
        );
      const snapshot = await getPostSnapshot(env, job.post_id);
      await validateScheduledSnapshot(env, snapshot);
      await checkChannelPermissions(env, job.channel_id);
      await requireApprovedChannel(env, job.channel_id);
      const result = await env.DB.batch([
        env.DB.prepare(
          "UPDATE scheduled_jobs SET status='pending',delivery_state='waiting',owner_telegram_id=?,document_json=?,title=?,source_revision=?,operation_id=?,run_at=?,timezone=?,revision=revision+1,attempts=0,last_error_code=NULL,next_attempt_at=NULL,publication_id=NULL WHERE id=? AND revision=? AND status IN ('pending','failed') RETURNING *",
        ).bind(
          env.OWNER_TELEGRAM_ID,
          JSON.stringify(snapshot.document),
          snapshot.title,
          snapshot.revision,
          crypto.randomUUID(),
          runAt,
          rescheduled.timezone,
          id,
          v.revision,
        ),
        env.DB.prepare(
          "INSERT INTO history(id,post_id,actor_telegram_id,action,details_json) SELECT ?,?,?,'schedule.rescheduled',? WHERE changes()=1",
        ).bind(
          crypto.randomUUID(),
          job.post_id,
          env.OWNER_TELEGRAM_ID,
          JSON.stringify({ jobId: id, operationId: v.operationId, runAt }),
        ),
      ]);
      const row = result[0]?.results[0];
      if (!row)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "Job changed during rescheduling.",
        );
      return json({ job: row });
    }
    if (path === "/api/approved-channels" && method === "GET")
      return json({ channels: await listChannels(env) });
    return null;
  } catch (error) {
    if (error instanceof DocumentError)
      throw new HttpError(422, "INVALID_DOCUMENT", error.message);
    throw error;
  }
}
