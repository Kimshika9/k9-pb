import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  FileText,
  Layers3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { Channel } from "../../shared/contracts";
import type { Draft, DraftSummary, Template } from "../../shared/editor/model";
import { cloneDocument } from "../../shared/editor/operations";
import { api } from "../lib/api";
import { DraftEditor } from "./DraftEditor";
export function PostsWorkspace({
  channels,
  onDirtyChange,
}: {
  channels: Channel[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]),
    [templates, setTemplates] = useState<Template[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [tab, setTab] = useState<"drafts" | "templates">("drafts"),
    [offset, setOffset] = useState<number | null>(null),
    [rename, setRename] = useState<{ template: Template; name: string } | null>(
      null,
    );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const options = signal ? { signal } : {};
        const [a, b] = await Promise.all([
          api<{ drafts: DraftSummary[]; nextOffset: number | null }>(
            `/api/drafts?q=${encodeURIComponent(query)}`,
            options,
          ),
          api<{ templates: Template[] }>("/api/templates", options),
        ]);
        if (!signal?.aborted) {
          setDrafts(a.drafts);
          setOffset(a.nextOffset);
          setTemplates(b.templates);
        }
      } catch (e) {
        if (!signal?.aborted)
          setError(e instanceof Error ? e.message : "Could not load posts.");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [query],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  }
  async function create(template?: Template) {
    await action(async () => {
      const result = await api<{ draft: Draft }>("/api/drafts", {
        method: "POST",
        body: JSON.stringify({
          title: template?.name ?? "Untitled draft",
          document: template
            ? cloneDocument(template.document)
            : { version: 2, blocks: [] },
        }),
      });
      setSelected(result.draft);
    });
  }
  async function open(id: string) {
    await action(async () => {
      const result = await api<{ draft: Draft }>(`/api/drafts/${id}`);
      setSelected(result.draft);
    });
  }
  function close() {
    setTab("drafts");
    onDirtyChange(false);
    setSelected(null);
    void load();
  }
  async function deleteDraft(draft: DraftSummary) {
    if (
      !window.confirm(
        `Delete “${draft.title}”? This removes the saved draft permanently.`,
      )
    )
      return;
    await action(async () => {
      await api(`/api/drafts/${draft.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: draft.revision }),
      });
      await load();
    });
  }
  async function duplicateDraft(draft: DraftSummary) {
    await action(async () => {
      const result = await api<{ draft: Draft }>(
        `/api/drafts/${draft.id}/duplicate`,
        { method: "POST" },
      );
      setSelected(result.draft);
    });
  }
  async function deleteTemplate(template: Template) {
    if (
      !window.confirm(
        `Delete template “${template.name}”? Existing drafts will be preserved.`,
      )
    )
      return;
    await action(async () => {
      await api(`/api/templates/${template.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: template.revision }),
      });
      await load();
    });
  }
  async function duplicateTemplate(template: Template) {
    await action(async () => {
      await api("/api/templates", {
        method: "POST",
        body: JSON.stringify({
          name: `${template.name.slice(0, 150)} (copy)`,
          document: cloneDocument(template.document),
        }),
      });
      await load();
    });
  }
  async function loadMore() {
    await action(async () => {
      const result = await api<{
        drafts: DraftSummary[];
        nextOffset: number | null;
      }>(`/api/drafts?q=${encodeURIComponent(query)}&offset=${offset ?? 0}`);
      setDrafts((previous) => [...previous, ...result.drafts]);
      setOffset(result.nextOffset);
    });
  }
  if (selected)
    return (
      <DraftEditor
        key={selected.id}
        initial={selected}
        channels={channels}
        onClose={close}
        onCreated={(draft) => {
          onDirtyChange(false);
          setSelected(draft);
        }}
        onDirtyChange={onDirtyChange}
      />
    );
  return (
    <section className="posts-workspace">
      <div className="workspace-actions">
        <div className="segmented-tabs">
          <button
            onClick={() => setTab("drafts")}
            aria-pressed={tab === "drafts"}
          >
            <FileText size={16} /> Drafts
          </button>
          <button
            onClick={() => setTab("templates")}
            aria-pressed={tab === "templates"}
          >
            <Layers3 size={16} /> Templates
          </button>
        </div>
        <button
          className="button primary"
          onClick={() => void create()}
          disabled={busy}
        >
          <Plus size={16} /> New draft
        </button>
      </div>
      {tab === "drafts" && (
        <label className="draft-search">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search saved drafts"
            aria-label="Search drafts"
            maxLength={160}
          />
        </label>
      )}
      {error && (
        <div role="alert" className="error-inline">
          {error}
          <button className="text-button" onClick={() => void load()}>
            <RefreshCw size={14} /> Reload list
          </button>
        </div>
      )}
      {loading ? (
        <div className="workspace-loading" role="status">
          <LoaderCircle className="spin" size={23} /> Loading your {tab}…
        </div>
      ) : tab === "drafts" ? (
        <>
          {drafts.length ? (
            <div className="draft-grid">
              {drafts.map((draft) => (
                <article className="draft-card" key={draft.id}>
                  <span className="draft-card-icon">
                    <FileText size={22} />
                  </span>
                  <span className="tag">DRAFT · V{draft.revision}</span>
                  <h2>{draft.title}</h2>
                  <p>Updated {new Date(draft.updatedAt).toLocaleString()}</p>
                  <div className="draft-card-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void open(draft.id)}
                    >
                      <Pencil size={14} /> Edit draft
                    </button>
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`Duplicate draft ${draft.title}`}
                      onClick={() => void duplicateDraft(draft)}
                    >
                      <Copy size={15} />
                    </button>
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`Delete draft ${draft.title}`}
                      onClick={() => void deleteDraft(draft)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="panel empty-state">
              <FileText size={32} />
              <h3>
                {query ? "No matching drafts" : "Make room for your next idea"}
              </h3>
              <p>
                {query
                  ? "Try another search."
                  : "Create your first draft or start with a reusable template."}
              </p>
              <button
                className="button secondary"
                onClick={() => setTab("templates")}
              >
                Browse templates
              </button>
            </div>
          )}
          {offset !== null && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void loadMore()}
            >
              Load more drafts
            </button>
          )}
        </>
      ) : (
        <>
          <p className="template-intro">
            Start with a sample, or reuse a layout you’ve saved. Samples are
            read-only; duplicate one to make it yours.
          </p>
          <div className="template-grid">
            {templates.map((template) => (
              <article className="template-card" key={template.id}>
                <span className="draft-card-icon">
                  <Layers3 size={22} />
                </span>
                <span className="tag">
                  {template.builtin ? "SAMPLE TEMPLATE" : "YOUR TEMPLATE"}
                </span>
                <h2>{template.name}</h2>
                <p>
                  {template.document.blocks.length} content blocks · ready to
                  customize
                </p>
                <div className="draft-card-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void create(template)}
                  >
                    <Plus size={14} /> Use template
                  </button>
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`Duplicate template ${template.name}`}
                    onClick={() => void duplicateTemplate(template)}
                  >
                    <Copy size={15} />
                  </button>
                  {!template.builtin && (
                    <>
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Rename template ${template.name}`}
                        onClick={() =>
                          setRename({ template, name: template.name })
                        }
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Delete template ${template.name}`}
                        onClick={() => void deleteTemplate(template)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
                {rename?.template.id === template.id && (
                  <form
                    className="template-save-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action(async () => {
                        await api(`/api/templates/${template.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            name: rename.name,
                            revision: template.revision,
                          }),
                        });
                        setRename(null);
                        await load();
                      });
                    }}
                  >
                    <label>
                      New name
                      <input
                        required
                        maxLength={160}
                        value={rename.name}
                        onChange={(e) =>
                          setRename({ ...rename, name: e.target.value })
                        }
                      />
                    </label>
                    <button className="button primary" disabled={busy}>
                      Rename
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => setRename(null)}
                    >
                      Cancel
                    </button>
                  </form>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
