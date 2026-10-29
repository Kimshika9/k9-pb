import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  CalendarClock,
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  Megaphone,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Channel, Dashboard, Profile } from "../shared/contracts";
import { ApiError, api } from "./lib/api";
import { telegramInitData } from "./lib/telegram";
import { useSessionState } from "./lib/session";
const PostsWorkspace = lazy(() =>
  import("./editor/PostsWorkspace").then((module) => ({
    default: module.PostsWorkspace,
  })),
);
import { ChannelForm } from "./components/ChannelForm";
import {
  Brand,
  ChannelRow,
  EmptyPosts,
  Roadmap,
} from "./components/StudioComponents";

type Page = "overview" | "channels" | "posts" | "settings";
type State =
  | { kind: "loading" }
  | { kind: "ready"; dashboard: Dashboard; profile: Profile }
  | { kind: "error"; error: ApiError };
const navigation: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: "overview", label: "Overview", icon: LayoutDashboard },
  { page: "posts", label: "Posts", icon: FileText },
  { page: "channels", label: "Channels", icon: Megaphone },
  { page: "settings", label: "Settings", icon: Settings2 },
];
export default function App() {
  const session = useSessionState();
  const [editorDirty, setEditorDirty] = useState(false);
  function navigate(next: Page) {
    if (
      editorDirty &&
      next !== "posts" &&
      !window.confirm("Leave the editor with unsaved changes?")
    )
      return;
    setPage(next);
    if (page === "posts" && next === "overview") void load();
  }
  const [page, setPage] = useState<Page>("overview");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [revoking, setRevoking] = useState<Channel | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const revokeDialog = useRef<HTMLDialogElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setState({ kind: "loading" });
    try {
      const [profile, dashboard] = await Promise.all([
        api<Profile>("/api/profile", { signal: controller.signal }),
        api<Dashboard>("/api/dashboard", { signal: controller.signal }),
      ]);
      if (!controller.signal.aborted)
        setState({ kind: "ready", profile, dashboard });
    } catch (error) {
      if (!controller.signal.aborted)
        setState({
          kind: "error",
          error:
            error instanceof ApiError
              ? error
              : new ApiError(500, "UNKNOWN", "Could not load your workspace."),
        });
    }
  }, []);
  useEffect(() => {
    // Initial external API synchronization; subsequent refreshes come from user actions.
    // oxlint-disable-next-line react/set-state-in-effect
    void load();
    return () => requestController.current?.abort();
  }, [load]);
  useEffect(() => {
    if (revoking) revokeDialog.current?.showModal();
  }, [revoking]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function revoke() {
    if (!revoking) return;
    setBusy(true);
    setActionError("");
    try {
      await api(`/api/channels/${revoking.id}`, { method: "DELETE" });
      setRevoking(null);
      setNotice("Channel approval revoked.");
      await load();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Could not revoke approval.",
      );
    } finally {
      setBusy(false);
    }
  }
  const data = state.kind === "ready" ? state.dashboard : null;
  const user = state.kind === "ready" ? state.profile.user : null;
  const title = navigation.find((n) => n.page === page)?.label ?? "Overview";
  const locked =
    state.kind === "error" && [401, 403].includes(state.error.status);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ page: p, label, icon: Icon }) => (
            <button
              key={p}
              onClick={() => navigate(p)}
              className={`nav-link ${page === p ? "active" : ""}`}
              aria-current={page === p ? "page" : undefined}
            >
              <Icon size={19} />
              <span>{label}</span>
              {p === "channels" && data && (
                <span className="nav-count">{data.counts.channels}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-card">
            <ShieldCheck size={22} />
            <strong>Made for one. Built for more.</strong>
            <p>
              One owner. A focused workspace.
              <br />
              Complete control of your channels.
            </p>
            <span>
              <span className="green-dot" /> Owner-only access
            </span>
          </div>
          <a
            className="help-link"
            href="https://core.telegram.org/bots/webapps"
            target="_blank"
            rel="noreferrer"
          >
            <CircleHelp size={17} /> Telegram Mini Apps <ArrowRight size={14} />
          </a>
          <div className="sidebar-footer">
            K9 POST STUDIO <span>PHASE 3</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{title}</span>
          </div>
          <div className="topbar-right">
            <span className="private-badge">
              <LockKeyhole size={12} /> Private workspace
            </span>
            <span
              className="avatar"
              aria-label={
                user ? `Owner: ${user.first_name}` : "Private owner workspace"
              }
            >
              {user?.first_name.slice(0, 2).toUpperCase() ?? "K9"}
            </span>
          </div>
        </header>
        <main id="main-content">
          {session.warning && (
            <div className="session-banner" role="status">
              <LockKeyhole size={18} />
              <div>
                <strong>
                  {session.expired
                    ? "Your Telegram session has expired"
                    : "Your Telegram session expires soon"}
                </strong>
                <p>
                  {session.expired
                    ? "Keep a recovery copy or download a backup of unsaved edits, then close and reopen the Mini App from your bot’s /start button."
                    : "Save your draft now. Close and reopen the Mini App from your bot to renew access."}
                </p>
              </div>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR CREATIVE COMMAND CENTER</div>
              <h1>
                {page === "overview" ? "Studio overview" : title}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === "overview"
                  ? "A little more organized. A lot more possible."
                  : page === "channels"
                    ? "Manage the channels you trust with your content."
                    : page === "posts"
                      ? "A home for everything you create."
                      : "Your identity and workspace, secured by Telegram."}
              </p>
            </div>
            {data && (
              <button
                className="button primary"
                onClick={() => {
                  setActionError("");
                  setConnecting(true);
                }}
              >
                <Plus size={17} /> Connect channel
              </button>
            )}
          </div>
          {notice && (
            <div className="toast" role="status">
              <Check size={17} />
              {notice}
            </div>
          )}
          {state.kind === "loading" ? (
            <div className="loading-state" role="status" aria-live="polite">
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-large" />
              <span>
                <LoaderCircle size={17} className="spin" /> Loading your private
                workspace…
              </span>
            </div>
          ) : state.kind === "error" ? (
            <>
              <section className="panel access-panel">
                <div className="access-visual">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <span className="access-icon">
                    <LockKeyhole size={32} />
                  </span>
                  <span className="tiny-spark">
                    <Sparkles size={18} />
                  </span>
                </div>
                <span className="tag blue">
                  {locked ? "OWNER ACCESS" : "CONNECTION STATUS"}
                </span>
                <h2>
                  {locked
                    ? state.error.status === 403
                      ? "This studio belongs to its owner"
                      : "Your studio starts in Telegram"
                    : "We couldn’t load your studio"}
                </h2>
                <p>
                  {!telegramInitData
                    ? "Open your bot’s private chat, send /start, and tap “Open K9 Post Studio” to enter your workspace."
                    : state.error.message}
                </p>
                {state.error.code === "NOT_CONFIGURED" && (
                  <p className="access-note">
                    The server needs its owner and bot configuration. Retrying
                    cannot finish setup; the studio owner must check the
                    Worker’s runtime secrets.
                  </p>
                )}
                {telegramInitData && (
                  <button
                    className="button secondary"
                    onClick={() => void load()}
                  >
                    <RefreshCw size={16} /> Try again
                  </button>
                )}
                <div className="access-note">
                  <ShieldCheck size={15} />
                  {locked
                    ? "Secure Telegram sign-in · No public signup"
                    : "Your content stays safe while you reconnect"}
                </div>
              </section>
              <Roadmap />
            </>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <section className="welcome-panel">
                    <div>
                      <span className="tag blue">
                        <Sparkles size={12} /> YOUR STUDIO, READY
                      </span>
                      <h2>Great posts start with a great workspace.</h2>
                      <p>
                        Connect your first channel and make room for what’s
                        next.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => setPage("channels")}
                      >
                        Manage your channels <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="welcome-art" aria-hidden="true">
                      <div className="art-card back-card" />
                      <div className="art-card front-card">
                        <div className="art-avatar">
                          <Send size={17} />
                        </div>
                        <div className="art-line wide" />
                        <div className="art-line" />
                        <div className="art-line short" />
                        <div className="art-button" />
                        <span className="art-check">
                          <Check size={16} />
                        </span>
                      </div>
                      <span className="art-spark">
                        <Sparkles size={22} />
                      </span>
                    </div>
                  </section>
                  <section
                    className="stats-grid"
                    aria-label="Workspace statistics"
                  >
                    {[
                      {
                        label: "Draft posts",
                        count: state.dashboard.counts.drafts,
                        icon: FileText,
                        note: "Ideas in progress",
                        color: "blue",
                      },
                      {
                        label: "Scheduled",
                        count: state.dashboard.counts.scheduled,
                        icon: CalendarClock,
                        note: "Ready for their moment",
                        color: "purple",
                      },
                      {
                        label: "Published",
                        count: state.dashboard.counts.published,
                        icon: Send,
                        note: "Out in the world",
                        color: "green",
                      },
                      {
                        label: "Connected channels",
                        count: state.dashboard.counts.channels,
                        icon: Megaphone,
                        note: "Approved by you",
                        color: "amber",
                      },
                    ].map(({ label, count, icon: Icon, note, color }) => (
                      <div className="panel stat-card" key={label}>
                        <div className="stat-top">
                          <span>{label}</span>
                          <span className={`stat-icon ${color}`}>
                            <Icon size={18} />
                          </span>
                        </div>
                        <strong>{count}</strong>
                        <small>{note}</small>
                      </div>
                    ))}
                  </section>
                </>
              )}
              {page === "overview" && (
                <div className={page === "overview" ? "content-grid" : ""}>
                  <section className="panel posts-panel">
                    <div className="section-heading">
                      <h2>
                        Recent posts{" "}
                        <span className="small-count">
                          {state.dashboard.recentPosts.length}
                        </span>
                      </h2>
                      {page === "overview" && (
                        <button
                          className="text-button muted"
                          onClick={() => setPage("posts")}
                        >
                          View posts <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                    {state.dashboard.recentPosts.length ? (
                      <div className="post-list">
                        {state.dashboard.recentPosts.map((post) => (
                          <div className="post-row" key={post.id}>
                            <span className="channel-avatar">
                              <FileText size={19} />
                            </span>
                            <div className="row-title">
                              <strong>{post.title}</strong>
                              <small>
                                {post.channel_title ?? "No channel selected"} ·{" "}
                                {new Date(post.updated_at).toLocaleDateString()}
                              </small>
                            </div>
                            <span
                              className={`status ${post.status === "published" ? "green" : ""}`}
                            >
                              {post.status}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <EmptyPosts />
                    )}
                  </section>
                  {page === "overview" && (
                    <section className="panel channels-panel">
                      <div className="section-heading">
                        <h2>Your channels</h2>
                        <Megaphone size={17} />
                      </div>
                      {state.dashboard.channels.filter((c) => c.active === 1)
                        .length ? (
                        <div>
                          {state.dashboard.channels
                            .filter((c) => c.active === 1)
                            .slice(0, 3)
                            .map((channel) => (
                              <ChannelRow
                                key={channel.id}
                                channel={channel}
                                onRevoke={(c) => {
                                  setActionError("");
                                  setRevoking(c);
                                }}
                                busy={busy}
                              />
                            ))}
                        </div>
                      ) : (
                        <div className="channel-empty">
                          <span className="channel-outline">
                            <Megaphone size={25} />
                          </span>
                          <h3>Your audience is waiting</h3>
                          <p>
                            Connect a Telegram channel
                            <br />
                            to bring it into your studio.
                          </p>
                        </div>
                      )}
                      <button
                        className="button secondary full-width"
                        onClick={() => setPage("channels")}
                      >
                        {state.dashboard.counts.channels
                          ? "Manage channels"
                          : "Connect your first channel"}
                        <ArrowRight size={16} />
                      </button>
                    </section>
                  )}
                </div>
              )}
              {page === "posts" && (
                <Suspense
                  fallback={<p role="status">Loading post workspace…</p>}
                >
                  <PostsWorkspace
                    channels={state.dashboard.channels}
                    onDirtyChange={setEditorDirty}
                  />
                </Suspense>
              )}
              {page === "channels" && (
                <section className="panel">
                  <div className="section-heading">
                    <h2>Channel destinations</h2>
                    <span className="tag">
                      {state.dashboard.counts.channels} APPROVED
                    </span>
                  </div>
                  {state.dashboard.channels.length ? (
                    state.dashboard.channels.map((channel) => (
                      <ChannelRow
                        key={channel.id}
                        channel={channel}
                        onRevoke={(c) => {
                          setActionError("");
                          setRevoking(c);
                        }}
                        busy={busy}
                      />
                    ))
                  ) : (
                    <div className="empty-state">
                      <span className="channel-outline">
                        <Megaphone size={28} />
                      </span>
                      <h3>Give your content a home</h3>
                      <p>
                        Only channels you explicitly approve can receive your
                        posts.
                      </p>
                      <button
                        className="button primary"
                        onClick={() => setConnecting(true)}
                      >
                        <Plus size={16} /> Connect channel
                      </button>
                    </div>
                  )}
                  <div className="panel-footnote">
                    <ShieldCheck size={15} /> Telegram permissions are checked
                    when you connect a channel.
                  </div>
                </section>
              )}
              {page === "settings" && (
                <section className="panel settings-panel">
                  <div className="section-heading">
                    <h2>Owner profile</h2>
                    <span className="status green">
                      <ShieldCheck size={12} /> Verified by Telegram
                    </span>
                  </div>
                  <div className="profile-info">
                    <span className="avatar large">
                      {state.profile.user.first_name.slice(0, 2).toUpperCase()}
                    </span>
                    <div>
                      <h3>
                        {state.profile.user.first_name}{" "}
                        {state.profile.user.last_name}
                      </h3>
                      <p>
                        {state.profile.user.username
                          ? `@${state.profile.user.username}`
                          : "Studio owner"}
                      </p>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Telegram user ID</dt>
                      <dd>{state.profile.user.id}</dd>
                    </div>
                    <div>
                      <dt>Access level</dt>
                      <dd>Owner only</dd>
                    </div>
                    <div>
                      <dt>Authentication</dt>
                      <dd>Signed Telegram Mini App data</dd>
                    </div>
                  </dl>
                  <div className="panel-footnote">
                    <LockKeyhole size={15} /> Reopen the app from your bot if
                    your session expires.
                  </div>
                </section>
              )}
              <Roadmap />
            </>
          )}
          <footer className="main-footer">
            <span>
              <span className="brand-mini">K9</span> Thoughtfully built for your
              channels.
            </span>
            <span>
              <ShieldCheck size={13} /> Private by design
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map(({ page: p, label, icon: Icon }) => (
          <button
            key={p}
            onClick={() => navigate(p)}
            className={p === page ? "active" : ""}
            aria-current={p === page ? "page" : undefined}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {connecting && (
        <ChannelForm
          onClose={() => setConnecting(false)}
          onSaved={() => {
            setConnecting(false);
            setNotice("Channel approved and connected.");
            void load();
          }}
        />
      )}
      {revoking && (
        <dialog
          ref={revokeDialog}
          className="channel-dialog"
          aria-labelledby="revoke-title"
          onCancel={(e) => {
            if (busy) e.preventDefault();
            else setRevoking(null);
          }}
        >
          <h2 id="revoke-title">Revoke channel approval?</h2>
          <p className="muted">
            {revoking.title} will no longer be an approved destination. Any
            pending jobs for this channel will be cancelled.
          </p>
          {actionError && (
            <p role="alert" className="error-inline">
              {actionError}
            </p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setRevoking(null)}
            >
              Keep channel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ArrowDownToLine size={16} />
              )}{" "}
              Revoke approval
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
