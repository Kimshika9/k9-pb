import type {
  Block,
  ButtonStyle,
  EditorDocument,
  RichText,
  HeadingSize,
} from "./model";
import { textContent } from "./model";
import { isSafeUrl, parseDocument } from "./schema";
export type TelegramRichText =
  | string
  | TelegramRichText[]
  | {
      type:
        "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code";
      text: TelegramRichText;
    }
  | { type: "url"; text: TelegramRichText; url: string };
export type RichMessageButton = {
  text: TelegramRichText;
  style: ButtonStyle;
} & (
  | { url: string; callback_data?: never }
  | { callback_data: string; url?: never }
);
export interface InputRichBlockTable {
  type: "table";
  cells: { text: TelegramRichText; is_header: boolean }[][];
  caption: TelegramRichText;
  is_bordered: boolean;
  is_striped: boolean;
  is_compact: boolean;
}
export interface InputRichBlockDetails {
  type: "details";
  summary: TelegramRichText;
  blocks: InputRichBlock[];
  is_open: boolean;
}
export interface InputRichBlockButtons {
  type: "buttons";
  buttons: RichMessageButton[];
  align: "left" | "center" | "right";
}
export type InputRichBlock =
  | { type: "heading"; size: HeadingSize; text: TelegramRichText }
  | { type: "paragraph"; text: TelegramRichText }
  | { type: "pre"; text: TelegramRichText; language: string }
  | { type: "divider" }
  | { type: "blockquote"; blocks: InputRichBlock[]; credit: TelegramRichText }
  | {
      type: "list";
      items: { blocks: InputRichBlock[]; value: number; type: "1" | "" }[];
    }
  | InputRichBlockTable
  | InputRichBlockDetails
  | InputRichBlockButtons
  | {
      type: "photo";
      photo: { type: "photo"; media: string; has_spoiler: boolean };
      caption: { text: TelegramRichText };
    }
  | {
      type: "video";
      video: { type: "video"; media: string; has_spoiler: boolean };
      caption: { text: TelegramRichText };
    }
  | {
      type: "document";
      document: { type: "document"; media: string };
      caption: { text: TelegramRichText };
    };
export interface InputRichMessage {
  blocks: InputRichBlock[];
}
export interface ValidationIssue {
  blockId: string | null;
  message: string;
}
export function richTextToTelegram(text: RichText): TelegramRichText {
  return text.map((run) => {
    let value: TelegramRichText = run.text;
    for (const mark of [...run.marks].reverse())
      value =
        mark.type === "link"
          ? { type: "url", url: mark.href, text: value }
          : { type: mark.type, text: value };
    return value;
  });
}
export function validateForTelegram(
  document: EditorDocument,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try {
    parseDocument(document);
  } catch (e) {
    return [
      {
        blockId: null,
        message: e instanceof Error ? e.message : "Invalid document",
      },
    ];
  }
  if (!document.blocks.length)
    issues.push({ blockId: null, message: "Add at least one block." });
  function walk(blocks: Block[]) {
    for (const b of blocks) {
      const error = (message: string) =>
        issues.push({ blockId: b.id, message });
      if (
        (b.type === "heading" || b.type === "paragraph") &&
        !textContent(b.text).trim()
      )
        error("Add text to this block.");
      if (b.type === "pre" && !b.text.trim()) error("Add code to this block.");
      if (b.type === "details" || b.type === "blockquote") {
        if (!b.blocks.length) error("Add nested content.");
        if (b.type === "details" && !textContent(b.summary).trim())
          error("Add a details summary.");
        walk(b.blocks);
      }
      if (b.type === "list" && b.items.some((x) => !textContent(x.text).trim()))
        error("Fill in every list item.");
      if (b.type === "photo" || b.type === "video" || b.type === "document") {
        if (!b.media)
          error("Select media from your library or attach a verified file ID.");
        if (b.type === "document" && b.spoiler)
          error("Documents do not support media spoilers.");
      }
      if (b.type === "buttons")
        for (const button of b.buttons) {
          if (!textContent(button.label).trim())
            error("Every button needs a label.");
          if (button.action.type === "url" && !isSafeUrl(button.action.value))
            error(
              "Button URLs must use http, https or tg without credentials.",
            );
          if (button.action.type === "callback") {
            const bytes = new TextEncoder().encode(button.action.value).length;
            if (bytes < 1 || bytes > 64)
              error("Callback data must be 1–64 UTF-8 bytes.");
          }
          if (button.style === "link" && button.action.type !== "callback")
            error(
              "The link button style is only allowed for callback actions.",
            );
        }
    }
  }
  walk(document.blocks);
  return issues;
}
export function serializeRichMessage(
  document: EditorDocument,
): InputRichMessage {
  const issues = validateForTelegram(document);
  if (issues.length) throw new Error(issues.map((x) => x.message).join("\n"));
  const rich = richTextToTelegram;
  function serialize(b: Block): InputRichBlock {
    switch (b.type) {
      case "heading":
        return { type: b.type, size: b.size, text: rich(b.text) };
      case "paragraph":
        return { type: b.type, text: rich(b.text) };
      case "pre":
        return { type: b.type, text: b.text, language: b.language };
      case "divider":
        return { type: b.type };
      case "blockquote":
        return {
          type: b.type,
          blocks: b.blocks.map(serialize),
          credit: rich(b.credit),
        };
      case "list":
        return {
          type: b.type,
          items: b.items.map((item, i) => ({
            blocks: [{ type: "paragraph", text: rich(item.text) }],
            value: b.ordered ? i + 1 : 0,
            type: b.ordered ? "1" : "",
          })),
        };
      case "table":
        return {
          type: b.type,
          cells: b.cells.map((row) =>
            row.map((cell) => ({
              text: rich(cell.text),
              is_header: cell.header,
            })),
          ),
          caption: rich(b.caption),
          is_bordered: b.bordered,
          is_striped: b.striped,
          is_compact: b.compact,
        };
      case "details":
        return {
          type: b.type,
          summary: rich(b.summary),
          blocks: b.blocks.map(serialize),
          is_open: b.open,
        };
      case "buttons":
        return {
          type: b.type,
          align: b.align,
          buttons: b.buttons.map((button) => ({
            text: rich(button.label),
            style: button.style,
            ...(button.action.type === "url"
              ? { url: button.action.value }
              : { callback_data: button.action.value }),
          })),
        };
      case "photo":
        return {
          type: b.type,
          photo: {
            type: b.type,
            media: b.media!.fileId,
            has_spoiler: b.spoiler,
          },
          caption: { text: rich(b.caption) },
        };
      case "video":
        return {
          type: b.type,
          video: {
            type: b.type,
            media: b.media!.fileId,
            has_spoiler: b.spoiler,
          },
          caption: { text: rich(b.caption) },
        };
      case "document":
        return {
          type: b.type,
          document: { type: b.type, media: b.media!.fileId },
          caption: { text: rich(b.caption) },
        };
    }
  }
  return { blocks: document.blocks.map(serialize) };
}
// Future real Telegram preview adapter. No network calls or publication in Phase 2.
export const telegramPreviewAdapter = {
  prepare(document: EditorDocument) {
    return {
      method: "sendRichMessage" as const,
      payload: { rich_message: serializeRichMessage(document) },
    };
  },
};
