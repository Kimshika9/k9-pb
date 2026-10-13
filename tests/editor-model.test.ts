import { describe, expect, it } from "vitest";
import {
  createBlock,
  duplicateBlock,
  mapBlocks,
  reorderBlocks,
  fromEditorJSON,
  toEditorJSON,
} from "../shared/editor/operations";
import { plain } from "../shared/editor/model";
import type { EditorDocument } from "../shared/editor/model";
import { parseDocument } from "../shared/editor/schema";
import {
  richTextToTelegram,
  serializeRichMessage,
  validateForTelegram,
} from "../shared/editor/telegram";
const doc = (...blocks: EditorDocument["blocks"]): EditorDocument => ({
  version: 2,
  blocks,
});
describe("structured editor operations", () => {
  it("creates every typed block and preserves stable IDs during edits", () => {
    for (const type of [
      "heading",
      "paragraph",
      "pre",
      "divider",
      "blockquote",
      "list",
      "table",
      "details",
      "photo",
      "video",
      "document",
      "buttons",
    ] as const)
      expect(parseDocument(doc(createBlock(type))).blocks[0]?.type).toBe(type);
    const block = createBlock("paragraph");
    const changed = mapBlocks([block], block.id, (b) => ({
      ...b,
      type: "paragraph",
      text: plain("မြန်မာ / English"),
    }));
    expect(changed[0]?.id).toBe(block.id);
  });
  it("reorders, deletes and duplicates nested blocks with fresh IDs", () => {
    const a = createBlock("details"),
      b = createBlock("divider");
    const copy = duplicateBlock(a);
    expect(copy.id).not.toBe(a.id);
    expect(parseDocument(doc(a, copy))).toBeTruthy();
    expect(reorderBlocks([a, b], a.id, b.id).map((x) => x.id)).toEqual([
      b.id,
      a.id,
    ]);
    expect(mapBlocks([a, b], a.id, () => null)).toEqual([b]);
  });
  it("round-trips structured formatted Myanmar text, line breaks and links", () => {
    const text = [
      {
        text: "မင်္ဂလာပါ\nHello <script>",
        marks: [
          { type: "bold" as const },
          { type: "link" as const, href: "https://example.com" },
        ],
      },
    ];
    expect(
      fromEditorJSON(toEditorJSON(text))
        .map((x) => x.text)
        .join(""),
    ).toBe("မင်္ဂလာပါ\nHello <script>");
    expect(richTextToTelegram(text)).toEqual([
      {
        type: "bold",
        text: {
          type: "url",
          url: "https://example.com",
          text: "မင်္ဂလာပါ\nHello <script>",
        },
      },
    ]);
  });
  it("rejects unsupported fields, duplicate IDs, cycles and excessive nesting", () => {
    const p = createBlock("paragraph");
    expect(() => parseDocument({ ...doc(p), html: "unsafe" })).toThrow();
    expect(() => parseDocument(doc(p, p))).toThrow("unique");
    const cyc: unknown[] = [];
    cyc.push(cyc);
    expect(() => parseDocument(cyc)).toThrow("Cyclic");
    let nested = createBlock("paragraph");
    for (let i = 0; i < 5; i++)
      nested = {
        id: crypto.randomUUID(),
        type: "details",
        summary: plain("Nested"),
        open: false,
        blocks: [nested],
      };
    expect(() => parseDocument(doc(nested))).toThrow();
  });
});
describe("official Telegram rich block serializer", () => {
  it("serializes tables and details with only official fields", () => {
    const table = createBlock("table");
    const details = createBlock("details");
    if (details.type !== "details") throw Error();
    details.blocks = [table];
    const json = serializeRichMessage(doc(details));
    expect(json.blocks[0]).toMatchObject({
      type: "details",
      summary: ["More information"],
      is_open: false,
      blocks: [
        {
          type: "table",
          cells: [
            [
              { text: ["Label"], is_header: true },
              { text: ["Value"], is_header: true },
            ],
            [
              { text: [], is_header: false },
              { text: [], is_header: false },
            ],
          ],
          is_bordered: true,
          is_striped: false,
          is_compact: false,
        },
      ],
    });
    expect(JSON.stringify(json)).not.toContain('"id"');
    expect(JSON.stringify(json)).not.toContain('"version"');
  });
  it("supports headings 1-6, preformatted text, quotations and ordered lists", () => {
    const heading = createBlock("heading");
    if (heading.type !== "heading") throw Error();
    heading.size = 6;
    heading.text = plain("Heading");
    const pre = createBlock("pre");
    if (pre.type !== "pre") throw Error();
    pre.text = 'const hello = "မြန်မာ"';
    pre.language = "typescript";
    const quote = createBlock("blockquote");
    if (quote.type !== "blockquote") throw Error();
    quote.blocks = [heading];
    quote.credit = plain("K9");
    const list = createBlock("list");
    if (list.type !== "list") throw Error();
    list.ordered = true;
    list.items[0]!.text = plain("First");
    expect(serializeRichMessage(doc(quote, pre, list)).blocks[2]).toMatchObject(
      {
        type: "list",
        items: [
          {
            type: "1",
            value: 1,
            blocks: [{ type: "paragraph", text: ["First"] }],
          },
        ],
      },
    );
  });
  it("validates actions, UTF-8 callback bytes and link style restrictions", () => {
    const b = createBlock("buttons");
    if (b.type !== "buttons") throw Error();
    const button = b.buttons[0]!;
    button.action = { type: "url", value: "javascript:alert(1)" };
    expect(validateForTelegram(doc(b))).not.toHaveLength(0);
    button.action = { type: "url", value: "https://example.com" };
    button.style = "link";
    expect(validateForTelegram(doc(b))[0]?.message).toContain("callback");
    button.action = { type: "callback", value: "မြန်မာ".repeat(10) };
    expect(validateForTelegram(doc(b))[0]?.message).toContain("UTF-8");
    button.action = { type: "callback", value: "open_course" };
    expect(serializeRichMessage(doc(b)).blocks[0]).toMatchObject({
      buttons: [{ style: "link", callback_data: "open_course" }],
    });
    expect(() =>
      parseDocument(
        doc({
          ...b,
          buttons: Array.from({ length: 9 }, () => ({
            ...button,
            id: crypto.randomUUID(),
          })),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseDocument({
        version: 2,
        blocks: [
          {
            ...b,
            buttons: [
              {
                ...button,
                action: {
                  type: "url",
                  value: "https://example.com",
                  callback_data: "wrong",
                },
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("maps verified file IDs to nested InputMedia and caption objects", () => {
    const photo = createBlock("photo");
    if (photo.type !== "photo") throw Error();
    photo.media = {
      fileId: "AgAC_telegram_file_123",
      libraryId: null,
      name: "Cover",
    };
    photo.caption = plain("Caption");
    expect(serializeRichMessage(doc(photo))).toEqual({
      blocks: [
        {
          type: "photo",
          photo: {
            type: "photo",
            media: "AgAC_telegram_file_123",
            has_spoiler: false,
          },
          caption: { text: ["Caption"] },
        },
      ],
    });
    expect(() =>
      parseDocument(
        doc({
          ...photo,
          media: {
            fileId: "https://token.example",
            libraryId: null,
            name: "Cover",
          },
        }),
      ),
    ).toThrow("file ID");
  });
  it("saves incomplete structural drafts but prevents invalid export", () => {
    const b = createBlock("photo");
    expect(parseDocument(doc(b))).toBeTruthy();
    expect(() => serializeRichMessage(doc(b))).toThrow("Select media");
  });
});

describe("field limits and rich text formats", () => {
  it("serializes all requested text formats without inserting HTML", () => {
    for (const type of [
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "spoiler",
      "code",
    ] as const)
      expect(
        richTextToTelegram([
          { text: "မြန်မာ <b>literal</b>", marks: [{ type }] },
        ]),
      ).toEqual([{ type, text: "မြန်မာ <b>literal</b>" }]);
  });
  it("rejects invalid heading sizes, ragged tables, unsafe links and unsupported marks", () => {
    const heading = createBlock("heading");
    expect(() =>
      parseDocument({ version: 2, blocks: [{ ...heading, size: 7 }] }),
    ).toThrow();
    const table = createBlock("table");
    if (table.type !== "table") throw Error();
    expect(() =>
      parseDocument(
        doc({ ...table, cells: [table.cells[0]!, [table.cells[0]![0]!]] }),
      ),
    ).toThrow("same number");
    const p = createBlock("paragraph");
    expect(() =>
      parseDocument({
        version: 2,
        blocks: [
          {
            ...p,
            text: [
              {
                text: "Unsafe",
                marks: [{ type: "link", href: "data:text/html,evil" }],
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseDocument({
        version: 2,
        blocks: [
          {
            ...p,
            text: [{ text: "Unsafe", marks: [{ type: "html", value: "bad" }] }],
          },
        ],
      }),
    ).toThrow();
  });
  it("uses UTF-8 bytes at the exact callback limit", () => {
    const b = createBlock("buttons");
    if (b.type !== "buttons") throw Error();
    b.buttons[0]!.action = { type: "callback", value: "က".repeat(21) + "a" };
    expect(validateForTelegram(doc(b))).toHaveLength(0);
    b.buttons[0]!.action.value += "b";
    expect(validateForTelegram(doc(b))[0]?.message).toContain("64");
  });
});
