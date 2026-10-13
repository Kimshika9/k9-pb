import { z } from "zod";
import type { Block, EditorDocument } from "./model";

// Conservative Studio limits; not claims about undocumented Telegram maxima.
export const EDITOR_LIMITS = {
  blocks: 100,
  depth: 3,
  rows: 20,
  columns: 8,
  text: 4000,
  bytes: 60_000,
  listItems: 50,
} as const;
export const isSafeUrl = (value: string): boolean => {
  if (
    !value ||
    value.length > 2048 ||
    [...value].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "tg:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      (url.protocol === "tg:" || Boolean(url.hostname))
    );
  } catch {
    return false;
  }
};
export const isFileId = (value: string): boolean =>
  /^[A-Za-z0-9_-]{10,1024}$/.test(value);
const id = z.string().uuid();
const text = z.string().max(EDITOR_LIMITS.text);
const mark = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum([
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "spoiler",
      "code",
    ]),
  }),
  z.strictObject({
    type: z.literal("link"),
    href: z
      .string()
      .refine(isSafeUrl, "Use an http, https or tg URL without credentials."),
  }),
]);
export const richTextSchema = z
  .array(
    z.strictObject({
      text,
      marks: z
        .array(mark)
        .max(7)
        .refine(
          (m) => new Set(m.map((x) => x.type)).size === m.length,
          "Duplicate text formatting.",
        ),
    }),
  )
  .max(500)
  .refine(
    (runs) =>
      runs.reduce((sum, r) => sum + r.text.length, 0) <= EDITOR_LIMITS.text,
    "Text exceeds the Studio limit.",
  );
const media = z.strictObject({
  fileId: z.string().refine(isFileId, "Invalid Telegram file ID."),
  libraryId: id.nullable(),
  name: z.string().max(200),
});
const base = { id };
export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      ...base,
      type: z.literal("heading"),
      size: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      text: richTextSchema,
    }),
    z.strictObject({
      ...base,
      type: z.literal("paragraph"),
      text: richTextSchema,
    }),
    z.strictObject({
      ...base,
      type: z.literal("pre"),
      text,
      language: z
        .string()
        .max(64)
        .regex(/^[\w.+-]*$/),
    }),
    z.strictObject({ ...base, type: z.literal("divider") }),
    z.strictObject({
      ...base,
      type: z.literal("blockquote"),
      blocks: z.array(blockSchema).max(100),
      credit: richTextSchema,
    }),
    z.strictObject({
      ...base,
      type: z.literal("list"),
      ordered: z.boolean(),
      items: z
        .array(z.strictObject({ id, text: richTextSchema }))
        .min(1)
        .max(EDITOR_LIMITS.listItems),
    }),
    z.strictObject({
      ...base,
      type: z.literal("table"),
      cells: z
        .array(
          z
            .array(
              z.strictObject({ text: richTextSchema, header: z.boolean() }),
            )
            .min(1)
            .max(EDITOR_LIMITS.columns),
        )
        .min(1)
        .max(EDITOR_LIMITS.rows)
        .refine(
          (rows) => rows.every((row) => row.length === rows[0]?.length),
          "Table rows must have the same number of cells.",
        ),
      caption: richTextSchema,
      bordered: z.boolean(),
      striped: z.boolean(),
      compact: z.boolean(),
    }),
    z.strictObject({
      ...base,
      type: z.literal("details"),
      summary: richTextSchema,
      blocks: z.array(blockSchema).max(100),
      open: z.boolean(),
    }),
    ...(["photo", "video", "document"] as const).map((type) =>
      z.strictObject({
        ...base,
        type: z.literal(type),
        media: media.nullable(),
        caption: richTextSchema,
        spoiler: z.boolean(),
      }),
    ),
    z.strictObject({
      ...base,
      type: z.literal("buttons"),
      align: z.enum(["left", "center", "right"]),
      buttons: z
        .array(
          z.strictObject({
            id,
            label: richTextSchema,
            style: z.enum(["primary", "success", "danger", "link"]),
            action: z.discriminatedUnion("type", [
              z.strictObject({
                type: z.literal("url"),
                value: z.string().max(2048),
              }),
              z.strictObject({
                type: z.literal("callback"),
                value: z.string().max(64),
              }),
            ]),
          }),
        )
        .min(1)
        .max(8),
    }),
  ]),
);
const documentSchema: z.ZodType<EditorDocument> = z.strictObject({
  version: z.literal(2),
  blocks: z.array(blockSchema).max(EDITOR_LIMITS.blocks),
});
export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}
export function parseDocument(value: unknown): EditorDocument {
  // Bound untrusted recursion before invoking the recursive schema (including cyclic JS input).
  const seen = new Set<object>();
  let count = 0;
  function inspect(node: unknown, depth: number) {
    if (depth > 20) throw new DocumentError("Document nesting is too deep.");
    if (node && typeof node === "object") {
      if (seen.has(node)) throw new DocumentError("Cyclic document structure.");
      seen.add(node);
      if (++count > 15_000) throw new DocumentError("Document is too complex.");
      for (const child of Object.values(node)) inspect(child, depth + 1);
      seen.delete(node);
    }
  }
  inspect(value, 0);
  const result = documentSchema.safeParse(value);
  if (!result.success) {
    const e = result.error.issues[0];
    throw new DocumentError(
      `${e?.path.join(".") || "document"}: ${e?.message || "Invalid document"}`,
    );
  }
  const ids = new Set<string>();
  let blocks = 0;
  function unique(key: string) {
    if (ids.has(key))
      throw new DocumentError("IDs must be unique within the document.");
    ids.add(key);
  }
  function walk(items: Block[], depth: number) {
    if (depth > EDITOR_LIMITS.depth)
      throw new DocumentError(
        `Use at most ${EDITOR_LIMITS.depth} nested block levels.`,
      );
    for (const b of items) {
      unique(b.id);
      if (++blocks > EDITOR_LIMITS.blocks)
        throw new DocumentError("Too many blocks.");
      if (b.type === "details" || b.type === "blockquote")
        walk(b.blocks, depth + 1);
      if (b.type === "buttons") b.buttons.forEach((x) => unique(x.id));
      if (b.type === "list") b.items.forEach((x) => unique(x.id));
    }
  }
  walk(result.data.blocks, 0);
  if (
    new TextEncoder().encode(JSON.stringify(result.data)).length >
    EDITOR_LIMITS.bytes
  )
    throw new DocumentError("Document exceeds the 60 KB Studio limit.");
  return result.data;
}
