import { Plus, Trash2 } from "lucide-react";
import type { Block, EditorButton } from "../../shared/editor/model";
import { plain, textContent } from "../../shared/editor/model";

export function ButtonsBuilder({
  block,
  onChange,
}: {
  block: Extract<Block, { type: "buttons" }>;
  onChange: (block: Block) => void;
}) {
  const update = (id: string, change: Partial<EditorButton>) =>
    onChange({
      ...block,
      buttons: block.buttons.map((b) =>
        b.id === id ? { ...b, ...change } : b,
      ),
    });
  return (
    <div>
      <label>
        Alignment
        <select
          value={block.align}
          onChange={(e) =>
            onChange({
              ...block,
              align: e.target.value as "left" | "center" | "right",
            })
          }
        >
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </label>
      {block.buttons.map((button, i) => (
        <div className="button-properties" key={button.id}>
          <div className="builder-heading">
            <strong>Button {i + 1}</strong>
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove button ${i + 1}`}
              disabled={block.buttons.length <= 1}
              onClick={() =>
                onChange({
                  ...block,
                  buttons: block.buttons.filter((b) => b.id !== button.id),
                })
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
          <label>
            Button {i + 1} label
            <input
              value={textContent(button.label)}
              maxLength={4000}
              onChange={(e) =>
                update(button.id, { label: plain(e.target.value) })
              }
            />
          </label>
          <small className="field-help">
            Telegram button labels use plain text; Myanmar and English are
            supported.
          </small>
          <div className="field-grid">
            <label>
              Action
              <select
                aria-label={`Button ${i + 1} action`}
                value={button.action.type}
                onChange={(e) =>
                  update(button.id, {
                    action: {
                      type: e.target.value as "url" | "callback",
                      value: "",
                    },
                    style:
                      button.style === "link" && e.target.value === "url"
                        ? "primary"
                        : button.style,
                  })
                }
              >
                <option value="url">URL</option>
                <option value="callback">Callback data</option>
              </select>
            </label>
            <label>
              Style
              <select
                aria-label={`Button ${i + 1} style`}
                value={button.style}
                onChange={(e) =>
                  update(button.id, {
                    style: e.target.value as EditorButton["style"],
                  })
                }
              >
                {(["primary", "success", "danger", "link"] as const).map(
                  (style) => (
                    <option
                      key={style}
                      value={style}
                      disabled={
                        style === "link" && button.action.type !== "callback"
                      }
                    >
                      {style}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <label>
            {button.action.type === "url" ? "Destination URL" : "Callback data"}
            <input
              value={button.action.value}
              maxLength={button.action.type === "url" ? 2048 : 64}
              onChange={(e) =>
                update(button.id, {
                  action: { ...button.action, value: e.target.value },
                })
              }
              placeholder={
                button.action.type === "url" ? "https://…" : "action_identifier"
              }
            />
          </label>
          {button.action.type === "callback" && (
            <small className="field-help">
              {new TextEncoder().encode(button.action.value).length}/64 UTF-8
              bytes. Preview only; no live callback workflow.
            </small>
          )}
        </div>
      ))}
      <button
        type="button"
        className="button secondary full-width"
        disabled={block.buttons.length >= 8}
        onClick={() =>
          onChange({
            ...block,
            buttons: [
              ...block.buttons,
              {
                id: crypto.randomUUID(),
                label: plain("New button"),
                style: "primary",
                action: { type: "url", value: "" },
              },
            ],
          })
        }
      >
        <Plus size={16} /> Add button ({block.buttons.length}/8)
      </button>
      <p className="field-help">
        Add another Button row block for multiple rows. Link style is only
        permitted for callback actions.
      </p>
    </div>
  );
}
