import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  Plus,
  Trash2,
  Image,
  Play,
  FileText,
} from "lucide-react";
import type { Block, BlockType, HeadingSize } from "../../shared/editor/model";
import { textContent } from "../../shared/editor/model";
import {
  blockLabels,
  createBlock,
  duplicateBlock,
  reorderBlocks,
} from "../../shared/editor/operations";
import { EDITOR_LIMITS } from "../../shared/editor/schema";
import { RichTextEditor } from "./RichTextEditor";
import { TableBuilder } from "./TableBuilder";
import { ButtonsBuilder } from "./ButtonsBuilder";
import { MediaPicker } from "./MediaPicker";
const types = Object.keys(blockLabels) as BlockType[];
function summary(b: Block): string {
  if ("text" in b)
    return typeof b.text === "string" ? b.text : textContent(b.text);
  if (b.type === "details") return textContent(b.summary);
  if (b.type === "table")
    return `${b.cells.length} rows × ${b.cells[0]?.length ?? 0} columns`;
  if (b.type === "buttons")
    return b.buttons.map((x) => textContent(x.label)).join(" · ");
  if (b.type === "list")
    return `${b.items.length} ${b.ordered ? "ordered" : "unordered"} items`;
  if ("media" in b) return b.media?.name ?? "No media selected";
  if (b.type === "blockquote") return `${b.blocks.length} nested blocks`;
  return "A little breathing room";
}
export function BlockCanvas({
  blocks,
  onChange,
  depth = 0,
  selectedId,
  onSelect,
  inlineProperties = false,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  depth?: number;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  inlineProperties?: boolean;
}) {
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selected = onSelect ? selectedId : localSelected;
  const select = (id: string) =>
    onSelect ? onSelect(id) : setLocalSelected(id);
  const update = (b: Block) =>
    onChange(blocks.map((x) => (x.id === b.id ? b : x)));
  const selectedBlock = blocks.find((b) => b.id === selected);
  return (
    <div className={`block-canvas depth-${depth}`}>
      <div
        className="add-block-toolbar"
        role="toolbar"
        aria-label={depth ? "Add nested block" : "Add block"}
      >
        {types
          .filter(
            (type) =>
              depth < EDITOR_LIMITS.depth ||
              !["details", "blockquote"].includes(type),
          )
          .map((type) => (
            <button
              key={type}
              type="button"
              disabled={blocks.length >= EDITOR_LIMITS.blocks}
              onClick={() => {
                const next = createBlock(type);
                onChange([...blocks, next]);
                select(next.id);
              }}
            >
              <Plus size={13} />
              {blockLabels[type]}
            </button>
          ))}
      </div>
      {!blocks.length && (
        <div className="editor-empty">
          <Plus size={25} />
          <h3>Your next post starts here</h3>
          <p>Add a heading, a table, a photo — make it yours.</p>
        </div>
      )}
      <div className="block-stack">
        {blocks.map((block, i) => (
          <section
            className={`editor-block ${block.id === selected ? "selected" : ""}`}
            key={block.id}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("application/x-k9-block"))
                e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              onChange(
                reorderBlocks(
                  blocks,
                  e.dataTransfer.getData("application/x-k9-block"),
                  block.id,
                ),
              );
            }}
          >
            <div className="block-card-heading">
              <span
                className="drag-handle"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-k9-block", block.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                title="Drag to reorder on desktop"
              >
                <GripVertical size={16} />
              </span>
              <button
                className="block-select"
                type="button"
                onClick={() => select(block.id)}
                aria-label={`Edit ${blockLabels[block.type]} block ${i + 1}`}
              >
                <span className="block-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <strong>{blockLabels[block.type]}</strong>
              </button>
              <div className="block-actions">
                <button
                  type="button"
                  aria-label={`Move block ${i + 1} up`}
                  title="Move up"
                  disabled={i === 0}
                  onClick={() =>
                    onChange(reorderBlocks(blocks, block.id, blocks[i - 1]!.id))
                  }
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Move block ${i + 1} down`}
                  title="Move down"
                  disabled={i === blocks.length - 1}
                  onClick={() =>
                    onChange(reorderBlocks(blocks, block.id, blocks[i + 1]!.id))
                  }
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Duplicate block ${i + 1}`}
                  title="Duplicate"
                  onClick={() => {
                    const copy = duplicateBlock(block);
                    const next = [...blocks];
                    next.splice(i + 1, 0, copy);
                    onChange(next);
                    select(copy.id);
                  }}
                >
                  <Copy size={15} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete block ${i + 1}`}
                  title="Delete"
                  onClick={() =>
                    onChange(blocks.filter((x) => x.id !== block.id))
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <button
              className="block-summary"
              type="button"
              onClick={() => select(block.id)}
            >
              {summary(block) || "Click to add content…"}
            </button>
            {inlineProperties && block.id === selected && (
              <div className="properties-body inline-block-properties">
                <BlockProperties
                  block={block}
                  onChange={update}
                  depth={depth}
                />
              </div>
            )}
          </section>
        ))}
      </div>
      {!onSelect && selectedBlock && (
        <div className="nested-properties">
          <BlockProperties
            block={selectedBlock}
            onChange={update}
            depth={depth}
          />
        </div>
      )}
    </div>
  );
}
export function BlockProperties({
  block,
  onChange,
  depth = 0,
}: {
  block: Block;
  onChange: (block: Block) => void;
  depth?: number;
}) {
  const [picking, setPicking] = useState(false);
  switch (block.type) {
    case "heading":
      return (
        <>
          <label>
            Heading size
            <select
              value={block.size}
              onChange={(e) =>
                onChange({
                  ...block,
                  size: Number(e.target.value) as HeadingSize,
                })
              }
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "— largest" : n === 6 ? "— smallest" : ""}
                </option>
              ))}
            </select>
          </label>
          <RichTextEditor
            label="Heading text"
            value={block.text}
            onChange={(text) => onChange({ ...block, text })}
          />
        </>
      );
    case "paragraph":
      return (
        <RichTextEditor
          label="Paragraph text"
          value={block.text}
          onChange={(text) => onChange({ ...block, text })}
        />
      );
    case "pre":
      return (
        <>
          <label>
            Language
            <input
              maxLength={64}
              placeholder="typescript, python…"
              value={block.language}
              onChange={(e) => onChange({ ...block, language: e.target.value })}
            />
          </label>
          <label>
            Code
            <textarea
              className="code-input"
              value={block.text}
              maxLength={4000}
              rows={8}
              onChange={(e) => onChange({ ...block, text: e.target.value })}
            />
          </label>
        </>
      );
    case "divider":
      return (
        <p className="field-help">
          A divider separates sections. Move it anywhere in your post.
        </p>
      );
    case "table":
      return <TableBuilder block={block} onChange={onChange} />;
    case "buttons":
      return <ButtonsBuilder block={block} onChange={onChange} />;
    case "list":
      return (
        <>
          <label className="check-field">
            <input
              type="checkbox"
              checked={block.ordered}
              onChange={(e) =>
                onChange({ ...block, ordered: e.target.checked })
              }
            />{" "}
            Ordered list
          </label>
          {block.items.map((item, i) => (
            <div className="list-item-editor" key={item.id}>
              <RichTextEditor
                label={`List item ${i + 1}`}
                value={item.text}
                onChange={(text) =>
                  onChange({
                    ...block,
                    items: block.items.map((x) =>
                      x.id === item.id ? { ...x, text } : x,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove list item ${i + 1}`}
                disabled={block.items.length <= 1}
                onClick={() =>
                  onChange({
                    ...block,
                    items: block.items.filter((x) => x.id !== item.id),
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button secondary"
            disabled={block.items.length >= 50}
            onClick={() =>
              onChange({
                ...block,
                items: [...block.items, { id: crypto.randomUUID(), text: [] }],
              })
            }
          >
            <Plus size={15} /> Add list item
          </button>
        </>
      );
    case "details":
    case "blockquote":
      return (
        <>
          {block.type === "details" ? (
            <>
              <RichTextEditor
                label="Summary title"
                value={block.summary}
                onChange={(summary) => onChange({ ...block, summary })}
              />
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={block.open}
                  onChange={(e) =>
                    onChange({ ...block, open: e.target.checked })
                  }
                />{" "}
                Initially expanded
              </label>
            </>
          ) : (
            <RichTextEditor
              label="Quote credit"
              value={block.credit}
              onChange={(credit) => onChange({ ...block, credit })}
            />
          )}
          <span className="field-label">Nested content</span>
          <BlockCanvas
            depth={depth + 1}
            blocks={block.blocks}
            onChange={(blocks) => onChange({ ...block, blocks })}
          />
        </>
      );
    case "photo":
    case "video":
    case "document": {
      const Icon =
        block.type === "photo"
          ? Image
          : block.type === "video"
            ? Play
            : FileText;
      return (
        <>
          <div className="selected-media">
            <Icon size={28} />
            <strong>{block.media?.name ?? `No ${block.type} selected`}</strong>
            {block.media && (
              <button
                type="button"
                className="text-button"
                onClick={() => onChange({ ...block, media: null })}
              >
                Remove attachment
              </button>
            )}
          </div>
          <button
            type="button"
            className="button secondary full-width"
            onClick={() => setPicking(true)}
          >
            Choose {block.type}
          </button>
          <RichTextEditor
            label="Media caption"
            value={block.caption}
            onChange={(caption) => onChange({ ...block, caption })}
          />
          {block.type !== "document" && (
            <label className="check-field">
              <input
                type="checkbox"
                checked={block.spoiler}
                onChange={(e) =>
                  onChange({ ...block, spoiler: e.target.checked })
                }
              />{" "}
              Spoiler cover
            </label>
          )}
          {picking && (
            <MediaPicker
              kind={block.type}
              onClose={() => setPicking(false)}
              onSelect={(media) => {
                onChange({ ...block, media });
                setPicking(false);
              }}
            />
          )}
        </>
      );
    }
  }
}
