import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Image, Play, RefreshCw, X } from "lucide-react";
import type { MediaItem, MediaReference } from "../../shared/editor/model";
import { api } from "../lib/api";
export function MediaPicker({
  kind,
  onSelect,
  onClose,
}: {
  kind: MediaItem["kind"];
  onSelect: (item: MediaReference) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<MediaItem[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [fileId, setFileId] = useState(""),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState<number | null>(null);
  const fetchItems = useCallback(
    async (nextOffset = 0, signal?: AbortSignal) => {
      try {
        const result = await api<{
          media: MediaItem[];
          nextOffset: number | null;
        }>(
          `/api/media?kind=${kind}&offset=${nextOffset}`,
          signal ? { signal } : {},
        );
        if (!signal?.aborted) {
          setItems((previous) =>
            nextOffset ? [...previous, ...result.media] : result.media,
          );
          setOffset(result.nextOffset);
          setError("");
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : "Could not load media.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [kind],
  );
  function load(nextOffset = 0) {
    setLoading(true);
    setError("");
    return fetchItems(nextOffset);
  }
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    // Initial external API synchronization; loading state is initialized above.
    // oxlint-disable-next-line react/set-state-in-effect
    void fetchItems(0, controller.signal);
    return () => controller.abort();
  }, [fetchItems]);
  async function register(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ media: MediaItem }>("/api/media", {
        method: "POST",
        body: JSON.stringify({
          kind,
          fileId: fileId.trim(),
          name: name.trim(),
        }),
      });
      onSelect({
        fileId: result.media.telegram_file_id,
        libraryId: result.media.id,
        name: result.media.original_name,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify file ID.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="channel-dialog media-dialog"
      aria-labelledby="media-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-top">
        <h2 id="media-title">Choose {kind}</h2>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close media picker"
        >
          <X size={18} />
        </button>
      </div>
      <p className="muted">
        Send a {kind} to your bot’s private chat, then refresh. The library uses
        bot-owned file IDs; no credentials or download URLs are exposed.
      </p>
      <button
        className="text-button"
        type="button"
        onClick={() => void load()}
        disabled={loading}
      >
        <RefreshCw size={15} /> Refresh library
      </button>
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading media…</p>
      ) : items.length ? (
        <div className="media-grid">
          {items.map((item) => {
            const Icon =
              kind === "photo" ? Image : kind === "video" ? Play : FileText;
            return (
              <button
                type="button"
                className="media-item"
                key={item.id}
                onClick={() =>
                  onSelect({
                    fileId: item.telegram_file_id,
                    libraryId: item.id,
                    name: item.original_name,
                  })
                }
              >
                <Icon size={26} />
                <strong>{item.original_name}</strong>
                <small>
                  {(item.size_bytes / 1024 / 1024).toFixed(1)} MB ·{" "}
                  {item.mime_type}
                </small>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="compact-empty">
          No {kind} files yet. Send one to your bot or register an existing ID
          below.
        </div>
      )}
      {offset !== null && !loading && (
        <button
          className="button secondary"
          type="button"
          onClick={() => void load(offset ?? 0)}
        >
          Load more media
        </button>
      )}
      <details className="manual-media">
        <summary>Use an existing Telegram file ID</summary>
        <form onSubmit={register}>
          <label>
            File ID
            <input
              required
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
              maxLength={1024}
              placeholder="Telegram file ID from this bot"
            />
          </label>
          <label>
            Display name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
            />
          </label>
          <small className="field-help">
            Telegram verifies the file ID. Select the correct media type. Studio
            limit: photos 10 MB; videos/documents 20 MB. Large video uploads are
            unverified.
          </small>
          <button
            className="button primary"
            disabled={busy || !fileId.trim() || !name.trim()}
          >
            {busy ? "Verifying…" : "Verify & attach"}
          </button>
        </form>
      </details>
    </dialog>
  );
}
