import {
  CalendarClock,
  FileText,
  Layers3,
  LockKeyhole,
  Megaphone,
  Sparkles,
  Unplug,
  WandSparkles,
} from "lucide-react";
import type { Channel } from "../../shared/contracts";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Layers3 size={25} strokeWidth={2.3} />
      </span>
      <div>
        K9 <span>Post Studio</span>
        <small>YOUR TELEGRAM WORKSPACE</small>
      </div>
    </div>
  );
}
export function Roadmap() {
  return (
    <div className="panel roadmap">
      <div className="section-heading">
        <h2>Built for your next idea</h2>
        <span className="tag">STUDIO CAPABILITIES</span>
      </div>
      <div className="roadmap-grid">
        {[
          {
            icon: WandSparkles,
            title: "Rich post editor",
            text: "Available in Posts: tables, media & buttons.",
          },
          {
            icon: CalendarClock,
            title: "Smart scheduling",
            text: "Coming in Phase 3: scheduling & publishing.",
          },
          {
            icon: Layers3,
            title: "Reusable templates",
            text: "Available in Posts: save & reuse layouts.",
          },
        ].map(({ icon: Icon, title, text }) => (
          <div key={title} className="roadmap-item">
            <Icon size={20} />
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
export function ChannelRow({
  channel,
  onRevoke,
  busy,
}: {
  channel: Channel;
  onRevoke: (channel: Channel) => void;
  busy: boolean;
}) {
  const active = channel.active === 1 && channel.approved_at !== null;
  return (
    <div className="channel-row">
      <span className="channel-avatar">
        <Megaphone size={19} />
      </span>
      <div className="row-title">
        <strong>{channel.title}</strong>
        <small>
          {channel.username ? `@${channel.username}` : channel.telegram_chat_id}
        </small>
      </div>
      <span className={`status ${active ? "green" : ""}`}>
        {active ? "Approved" : "Revoked"}
      </span>
      {active && (
        <button
          className="icon-button"
          aria-label={`Revoke ${channel.title}`}
          title="Revoke channel approval"
          disabled={busy}
          onClick={() => onRevoke(channel)}
        >
          <Unplug size={17} />
        </button>
      )}
    </div>
  );
}
export function EmptyPosts() {
  return (
    <div className="empty-state">
      <div className="empty-illustration">
        <FileText size={30} />
        <span>
          <Sparkles size={14} />
        </span>
      </div>
      <h3>A fresh start for your content</h3>
      <p>
        Your drafts and published posts will appear here.
        <br />
        Open Posts to create your first rich draft.
      </p>
      <span className="quiet-label">
        <LockKeyhole size={12} /> Your workspace is private
      </span>
    </div>
  );
}
