import type { Block, BlockType, EditorDocument, RichText } from "./model";
import { plain } from "./model";
export const blockLabels: Record<BlockType, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  pre: "Code block",
  divider: "Divider",
  blockquote: "Quotation",
  list: "List",
  table: "Table",
  details: "Details",
  photo: "Photo",
  video: "Video",
  document: "Document",
  buttons: "Button row",
};
export function createBlock(type: BlockType): Block {
  const id = crypto.randomUUID();
  switch (type) {
    case "heading":
      return { id, type, size: 2, text: plain("") };
    case "paragraph":
      return { id, type, text: [] };
    case "pre":
      return { id, type, text: "", language: "" };
    case "divider":
      return { id, type };
    case "blockquote":
      return { id, type, credit: [], blocks: [createBlock("paragraph")] };
    case "list":
      return {
        id,
        type,
        ordered: false,
        items: [{ id: crypto.randomUUID(), text: plain("") }],
      };
    case "table":
      return {
        id,
        type,
        cells: [
          [
            { text: plain("Label"), header: true },
            { text: plain("Value"), header: true },
          ],
          [
            { text: [], header: false },
            { text: [], header: false },
          ],
        ],
        caption: [],
        bordered: true,
        striped: false,
        compact: false,
      };
    case "details":
      return {
        id,
        type,
        summary: plain("More information"),
        blocks: [createBlock("paragraph")],
        open: false,
      };
    case "photo":
    case "video":
    case "document":
      return { id, type, media: null, caption: [], spoiler: false };
    case "buttons":
      return {
        id,
        type,
        align: "center",
        buttons: [
          {
            id: crypto.randomUUID(),
            label: plain("Learn more"),
            style: "primary",
            action: { type: "url", value: "" },
          },
        ],
      };
  }
}
export function mapBlocks(
  blocks: Block[],
  id: string,
  change: (block: Block) => Block | null,
): Block[] {
  return blocks.flatMap((block) => {
    if (block.id === id) {
      const next = change(block);
      return next ? [next] : [];
    }
    if (block.type === "details" || block.type === "blockquote")
      return [{ ...block, blocks: mapBlocks(block.blocks, id, change) }];
    return [block];
  });
}
export function duplicateBlock(block: Block): Block {
  const copy = structuredClone(block);
  copy.id = crypto.randomUUID();
  if (copy.type === "details" || copy.type === "blockquote")
    copy.blocks = copy.blocks.map(duplicateBlock);
  if (copy.type === "buttons")
    copy.buttons = copy.buttons.map((x) => ({ ...x, id: crypto.randomUUID() }));
  if (copy.type === "list")
    copy.items = copy.items.map((x) => ({ ...x, id: crypto.randomUUID() }));
  return copy;
}
export function cloneDocument(doc: EditorDocument): EditorDocument {
  return { version: 2, blocks: doc.blocks.map(duplicateBlock) };
}
export function reorderBlocks(
  blocks: Block[],
  from: string,
  to: string,
): Block[] {
  const a = blocks.findIndex((x) => x.id === from),
    b = blocks.findIndex((x) => x.id === to);
  if (a < 0 || b < 0 || a === b) return blocks;
  const next = [...blocks];
  const [item] = next.splice(a, 1);
  next.splice(b, 0, item!);
  return next;
}
// Tiptap JSON is translated into an application-owned inline model; raw HTML is never persisted.
export interface TextEditorNode {
  type?: string;
  text?: string;
  content?: TextEditorNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}
export function fromEditorJSON(doc: TextEditorNode): RichText {
  const runs: RichText = [];
  for (const [i, p] of (doc.content ?? []).entries()) {
    if (i) runs.push({ text: "\n", marks: [] });
    for (const node of p.content ?? []) {
      if (node.type === "hardBreak") {
        runs.push({ text: "\n", marks: [] });
        continue;
      }
      if (node.type !== "text" || !node.text) continue;
      const marks: RichText[number]["marks"] = [];
      for (const m of node.marks ?? []) {
        if (m.type === "link" && typeof m.attrs?.href === "string")
          marks.push({ type: "link", href: m.attrs.href });
        else if (
          ["bold", "italic", "underline", "strike", "spoiler", "code"].includes(
            m.type,
          )
        )
          marks.push({
            type:
              m.type === "strike"
                ? "strikethrough"
                : (m.type as
                    "bold" | "italic" | "underline" | "spoiler" | "code"),
          });
      }
      runs.push({ text: node.text, marks });
    }
  }
  return runs;
}
export function toEditorJSON(text: RichText): TextEditorNode {
  const paragraphs: TextEditorNode[] = [{ type: "paragraph", content: [] }];
  for (const run of text) {
    for (const [i, part] of run.text.split("\n").entries()) {
      if (i) paragraphs.push({ type: "paragraph", content: [] });
      if (part)
        paragraphs.at(-1)!.content!.push({
          type: "text",
          text: part,
          marks: run.marks.map((m) =>
            m.type === "link"
              ? { type: "link", attrs: { href: m.href } }
              : { type: m.type === "strikethrough" ? "strike" : m.type },
          ),
        });
    }
  }
  return { type: "doc", content: paragraphs };
}
