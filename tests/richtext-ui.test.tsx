// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Editor } from "@tiptap/core";
import { RichTextEditor } from "../src/editor/RichTextEditor";
import type { RichText } from "../shared/editor/model";
afterEach(cleanup);
describe("real Tiptap toolbar", () => {
  it("removes the selected hyperlink after focus moves into its URL input", async () => {
    const changed = vi.fn();
    render(
      <RichTextEditor
        label="Link fixture"
        value={[
          {
            text: "Keep Myanmar မြန်မာ",
            marks: [{ type: "link", href: "https://example.com" }],
          },
          { text: " tail", marks: [] },
        ]}
        onChange={changed}
      />,
    );
    const field = await screen.findByRole("textbox", { name: "Link fixture" });
    const editor = (field as HTMLElement & { editor: Editor }).editor;
    editor.commands.setTextSelection({
      from: 1,
      to: 1 + "Keep Myanmar မြန်မာ".length,
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit hyperlink" }));
    fireEvent.focus(screen.getByRole("textbox", { name: "Hyperlink URL" }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(field.querySelector("a")).toBeNull());
    expect(changed).toHaveBeenCalledWith([
      { text: "Keep Myanmar မြန်မာ tail", marks: [] },
    ]);
  });
  it("applies exclusive inline code to formatted text and supports undo/redo", async () => {
    const text = "မြန်မာ / Formatting";
    const value: RichText = [
      {
        text,
        marks: [
          { type: "bold" },
          { type: "italic" },
          { type: "underline" },
          { type: "spoiler" },
        ],
      },
    ];
    const changed = vi.fn();
    render(
      <RichTextEditor
        label="Rich toolbar fixture"
        value={value}
        onChange={changed}
      />,
    );
    const field = await screen.findByRole("textbox", {
      name: "Rich toolbar fixture",
    });
    const editor = (field as HTMLElement & { editor: Editor }).editor;
    editor.commands.selectAll();
    editor.commands.setTextSelection(text.length + 1); // Simulate a collapsed DOM selection while the toolbar takes focus.
    fireEvent.click(screen.getByRole("button", { name: "Inline code" }));
    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith([
        { text, marks: [{ type: "code" }] },
      ]),
    );
    expect(field.querySelector("code")).toHaveTextContent(text);
    fireEvent.click(screen.getByRole("button", { name: "Undo text edit" }));
    await waitFor(() =>
      expect(field.querySelector("[data-spoiler]")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo text edit" }));
    await waitFor(() =>
      expect(field.querySelector("code")).toHaveTextContent(text),
    );
  });
});
