import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Send,
  Trash2,
  Pencil,
  CalendarClock,
  History,
  Copy,
  LoaderCircle,
} from "lucide-react";
import type { Channel } from "../../shared/contracts";
import type { Draft } from "../../shared/editor/model";
import type { Publication, ScheduledJob } from "../../shared/publishing";
import { localTimeToUTC } from "../../shared/publishing";
import { api, ApiError } from "../lib/api";
interface Detail {
  publication: Publication;
  history: {
    id: string;
    action: string;
    created_at: string;
    details_json: string;
  }[];
  operations: {
    id: string;
    kind: string;
    status: string;
    source_revision: number | null;
    last_error_code: string | null;
  }[];
}
export function DeliveryWorkspace({
  mode,
  channels,
  onDraft,
}: {
  mode: "published" | "scheduled";
  channels: Channel[];
  onDraft: (draft: Draft) => void;
}) {
  const [publications, setPublications] = useState<Publication[]>([]),
    [jobs, setJobs] = useState<ScheduledJob[]>([]),
    [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [nextOffset, setNextOffset] = useState<number | null>(null);
  const [channelId, setChannelId] = useState(
      channels.find((c) => c.active === 1 && c.approved_at)?.id ?? "",
    ),
    [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [reschedule, setReschedule] = useState<ScheduledJob | null>(null),
    [time, setTime] = useState(""),
    [timezone, setTimezone] = useState<"UTC" | "Asia/Yangon">("Asia/Yangon");
  const [resolution, setResolution] = useState<"delivered" | "not_delivered">(
      "delivered",
    ),
    [messageId, setMessageId] = useState("");
  const lock = useRef(false),
    operations = useRef(new Map<string, string>());
  const load = useCallback(
    async (signal?: AbortSignal, offset = 0) => {
      setLoading(true);
      setError("");
      try {
        const options = signal ? { signal } : {};
        if (mode === "published") {
          const result = await api<{
            publications: Publication[];
            nextOffset: number | null;
          }>(`/api/publications?offset=${offset}`, options);
          if (!signal?.aborted) {
            setPublications((prior) =>
              offset ? [...prior, ...result.publications] : result.publications,
            );
            setNextOffset(result.nextOffset);
          }
        } else {
          const [result, status] = await Promise.all([
            api<{ jobs: ScheduledJob[]; nextOffset: number | null }>(
              `/api/scheduled?offset=${offset}`,
              options,
            ),
            api<{ schedulerEnabled: boolean }>("/api/status", options),
          ]);
          if (!signal?.aborted) {
            setJobs((prior) =>
              offset ? [...prior, ...result.jobs] : result.jobs,
            );
            setSchedulerEnabled(status.schedulerEnabled);
            setNextOffset(result.nextOffset);
          }
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(
            e instanceof Error ? e.message : "Could not load deliveries.",
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [mode],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function open(p: Publication) {
    await action(async () => {
      setDetail(await api<Detail>(`/api/publications/${p.id}`));
      setMessageId(p.telegram_message_id ? String(p.telegram_message_id) : "");
    });
  }
  async function mutate(kind: "edit" | "delete" | "republish" | "draft") {
    if (!detail) return;
    const p = detail.publication;
    if (
      kind === "delete" &&
      !window.confirm(
        "Delete this Telegram message? The source draft and audit history will be retained.",
      )
    )
      return;
    if (
      kind === "republish" &&
      !window.confirm(
        "Send another real copy to the selected approved channel?",
      )
    )
      return;
    if (
      kind === "edit" &&
      !window.confirm(
        "Replace the Telegram message with the saved editing draft?",
      )
    )
      return;
    await action(async () => {
      let values: Record<string, unknown> = { revision: p.revision };
      if (kind === "republish") values.channelId = channelId;
      if (kind === "edit") {
        const id = p.edit_draft_id ?? p.post_id;
        if (!id) throw new Error("Create an editing draft first.");
        const source = await api<{ post: { revision: number } }>(
          `/api/posts/${id}`,
        );
        values = { ...values, postId: id, postRevision: source.post.revision };
      }
      const key = JSON.stringify({ id: p.id, kind, ...values }),
        operation = operations.current.get(key) ?? crypto.randomUUID();
      operations.current.set(key, operation);
      try {
        const result = await api<{ publication?: Publication; draft?: Draft }>(
          `/api/publications/${p.id}/${kind}`,
          {
            method: "POST",
            body: JSON.stringify({ operationId: operation, ...values }),
          },
        );
        if (result.draft) {
          onDraft(result.draft);
          return;
        }
        operations.current.delete(key);
        setNotice(
          `Telegram confirmed ${kind}. ${kind === "delete" ? "Draft and history retained." : ""}`,
        );
        setDetail(await api<Detail>(`/api/publications/${p.id}`));
        await load();
      } catch (e) {
        if (
          e instanceof ApiError &&
          ![0, 429].includes(e.status) &&
          !["DELIVERY_UNCERTAIN", "OPERATION_IN_PROGRESS"].includes(e.code)
        )
          operations.current.delete(key);
        throw e;
      }
    });
  }
  async function reconcile() {
    if (
      !detail ||
      !window.confirm(
        "Confirm that you inspected Telegram and verified this outcome. This does not contact Telegram or send another message.",
      )
    )
      return;
    await action(async () => {
      const p = detail.publication;
      const result = await api<{ publication: Publication }>(
        `/api/publications/${p.id}/reconcile`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: p.revision,
            resolution,
            confirmed: true,
            ...(resolution === "delivered" && messageId
              ? { messageId: Number(messageId) }
              : {}),
          }),
        },
      );
      setDetail(
        await api<Detail>(`/api/publications/${result.publication.id}`),
      );
      setNotice(
        "Owner-confirmed reconciliation recorded. No message was sent.",
      );
      await load();
    });
  }
  async function cancel(job: ScheduledJob) {
    if (!window.confirm("Cancel this pending delivery?")) return;
    await action(async () => {
      await api(`/api/scheduled/${job.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          revision: job.revision,
        }),
      });
      setNotice("Schedule cancelled.");
      await load();
    });
  }
  async function moveTime() {
    if (!reschedule) return;
    await action(async () => {
      await api(`/api/scheduled/${reschedule.id}/reschedule`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          revision: reschedule.revision,
          runAt: localTimeToUTC(time, timezone),
          timezone,
        }),
      });
      setReschedule(null);
      setNotice("Rescheduled with the latest validated saved draft.");
      await load();
    });
  }
  return (
    <section className="delivery-workspace">
      <div className="section-heading">
        <h2>
          {mode === "published"
            ? "Published posts & previews"
            : "Scheduled jobs"}
        </h2>
        <button
          className="text-button"
          disabled={busy || loading}
          onClick={() => void load()}
        >
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>
      {mode === "scheduled" && (
        <p className="field-help">
          UTC queue · displayed in Asia/Yangon.{" "}
          {schedulerEnabled
            ? "Automatic delivery is enabled; cron checks each minute."
            : "Automatic delivery is disabled. Queued jobs will not send until the owner enables the scheduler."}
        </p>
      )}
      {error && (
        <p role="alert" className="error-inline">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="editor-notice">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">
          <LoaderCircle className="spin" size={18} />
          Loading delivery records…
        </p>
      ) : mode === "published" ? (
        publications.length ? (
          <div className="draft-grid">
            {publications.map((p) => (
              <article className="draft-card" key={p.id}>
                <span className="tag">
                  {p.kind === "preview" ? "PRIVATE TEST" : "CHANNEL POST"} ·{" "}
                  {p.status}
                </span>
                <h3>{p.title}</h3>
                <p>
                  Snapshot v{p.source_revision} · record v{p.revision}
                </p>
                {p.last_error_code && (
                  <p className="error-inline">{p.last_error_code}</p>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void open(p)}
                >
                  <History size={15} />
                  Manage publication
                </button>
                {p.message_url && (
                  <a
                    href={p.message_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-button"
                  >
                    Open Telegram message ↗
                  </a>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="compact-empty">
            No deliveries yet. Open a saved draft to send a private preview or
            publish to an approved channel.
          </div>
        )
      ) : jobs.length ? (
        <div className="draft-grid">
          {jobs.map((j) => (
            <article className="draft-card" key={j.id}>
              <span className="tag">
                {j.status} · {j.delivery_state}
              </span>
              <h3>{j.title ?? "Legacy schedule — review required"}</h3>
              <p>
                {new Date(j.run_at).toLocaleString("en-GB", {
                  timeZone: "Asia/Yangon",
                })}{" "}
                · Asia/Yangon
              </p>
              <small>
                Attempts: {j.attempts} · UTC {j.run_at}
              </small>
              {j.next_attempt_at && (
                <p className="field-help">
                  Next retry: {new Date(j.next_attempt_at).toLocaleString()}
                </p>
              )}
              {j.last_error_code && (
                <p className="error-inline">{j.last_error_code}</p>
              )}
              {j.delivery_state === "uncertain" ? (
                <p>
                  Inspect Published to reconcile. This job will not retry
                  automatically.
                </p>
              ) : (
                ["pending", "failed"].includes(j.status) && (
                  <div className="builder-controls">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        setReschedule(j);
                        setTime("");
                        setTimezone(
                          j.timezone === "UTC" ? "UTC" : "Asia/Yangon",
                        );
                      }}
                    >
                      <CalendarClock size={15} />
                      Reschedule
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void cancel(j)}
                    >
                      <Trash2 size={15} />
                      Cancel schedule
                    </button>
                  </div>
                )
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="compact-empty">
          No scheduled jobs. Choose a date and approved channel in a saved
          draft.
        </div>
      )}
      {nextOffset !== null && !loading && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void load(undefined, nextOffset)}
        >
          Load more records
        </button>
      )}
      {reschedule && (
        <div className="publishing-panel">
          <h3>Reschedule {reschedule.title}</h3>
          <label>
            New date and time
            <input
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label>
            Timezone
            <select
              value={timezone}
              onChange={(e) =>
                setTimezone(e.target.value as "UTC" | "Asia/Yangon")
              }
            >
              <option value="Asia/Yangon">Asia/Yangon</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
          <div className="builder-controls">
            <button
              className="button primary"
              disabled={busy || !time}
              onClick={() => void moveTime()}
            >
              Save schedule
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setReschedule(null)}
            >
              Close schedule
            </button>
          </div>
        </div>
      )}
      {detail && (
        <div className="publishing-panel publication-detail">
          <div className="section-heading">
            <h3>{detail.publication.title}</h3>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setDetail(null)}
            >
              Close details
            </button>
          </div>
          <p>
            Publication status: <strong>{detail.publication.status}</strong> ·
            message {detail.publication.telegram_message_id ?? "unconfirmed"}
          </p>
          {detail.publication.kind === "publication" &&
            detail.publication.status === "published" && (
              <div className="builder-controls">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void mutate("draft")}
                >
                  <Pencil size={15} />
                  Edit Published Post
                </button>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    !(
                      detail.publication.edit_draft_id ??
                      detail.publication.post_id
                    )
                  }
                  onClick={() => void mutate("edit")}
                >
                  <Send size={15} />
                  Apply saved draft
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void mutate("delete")}
                >
                  <Trash2 size={15} />
                  Delete Telegram message
                </button>
              </div>
            )}
          {detail.publication.edit_draft_id && (
            <p className="field-help">
              An editing draft is available. Save it in the editor, then apply
              the saved draft here. The original draft and Telegram snapshot
              remain separate.
            </p>
          )}
          {["published", "deleted", "failed"].includes(
            detail.publication.status,
          ) && (
            <div>
              <label>
                Copy destination
                <select
                  aria-label="Copy destination"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                >
                  <option value="">Select approved channel</option>
                  {channels
                    .filter((c) => c.active === 1 && c.approved_at)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="button secondary"
                disabled={busy || !channelId}
                onClick={() => void mutate("republish")}
              >
                <Copy size={15} />
                Republish copy
              </button>
            </div>
          )}
          {detail.publication.status === "uncertain" && (
            <div className="reconciliation">
              <h4>Manual reconciliation</h4>
              <p>
                Inspect Telegram first. Confirming an outcome records your
                observation; it does not verify or send a message.
              </p>
              <label>
                Observed outcome
                <select
                  value={resolution}
                  onChange={(e) =>
                    setResolution(
                      e.target.value as "delivered" | "not_delivered",
                    )
                  }
                >
                  <option value="delivered">
                    Action completed in Telegram
                  </option>
                  <option value="not_delivered">
                    Confirmed action did not complete
                  </option>
                </select>
              </label>
              <label>
                Confirmed Telegram message ID
                <input
                  inputMode="numeric"
                  value={messageId}
                  onChange={(e) => setMessageId(e.target.value)}
                />
              </label>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                Record confirmed outcome
              </button>
            </div>
          )}
          <h4>Publishing history</h4>
          {detail.history.length ? (
            detail.history.map((h) => (
              <p key={h.id}>
                <code>{h.action}</code> ·{" "}
                {new Date(h.created_at).toLocaleString()}
              </p>
            ))
          ) : (
            <p>No history records yet.</p>
          )}
          <h4>Delivery operations & saved revisions</h4>
          {detail.operations.map((o) => (
            <p className="operation-note" key={o.id}>
              <code>{o.id}</code>
              {o.kind} · {o.status} · snapshot {o.source_revision ?? "legacy"}{" "}
              {o.last_error_code}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
