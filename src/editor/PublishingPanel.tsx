import { useRef, useState } from "react";
import { Send, FlaskConical, CalendarClock, LoaderCircle } from "lucide-react";
import type { Channel } from "../../shared/contracts";
import type { Publication, ScheduledJob } from "../../shared/publishing";
import { localTimeToUTC } from "../../shared/publishing";
import { api, ApiError } from "../lib/api";
export function PublishingPanel({
  postId,
  revision,
  valid,
  channels,
  initialChannelId,
}: {
  postId: string;
  revision: number;
  valid: boolean;
  channels: Channel[];
  initialChannelId: string | null;
}) {
  const approved = channels.filter((c) => c.active === 1 && c.approved_at);
  const [channelId, setChannelId] = useState(
    initialChannelId ?? approved[0]?.id ?? "",
  );
  const [timezone, setTimezone] = useState<"UTC" | "Asia/Yangon">(
      "Asia/Yangon",
    ),
    [time, setTime] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [operationId, setOperationId] = useState("");
  const lock = useRef(false),
    operations = useRef(new Map<string, string>()),
    activeKey = useRef("");
  async function run(kind: "preview" | "publish" | "schedule") {
    if (lock.current || !valid) return;
    const channel = approved.find((c) => c.id === channelId);
    if (kind !== "preview" && !channel) return;
    if (
      kind === "publish" &&
      !window.confirm(
        `Publish this saved draft to “${channel!.title}”? Telegram will receive a real channel post.`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const values = {
        revision,
        ...(kind !== "preview" ? { channelId } : {}),
        ...(kind === "schedule"
          ? { runAt: localTimeToUTC(time, timezone), timezone }
          : {}),
      };
      const key = JSON.stringify({ postId, kind, ...values });
      activeKey.current = key;
      const id = operations.current.get(key) ?? crypto.randomUUID();
      operations.current.set(key, id);
      setOperationId(id);
      const result = await api<{
        publication?: Publication;
        job?: ScheduledJob;
      }>(`/api/posts/${postId}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ operationId: id, ...values }),
      });
      if (result.publication)
        setNotice(
          `${kind === "preview" ? "Private test preview" : "Channel delivery"} confirmed · message ${result.publication.telegram_message_id} · ${result.publication.status}.`,
        );
      else
        setNotice(
          "Schedule saved in UTC. Check Scheduled for queue status and whether automatic delivery is enabled.",
        );
    } catch (e) {
      if (
        e instanceof ApiError &&
        ![0, 429].includes(e.status) &&
        !["DELIVERY_UNCERTAIN", "OPERATION_IN_PROGRESS"].includes(e.code)
      )
        operations.current.delete(activeKey.current);
      setError(
        e instanceof Error ? e.message : "Could not complete the operation.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function checkOperation() {
    setError("");
    try {
      const result = await api<{
        operation: { status: string; last_error_code: string | null };
      }>(`/api/operations/${operationId}`);
      setNotice(
        `Operation: ${result.operation.status}${result.operation.last_error_code ? " · " + result.operation.last_error_code : ""}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status unavailable.");
    }
  }
  return (
    <section className="publishing-panel" aria-label="Telegram delivery">
      <div className="section-heading">
        <h3>Telegram delivery</h3>
        <span className="tag">OWNER ONLY</span>
      </div>
      <p className="field-help">
        Send the saved revision. Browser preview remains available; private
        tests go only to your bot chat.
      </p>
      {!valid && (
        <p role="status" className="field-help">
          Save changes and resolve message validation before sending.
        </p>
      )}
      <label>
        Publishing channel
        <select
          aria-label="Publishing channel"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          disabled={busy}
        >
          <option value="">Choose approved channel</option>
          {approved.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <div className="builder-controls">
        <button
          className="button secondary"
          disabled={busy || !valid}
          onClick={() => void run("preview")}
        >
          <FlaskConical size={16} />
          Send Test Preview
        </button>
        <button
          className="button primary"
          disabled={busy || !valid || !approved.some((c) => c.id === channelId)}
          onClick={() => void run("publish")}
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Send size={16} />
          )}
          Publish Now
        </button>
      </div>
      <div className="field-grid">
        <label>
          Schedule date and time
          <input
            aria-label="Schedule date and time"
            type="datetime-local"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
          />
        </label>
        <label>
          Timezone
          <select
            aria-label="Schedule timezone"
            value={timezone}
            onChange={(e) =>
              setTimezone(e.target.value as "UTC" | "Asia/Yangon")
            }
            disabled={busy}
          >
            <option value="Asia/Yangon">Asia/Yangon · UTC+06:30</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
      </div>
      <button
        className="button secondary"
        disabled={
          busy || !valid || !time || !approved.some((c) => c.id === channelId)
        }
        onClick={() => void run("schedule")}
      >
        <CalendarClock size={16} />
        Schedule Post
      </button>
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
      {operationId && (
        <div className="operation-note">
          <code>{operationId}</code>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void checkOperation()}
          >
            Check operation
          </button>
        </div>
      )}
    </section>
  );
}
