import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Copy,
  Download,
  Eye,
  FileCode2,
  LayoutPanelLeft,
  LoaderCircle,
  Save,
  Layers3,
} from "lucide-react";
import type { Channel } from "../../shared/contracts";
import type { Block, Draft, EditorDocument } from "../../shared/editor/model";
import { blockLabels, cloneDocument } from "../../shared/editor/operations";
import { parseDocument } from "../../shared/editor/schema";
import {
  serializeRichMessage,
  validateForTelegram,
} from "../../shared/editor/telegram";
import { ApiError, api } from "../lib/api";
import { BlockCanvas, BlockProperties } from "./BlockEditor";
import { useMobileLayout } from "./useMobileLayout";
import { PostPreview } from "./Preview";
interface DraftValue {
  title: string;
  document: EditorDocument;
  channelId: string | null;
}
const valueOf = (draft: Draft): DraftValue => ({
  title: draft.title,
  document: draft.document,
  channelId: draft.channelId,
});
function downloadHref(value: unknown): string {
  return (
    "data:application/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(value, null, 2))
  );
}
export function DraftEditor({
  initial,
  channels,
  onClose,
  onCreated,
  onDirtyChange,
}: {
  initial: Draft;
  channels: Channel[];
  onClose: () => void;
  onCreated: (draft: Draft) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const mobile = useMobileLayout();
  const [value, setValue] = useState<DraftValue>(() => valueOf(initial));
  const [selectedId, setSelectedId] = useState<string | null>(
    initial.document.blocks[0]?.id ?? null,
  );
  const [tab, setTab] = useState<"edit" | "preview" | "json">("edit");
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
      JSON.stringify(valueOf(initial)),
    ),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<ApiError | null>(null),
    [notice, setNotice] = useState(""),
    [validationError, setValidationError] = useState(""),
    [templateName, setTemplateName] = useState<string | null>(null),
    [templateBusy, setTemplateBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(initial.revision);
  const base = useRef(initial),
    latest = useRef(value),
    active = useRef<Promise<void> | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const snapshot = JSON.stringify(value),
    dirty = snapshot !== savedSnapshot;
  const issues = validateForTelegram(value.document),
    selected = value.document.blocks.find((b) => b.id === selectedId);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    function unload(event: BeforeUnloadEvent) {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  const save = useCallback(async () => {
    if (active.current) return active.current;
    const input = latest.current;
    try {
      parseDocument(input.document);
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : "Invalid document.");
      return;
    }
    if (!input.title.trim() || input.title.trim().length > 160) {
      setValidationError("Give the draft a title (1–160 characters).");
      return;
    }
    setValidationError("");
    setSaving(true);
    setNotice("");
    const captured = JSON.stringify(input);
    const revision = base.current.revision;
    const operation = (async () => {
      try {
        const result = await api<{ draft: Draft }>(
          `/api/drafts/${base.current.id}`,
          { method: "PUT", body: JSON.stringify({ ...input, revision }) },
        );
        base.current = result.draft;
        if (mounted.current) {
          setSavedRevision(result.draft.revision);
          setSavedSnapshot(captured);
          setError(null);
          setNotice("Saved to your private workspace.");
        }
      } catch (e) {
        if (mounted.current)
          setError(
            e instanceof ApiError
              ? e
              : new ApiError(500, "SAVE_FAILED", "Could not save the draft."),
          );
      } finally {
        active.current = null;
        if (mounted.current) setSaving(false);
      }
    })();
    active.current = operation;
    return operation;
  }, []);
  useEffect(() => {
    if (!dirty || saving || error || validationError) return;
    const timer = window.setTimeout(() => void save(), 1200);
    return () => clearTimeout(timer);
  }, [snapshot, dirty, saving, error, validationError, save]);
  function changeDocument(document: EditorDocument) {
    try {
      parseDocument(document);
      setValidationError("");
      setValue((v) => ({ ...v, document }));
    } catch (e) {
      setValue((v) => ({ ...v, document: structuredClone(v.document) }));
      setValidationError(
        e instanceof Error ? e.message : "Invalid block change.",
      );
    }
  }
  async function reload() {
    if (
      dirty &&
      !window.confirm(
        "Reload the saved version and discard these local changes?",
      )
    )
      return;
    try {
      const result = await api<{ draft: Draft }>(
        `/api/drafts/${base.current.id}`,
      );
      base.current = result.draft;
      setSavedRevision(result.draft.revision);
      setValue(valueOf(result.draft));
      setSavedSnapshot(JSON.stringify(valueOf(result.draft)));
      setError(null);
      setValidationError("");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(500, "LOAD_FAILED", "Could not reload."),
      );
    }
  }
  async function saveAsNew() {
    try {
      await active.current;
      const result = await api<{ draft: Draft }>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({
          ...latest.current,
          title: `${latest.current.title.slice(0, 150)} (copy)`,
          document: cloneDocument(latest.current.document),
        }),
      });
      onCreated(result.draft);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(500, "SAVE_FAILED", "Could not create a copy."),
      );
    }
  }
  async function saveTemplate(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setTemplateBusy(true);
    setNotice("");
    try {
      await api("/api/templates", {
        method: "POST",
        body: JSON.stringify({ name: templateName, document: value.document }),
      });
      setTemplateName(null);
      setNotice("Reusable template saved.");
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(500, "TEMPLATE_FAILED", "Could not save template."),
      );
    } finally {
      setTemplateBusy(false);
    }
  }
  function leave() {
    if (saving) {
      setNotice("Wait for the current save to finish.");
      return;
    }
    if (
      dirty &&
      !window.confirm(
        "Leave this draft with unsaved changes? Download a backup first if needed.",
      )
    )
      return;
    onClose();
  }
  return (
    <section className="draft-editor">
      <div className="editor-topline">
        <button className="text-button" onClick={leave}>
          <ArrowLeft size={16} /> All drafts
        </button>
        <span
          className={`save-state ${error ? "failed" : dirty ? "unsaved" : "saved"}`}
          role="status"
        >
          {saving ? (
            <LoaderCircle size={14} className="spin" />
          ) : error ? (
            <CircleAlert size={14} />
          ) : dirty ? (
            <CircleAlert size={14} />
          ) : (
            <Check size={14} />
          )}{" "}
          {saving
            ? "Saving…"
            : error
              ? "Save failed"
              : dirty
                ? "Unsaved changes"
                : "All changes saved"}{" "}
          · v{savedRevision}
        </span>
      </div>
      <div className="editor-title-row">
        <label className="draft-title-label">
          POST TITLE
          <input
            className="draft-title-input"
            aria-label="Post title"
            value={value.title}
            maxLength={160}
            onChange={(e) => {
              setValue((v) => ({ ...v, title: e.target.value }));
              setValidationError("");
            }}
          />
        </label>
        <button
          className="button primary"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          <Save size={16} /> Save draft
        </button>
      </div>
      <div className="editor-actions">
        <label className="destination-select">
          Draft destination
          <select
            aria-label="Draft destination"
            value={value.channelId ?? ""}
            onChange={(e) =>
              setValue((v) => ({ ...v, channelId: e.target.value || null }))
            }
          >
            <option value="">No channel selected</option>
            {channels
              .filter((c) => c.active === 1 && c.approved_at)
              .map((c) => (
                <option value={c.id} key={c.id}>
                  {c.title}
                </option>
              ))}
            {value.channelId &&
              !channels.some(
                (c) =>
                  c.id === value.channelId && c.active === 1 && c.approved_at,
              ) && (
                <option value={value.channelId}>
                  Revoked channel — clear to save
                </option>
              )}
          </select>
        </label>
        <button
          className="button secondary"
          onClick={() => setTemplateName(value.title)}
        >
          <Layers3 size={15} /> Save as template
        </button>
        <a
          className="button secondary"
          download="k9-draft-backup.json"
          href={downloadHref(value)}
        >
          <Download size={15} /> Backup
        </a>
      </div>
      {notice && (
        <p className="editor-notice" role="status">
          {notice}
        </p>
      )}
      {validationError && (
        <p className="error-inline" role="alert">
          {validationError}
        </p>
      )}
      {error && (
        <div className="error-inline" role="alert">
          <p>{error.message}</p>
          <div className="builder-controls">
            {error.status === 409 ? (
              <>
                <button
                  className="button secondary"
                  onClick={() => void reload()}
                >
                  Reload saved version
                </button>
                <button
                  className="button secondary"
                  onClick={() => void saveAsNew()}
                >
                  <Copy size={14} /> Save as new draft
                </button>
              </>
            ) : (
              <button
                className="button secondary"
                onClick={() => {
                  setError(null);
                  void save();
                }}
              >
                Retry save
              </button>
            )}
            <a
              className="button secondary"
              download="k9-unsaved-backup.json"
              href={downloadHref(value)}
            >
              Download backup
            </a>
          </div>
          {error.status === 401 && (
            <p>
              Reopen the Mini App from your bot to refresh authentication. Back
              up local changes first.
            </p>
          )}
        </div>
      )}
      {templateName !== null && (
        <form className="template-save-form" onSubmit={saveTemplate}>
          <label>
            Template name
            <input
              value={templateName}
              maxLength={160}
              onChange={(e) => setTemplateName(e.target.value)}
              required
            />
          </label>
          <button className="button primary" disabled={templateBusy}>
            {templateBusy ? "Saving…" : "Save template"}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={templateBusy}
            onClick={() => setTemplateName(null)}
          >
            Cancel
          </button>
        </form>
      )}
      <div className="editor-tabbar" role="tablist" aria-label="Editor views">
        {[
          { key: "edit" as const, label: "Editor", icon: LayoutPanelLeft },
          { key: "preview" as const, label: "Preview", icon: Eye },
          { key: "json" as const, label: "Telegram JSON", icon: FileCode2 },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            aria-controls={`editor-${key}`}
            onClick={() => setTab(key)}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
        <span
          className={issues.length ? "validation-count" : "validation-valid"}
        >
          {issues.length
            ? `${issues.length} export issue${issues.length === 1 ? "" : "s"}`
            : "Ready for export"}
        </span>
      </div>
      {tab === "edit" && (
        <div id="editor-edit" role="tabpanel" className="editor-layout">
          <div className="canvas-panel">
            <div className="canvas-heading">
              <span>CONTENT BLOCKS</span>
              <small>
                {value.document.blocks.length} blocks · drag or use arrows
              </small>
            </div>
            <BlockCanvas
              blocks={value.document.blocks}
              inlineProperties={mobile}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onChange={(blocks) =>
                changeDocument({ ...value.document, blocks })
              }
            />
          </div>
          {!mobile && (
            <aside className="properties-panel">
              <div className="properties-heading">
                <span>BLOCK PROPERTIES</span>
                <strong>
                  {selected ? blockLabels[selected.type] : "Select a block"}
                </strong>
              </div>
              <div className="properties-body">
                {selected ? (
                  <BlockProperties
                    key={selected.id}
                    block={selected}
                    onChange={(block: Block) =>
                      changeDocument({
                        ...value.document,
                        blocks: value.document.blocks.map((b) =>
                          b.id === block.id ? block : b,
                        ),
                      })
                    }
                  />
                ) : (
                  <p className="compact-empty">
                    Choose a block on the canvas to edit its content and design.
                  </p>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
      {tab === "preview" && (
        <div id="editor-preview" role="tabpanel">
          <PostPreview document={value.document} title={value.title} />
        </div>
      )}
      {tab === "json" && (
        <div id="editor-json" role="tabpanel" className="json-panel">
          <div className="section-heading">
            <h2>InputRichMessage</h2>
            {issues.length ? (
              <button className="button secondary" disabled>
                <Download size={15} /> Export JSON
              </button>
            ) : (
              <a
                className="button secondary"
                download="k9-rich-message.json"
                href={downloadHref(serializeRichMessage(value.document))}
              >
                <Download size={15} /> Export JSON
              </a>
            )}
          </div>
          {issues.length ? (
            <p className="compact-empty">
              Resolve the validation issues below to generate a valid payload.
            </p>
          ) : (
            <pre>
              {JSON.stringify(serializeRichMessage(value.document), null, 2)}
            </pre>
          )}
        </div>
      )}
      <details className="validation-panel" open={issues.length > 0}>
        <summary>
          {issues.length
            ? "Complete these fields before exporting"
            : "Telegram payload validation passed"}
        </summary>
        {issues.length ? (
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.blockId && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setTab("edit");
                      const contains = (block: Block): boolean =>
                        block.id === issue.blockId ||
                        ((block.type === "details" ||
                          block.type === "blockquote") &&
                          block.blocks.some(contains));
                      setSelectedId(
                        value.document.blocks.find(contains)?.id ?? null,
                      );
                    }}
                  >
                    Select block
                  </button>
                )}{" "}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : (
          <p>
            Structured fields, media references and actions are valid locally.
            Hosted Telegram acceptance will be tested in Phase 3.
          </p>
        )}
      </details>
    </section>
  );
}
