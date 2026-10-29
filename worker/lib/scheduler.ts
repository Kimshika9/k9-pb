import type { Env } from "../env";
import type { ScheduledJob, DeliverySnapshot } from "../../shared/publishing";
import { storedDocument } from "./editor-store";
import { HttpError } from "./http";
import { requireAuthConfig } from "./auth";
import { TelegramDeliveryError } from "./telegram";
import {
  performDelivery,
  recoverExpiredOperations,
  requirePublishingSchema,
} from "./publishing";
interface JobRow extends ScheduledJob {
  owner_telegram_id: string | null;
  document_json: string | null;
  operation_id: string | null;
  lease_token: string | null;
}
export async function runScheduler(
  env: Env,
): Promise<{ processed: number; enabled: boolean }> {
  if (env.SCHEDULER_ENABLED !== "true") return { processed: 0, enabled: false };
  requireAuthConfig(env);
  await requirePublishingSchema(env);
  await recoverExpiredOperations(env);
  const now = new Date().toISOString();
  // A known operation receipt repairs a crashed job completion; sending without one is uncertain.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scheduled_jobs SET status='succeeded',delivery_state='delivered',last_error_code=NULL,publication_id=(SELECT publication_id FROM publishing_operations WHERE id=scheduled_jobs.operation_id),lease_token=NULL,lease_until=NULL WHERE (status='running' OR delivery_state='uncertain') AND owner_telegram_id=? AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=scheduled_jobs.operation_id AND status='succeeded')`,
    ).bind(env.OWNER_TELEGRAM_ID),
    // A crash between the job gate and operation gate has proof no send began.
    env.DB.prepare(
      "UPDATE scheduled_jobs SET status=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,delivery_state=CASE WHEN attempts<5 THEN 'waiting' ELSE 'rejected' END,lease_token=NULL,lease_until=NULL,last_error_code='PREPARATION_EXPIRED' WHERE status='running' AND owner_telegram_id=? AND lease_until<? AND delivery_state='sending' AND EXISTS(SELECT 1 FROM publishing_operations WHERE id=scheduled_jobs.operation_id AND status='failed' AND last_error_code='PREPARATION_EXPIRED')",
    ).bind(env.OWNER_TELEGRAM_ID, now),
    env.DB.prepare(
      "UPDATE scheduled_jobs SET status='failed',delivery_state='uncertain',last_error_code='DELIVERY_UNCERTAIN',publication_id=(SELECT publication_id FROM publishing_operations WHERE id=scheduled_jobs.operation_id),lease_token=NULL WHERE status='running' AND owner_telegram_id=? AND lease_until<? AND delivery_state='sending'",
    ).bind(env.OWNER_TELEGRAM_ID, now),
    env.DB.prepare(
      "UPDATE scheduled_jobs SET status=CASE WHEN attempts<5 THEN 'pending' ELSE 'failed' END,delivery_state=CASE WHEN attempts<5 THEN 'waiting' ELSE 'rejected' END,last_error_code='PREPARATION_EXPIRED',lease_token=NULL,lease_until=NULL WHERE status='running' AND owner_telegram_id=? AND lease_until<? AND delivery_state='preparing'",
    ).bind(env.OWNER_TELEGRAM_ID, now),
  ]);
  const jobs = await env.DB.prepare(
    "SELECT * FROM scheduled_jobs WHERE status='pending' AND delivery_state='waiting' AND owner_telegram_id=? AND run_at<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY run_at,id LIMIT 1",
  )
    .bind(env.OWNER_TELEGRAM_ID, now, now)
    .all<JobRow>();
  let processed = 0;
  for (const candidate of jobs.results) {
    const token = crypto.randomUUID(),
      timestamp = new Date().toISOString();
    const job = await env.DB.prepare(
      "UPDATE scheduled_jobs SET status='running',delivery_state='preparing',lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending' AND delivery_state='waiting' AND owner_telegram_id=? AND run_at<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) RETURNING *",
    )
      .bind(
        token,
        new Date(Date.now() + 180_000).toISOString(),
        timestamp,
        candidate.id,
        env.OWNER_TELEGRAM_ID,
        timestamp,
        timestamp,
      )
      .first<JobRow>();
    if (!job) continue;
    processed++;
    try {
      if (
        !job.document_json ||
        !job.operation_id ||
        !job.channel_id ||
        !job.source_revision
      )
        throw new HttpError(
          422,
          "LEGACY_REVIEW_REQUIRED",
          "Reschedule this legacy job with a reviewed snapshot.",
        );
      const snapshot: DeliverySnapshot = {
        postId: job.post_id,
        title: job.title ?? "Scheduled post",
        revision: job.source_revision,
        document: storedDocument(job.document_json),
      };
      const publication = await performDelivery(
        env,
        {
          operationId: job.operation_id,
          kind: "publish",
          postId: job.post_id,
          postRevision: job.source_revision,
          channelId: job.channel_id,
        },
        { id: job.id, token, snapshot },
      );
      await env.DB.prepare(
        "UPDATE scheduled_jobs SET status='succeeded',delivery_state='delivered',publication_id=?,last_error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
      )
        .bind(publication.id, new Date().toISOString(), job.id, token)
        .run();
    } catch (error) {
      const uncertain =
        (error instanceof TelegramDeliveryError && error.uncertain) ||
        (error instanceof HttpError && error.code === "DELIVERY_UNCERTAIN");
      const retry =
        !uncertain &&
        error instanceof TelegramDeliveryError &&
        error.retryable &&
        job.attempts < 5;
      const delay =
        error instanceof TelegramDeliveryError
          ? Math.max(
              error.retryAfter,
              Math.min(3600, 60 * 2 ** (job.attempts - 1)),
            )
          : 0;
      const errorCode =
        error instanceof HttpError ? error.code : "SCHEDULER_FAILURE";
      await env.DB.prepare(
        "UPDATE scheduled_jobs SET status=?,delivery_state=?,last_error_code=?,next_attempt_at=?,publication_id=(SELECT publication_id FROM publishing_operations WHERE id=?),lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
      )
        .bind(
          retry ? "pending" : "failed",
          uncertain ? "uncertain" : retry ? "waiting" : "rejected",
          errorCode,
          retry ? new Date(Date.now() + delay * 1000).toISOString() : null,
          job.operation_id,
          new Date().toISOString(),
          job.id,
          token,
        )
        .run();
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO scheduler_state(id,last_run_at,last_error_code) VALUES('cron',?,NULL) ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_error_code=NULL",
    ).bind(new Date().toISOString()),
    env.DB.prepare("DELETE FROM cli_nonces WHERE expires_at<?").bind(
      Math.floor(Date.now() / 1000),
    ),
  ]);
  return { processed, enabled: true };
}
export async function scheduledHandler(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    runScheduler(env).catch(async () => {
      try {
        await env.DB.prepare(
          "INSERT INTO scheduler_state(id,last_run_at,last_error_code) VALUES('cron',?,'SCHEDULER_FAILURE') ON CONFLICT(id) DO UPDATE SET last_run_at=excluded.last_run_at,last_error_code=excluded.last_error_code",
        )
          .bind(new Date().toISOString())
          .run();
      } catch {
        /* No secrets, request bodies or internal errors are logged. */
      }
    }),
  );
}
