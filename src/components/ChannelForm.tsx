import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api";
import type { Channel } from "../../shared/contracts";

export function ChannelForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [chatId, setChatId] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api<{ channel: Channel }>("/api/channels", {
        method: "POST",
        body: JSON.stringify({ chatId: chatId.trim(), approved }),
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect the channel.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="channel-dialog"
      aria-labelledby="connect-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-top">
        <span className="icon-box">
          <ShieldCheck size={22} />
        </span>
        <button
          className="icon-button"
          aria-label="Close channel form"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      <h2 id="connect-title">Connect a channel</h2>
      <p className="muted">Your channels. Your approval. Your control.</p>
      <form onSubmit={submit}>
        <label htmlFor="chat-id">Channel username or ID</label>
        <input
          id="chat-id"
          autoFocus
          placeholder="@your_channel or -100…"
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          required
          maxLength={40}
          disabled={busy}
        />
        <p className="field-help">
          Add your bot as an administrator with permission to post. You must
          also be a channel administrator.
        </p>
        <label className="approval">
          <input
            type="checkbox"
            checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            disabled={busy}
          />
          <span>I approve this channel as a destination for future posts.</span>
        </label>
        {error && (
          <p className="error-inline" role="alert">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={busy || !approved || !chatId.trim()}
        >
          {busy ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Check size={18} />
          )}{" "}
          {busy ? "Checking permissions…" : "Approve & connect"}
        </button>
      </form>
    </dialog>
  );
}
