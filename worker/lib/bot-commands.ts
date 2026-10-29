import type { Env } from "../env";
import { listChannels } from "./channels";
export async function commandText(command: string, env: Env): Promise<string> {
  if (command === "help")
    return "K9 :: command reference\n\n/studio → open your private Mini App\n/status → service and delivery state\n/channels → approved destinations\n/posts → recent publications\n/scheduled → upcoming jobs\n\nDesign, preview and approve every delivery in your studio. No channel send runs from these commands.";
  if (command === "channels") {
    const channels = (await listChannels(env)).filter(
      (x) => x.active === 1 && x.approved_at,
    );
    return (
      "K9 :: approved.channels\n\n" +
      (channels
        .slice(0, 10)
        .map((x, i) => `${i + 1}. ${x.title}`)
        .join("\n") || "No approved destinations. Connect a channel in Studio.")
    );
  }
  if (command === "posts") {
    const rows = await env.DB.prepare(
      "SELECT title,status FROM publications WHERE owner_telegram_id=? AND kind='publication' ORDER BY created_at DESC LIMIT 10",
    )
      .bind(env.OWNER_TELEGRAM_ID)
      .all<{ title: string; status: string }>();
    return (
      "K9 :: publication.log\n\n" +
      (rows.results.map((x) => `[${x.status}] ${x.title}`).join("\n") ||
        "No publications yet.")
    );
  }
  if (command === "scheduled") {
    const rows = await env.DB.prepare(
      "SELECT title,run_at,delivery_state FROM scheduled_jobs WHERE owner_telegram_id=? AND status IN ('pending','running','failed') ORDER BY run_at LIMIT 10",
    )
      .bind(env.OWNER_TELEGRAM_ID)
      .all<{ title: string; run_at: string; delivery_state: string }>();
    return (
      "K9 :: job.queue (UTC)\n\n" +
      (rows.results
        .map((x) => `${x.run_at} [${x.delivery_state}] ${x.title}`)
        .join("\n") || "Queue is empty.")
    );
  }
  const counts = await env.DB.prepare(
    "SELECT status,count(*) AS n FROM publications WHERE owner_telegram_id=? GROUP BY status",
  )
    .bind(env.OWNER_TELEGRAM_ID)
    .all<{ status: string; n: number }>();
  return (
    "K9 :: system.status\n\nOwner access: restricted\nScheduler: " +
    (env.SCHEDULER_ENABLED === "true" ? "enabled" : "disabled") +
    "\n" +
    counts.results.map((x) => `${x.status}: ${x.n}`).join("\n") +
    "\n\nOpen Studio for delivery details and reconciliation."
  );
}
