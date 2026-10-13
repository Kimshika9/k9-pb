export type Format =
  "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code";
export type TextMark = { type: Format } | { type: "link"; href: string };
export interface TextRun {
  text: string;
  marks: TextMark[];
}
export type RichText = TextRun[];
export type HeadingSize = 1 | 2 | 3 | 4 | 5 | 6;
export type ButtonStyle = "primary" | "success" | "danger" | "link";
export type ButtonAction =
  { type: "url"; value: string } | { type: "callback"; value: string };
export interface EditorButton {
  id: string;
  label: RichText;
  style: ButtonStyle;
  action: ButtonAction;
}
export interface TableCell {
  text: RichText;
  header: boolean;
}
export interface MediaReference {
  fileId: string;
  libraryId: string | null;
  name: string;
}
interface Base {
  id: string;
}
export type Block =
  | (Base & { type: "heading"; size: HeadingSize; text: RichText })
  | (Base & { type: "paragraph"; text: RichText })
  | (Base & { type: "pre"; text: string; language: string })
  | (Base & { type: "divider" })
  | (Base & { type: "blockquote"; blocks: Block[]; credit: RichText })
  | (Base & {
      type: "list";
      ordered: boolean;
      items: { id: string; text: RichText }[];
    })
  | (Base & {
      type: "table";
      cells: TableCell[][];
      caption: RichText;
      bordered: boolean;
      striped: boolean;
      compact: boolean;
    })
  | (Base & {
      type: "details";
      summary: RichText;
      blocks: Block[];
      open: boolean;
    })
  | (Base & {
      type: "photo" | "video" | "document";
      media: MediaReference | null;
      caption: RichText;
      spoiler: boolean;
    })
  | (Base & {
      type: "buttons";
      align: "left" | "center" | "right";
      buttons: EditorButton[];
    });
export type BlockType = Block["type"];
export interface EditorDocument {
  version: 2;
  blocks: Block[];
}
export interface Draft {
  id: string;
  title: string;
  document: EditorDocument;
  revision: number;
  channelId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DraftSummary {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
}
export interface Template {
  id: string;
  name: string;
  document: EditorDocument;
  revision: number;
  builtin: boolean;
}
export interface MediaItem {
  id: string;
  telegram_file_id: string;
  kind: "photo" | "video" | "document";
  original_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  created_at: string;
}
export const plain = (text = ""): RichText =>
  text ? [{ text, marks: [] }] : [];
export const textContent = (text: RichText): string =>
  text.map((run) => run.text).join("");
