import type { Block, EditorDocument, RichText, Template } from "./model";
import { plain } from "./model";
// Deterministic sample IDs are non-secret content identifiers. They are regenerated on reuse.
let index = 1;
const id = () => `00000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
const heading = (text: string): Block => ({
  id: id(),
  type: "heading",
  size: 2,
  text: plain(text),
});
const paragraph = (text: string): Block => ({
  id: id(),
  type: "paragraph",
  text: plain(text),
});
const table = (rows: string[][]): Block => ({
  id: id(),
  type: "table",
  cells: rows.map((r, i) =>
    r.map((v) => ({ text: plain(v), header: i === 0 })),
  ),
  caption: [],
  bordered: true,
  striped: true,
  compact: false,
});
const details = (summary: string, text: string): Block => ({
  id: id(),
  type: "details",
  summary: plain(summary),
  open: false,
  blocks: [paragraph(text)],
});
const buttons = (label: string, url: string): Block => ({
  id: id(),
  type: "buttons",
  align: "center",
  buttons: [
    {
      id: id(),
      label: plain(label),
      style: "primary",
      action: { type: "url", value: url },
    },
  ],
});
const bold = (text: string): RichText => [{ text, marks: [{ type: "bold" }] }];
const document = (...blocks: Block[]): EditorDocument => ({
  version: 2,
  blocks,
});
export const SAMPLE_TEMPLATES: Template[] = [
  {
    id: "sample-software",
    name: "Software Information Card",
    revision: 1,
    builtin: true,
    document: document(
      heading("Software information"),
      table([
        ["Property", "Details"],
        ["Platform", "Windows / Android"],
        ["Version", "1.0.0"],
        ["Status", "Updated"],
        ["Owner", "Your team"],
      ]),
      details(
        "Features & setup",
        "Describe features, installation steps and supported devices here.",
      ),
      buttons("Read documentation", "https://core.telegram.org/bots/api"),
    ),
  },
  {
    id: "sample-product",
    name: "Digital Product Showcase",
    revision: 1,
    builtin: true,
    document: document(
      heading("Your next favorite product"),
      paragraph("Introduce the product and the problem it solves."),
      table([
        ["Included", "Details"],
        ["Format", "Digital download"],
        ["Support", "Contact your team"],
      ]),
      details(
        "What is included?",
        "Add your product features, delivery notes and support information.",
      ),
      buttons("Explore Telegram", "https://telegram.org"),
    ),
  },
  {
    id: "sample-course",
    name: "Course Information Post",
    revision: 1,
    builtin: true,
    document: document(
      heading("Learn something new"),
      paragraph("Write a clear course introduction for your audience."),
      table([
        ["Course", "Information"],
        ["Level", "Beginner"],
        ["Duration", "4 weeks"],
        ["Language", "Myanmar / English"],
      ]),
      {
        id: id(),
        type: "list",
        ordered: true,
        items: [
          "Getting started",
          "Practical skills",
          "Your first project",
        ].map((t) => ({ id: id(), text: plain(t) })),
      },
      details(
        "How to join",
        "Add your course registration instructions and requirements.",
      ),
    ),
  },
  {
    id: "sample-tutorial",
    name: "Tutorial / Knowledge Post",
    revision: 1,
    builtin: true,
    document: document(
      heading("A practical guide"),
      {
        id: id(),
        type: "paragraph",
        text: bold("မင်္ဂလာပါ — Welcome to this tutorial."),
      },
      paragraph("Explain what the reader will learn."),
      {
        id: id(),
        type: "list",
        ordered: true,
        items: [
          "Prepare your tools",
          "Follow the steps",
          "Check your result",
        ].map((t) => ({ id: id(), text: plain(t) })),
      },
      {
        id: id(),
        type: "pre",
        language: "typescript",
        text: 'const message = "Hello, Telegram";',
      },
      details(
        "Useful notes",
        "Add troubleshooting and extra learning resources here.",
      ),
      buttons(
        "Telegram Mini Apps guide",
        "https://core.telegram.org/bots/webapps",
      ),
    ),
  },
];
