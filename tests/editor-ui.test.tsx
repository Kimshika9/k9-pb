// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Draft, Block, RichText } from "../shared/editor/model";
import { plain, textContent } from "../shared/editor/model";
import { createBlock } from "../shared/editor/operations";
vi.mock("../src/lib/telegram", () => ({
  telegramInitData: "test-only-init-data",
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  api: vi.fn(),
}));
// Test editor state and persistence independently of ProseMirror's browser selection APIs.
// Actual rich text formatting is exercised in the Chromium smoke workflow.
vi.mock("../src/editor/RichTextEditor", () => ({
  RichTextEditor: ({
    value,
    onChange,
    label,
  }: {
    value: RichText;
    onChange: (r: RichText) => void;
    label: string;
  }) => (
    <textarea
      aria-label={label}
      value={textContent(value)}
      onChange={(e) => onChange(plain(e.target.value))}
    />
  ),
}));
import { api, ApiError } from "../src/lib/api";
import { DraftEditor } from "../src/editor/DraftEditor";
import { BlockCanvas } from "../src/editor/BlockEditor";
import { PostPreview } from "../src/editor/Preview";
const apiMock = vi.mocked(api);
const makeDraft = (): Draft => ({
  id: crypto.randomUUID(),
  title: "Saved draft",
  document: {
    version: 2,
    blocks: [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        text: plain("Saved content"),
      },
    ],
  },
  revision: 1,
  channelId: null,
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
});
afterEach(() => {
  cleanup();
  apiMock.mockReset();
  vi.restoreAllMocks();
});
describe("visual block canvas", () => {
  it("adds, edits, duplicates, reorders and deletes blocks", () => {
    function Harness() {
      const [blocks, setBlocks] = useState<Block[]>([]);
      return <BlockCanvas blocks={blocks} onChange={setBlocks} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Heading" }));
    fireEvent.change(screen.getByLabelText("Heading text"), {
      target: { value: "A new heading" },
    });
    expect(
      screen.getByRole("button", { name: "A new heading" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate block 1" }));
    expect(
      screen.getAllByRole("button", { name: "A new heading" }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Move block 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete block 1" }));
    expect(
      screen.getAllByRole("button", { name: "A new heading" }),
    ).toHaveLength(1);
  });
  it("renders safe text, interactive details, a table and both preview themes", () => {
    const table = createBlock("table"),
      details = createBlock("details");
    if (details.type !== "details") throw Error();
    details.blocks = [table];
    render(
      <PostPreview
        title="Safe preview"
        document={{
          version: 2,
          blocks: [
            details,
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              text: plain("<script>alert(1)</script> မြန်မာ"),
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText("<script>alert(1)</script> မြန်မာ"),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Light preview" }));
    expect(
      document.querySelector(".telegram-preview.light"),
    ).toBeInTheDocument();
    expect(screen.getByText("More information")).toBeInTheDocument();
  });
});
describe("autosave and conflict recovery", () => {
  it("debounces saves and restores saved document content", async () => {
    const draft = makeDraft();
    apiMock.mockImplementation(async (_path, options) => ({
      draft: { ...draft, ...JSON.parse(String(options?.body)), revision: 2 },
    }));
    render(
      <DraftEditor
        initial={draft}
        channels={[]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Paragraph text")).toHaveValue(
      "Saved content",
    );
    fireEvent.change(screen.getByLabelText("Post title"), {
      target: { value: "Autosaved title" },
    });
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
    expect(apiMock).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMock).toHaveBeenCalledOnce(), {
      timeout: 2500,
    });
    await waitFor(() =>
      expect(screen.getByText(/All changes saved/)).toBeInTheDocument(),
    );
  });
  it("keeps edits made during an in-flight save and uses the returned revision next", async () => {
    const draft = makeDraft();
    let finish: (value: unknown) => void = () => {};
    let firstInput: Record<string, unknown> = {};
    apiMock.mockImplementationOnce(async (_path, options) => {
      firstInput = JSON.parse(String(options?.body));
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    apiMock.mockImplementation(async (_path, options) => ({
      draft: { ...draft, ...JSON.parse(String(options?.body)), revision: 3 },
    }));
    render(
      <DraftEditor
        initial={draft}
        channels={[]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Post title"), {
      target: { value: "First edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.change(screen.getByLabelText("Post title"), {
      target: { value: "Second edit" },
    });
    finish({ draft: { ...draft, ...firstInput, revision: 2 } });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    const second = JSON.parse(String(apiMock.mock.calls[1]?.[1]?.body));
    expect(second.title).toBe("Second edit");
    expect(second.revision).toBe(2);
  });
  it("pauses autosave on a conflict and preserves local text for recovery", async () => {
    const draft = makeDraft();
    apiMock.mockRejectedValue(
      new ApiError(409, "VERSION_CONFLICT", "This draft changed elsewhere."),
    );
    render(
      <DraftEditor
        initial={draft}
        channels={[]}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Paragraph text"), {
      target: { value: "Local work to keep" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByText("This draft changed elsewhere."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Paragraph text")).toHaveValue(
      "Local work to keep",
    );
    expect(
      screen.getByRole("button", { name: "Save as new draft" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download backup" }),
    ).toHaveAttribute("download", "k9-unsaved-backup.json");
    expect(apiMock).toHaveBeenCalledOnce();
  });
  it("confirms before discarding unsaved work on editor back navigation", () => {
    const close = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <DraftEditor
        initial={makeDraft()}
        channels={[]}
        onClose={close}
        onCreated={vi.fn()}
        onDirtyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Post title"), {
      target: { value: "Unsaved" },
    });
    fireEvent.click(screen.getByRole("button", { name: "All drafts" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

import { PostsWorkspace } from "../src/editor/PostsWorkspace";
import { SAMPLE_TEMPLATES } from "../shared/editor/samples";
describe("template navigation regression", () => {
  it("returns to the draft list when closing a draft created from a sample", async () => {
    apiMock.mockImplementation(async (path, options) => {
      if (path === "/api/templates")
        return { templates: [SAMPLE_TEMPLATES[0]] };
      if (path === "/api/drafts" && options?.method === "POST")
        return { draft: makeDraft() };
      return { drafts: [], nextOffset: null };
    });
    render(<PostsWorkspace channels={[]} onDirtyChange={vi.fn()} />);
    await screen.findByText("Make room for your next idea");
    fireEvent.click(screen.getByRole("button", { name: "Templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Use template" }));
    await screen.findByLabelText("Post title");
    fireEvent.click(screen.getByRole("button", { name: "All drafts" }));
    expect(screen.getByLabelText("Search drafts")).toBeInTheDocument();
  });
});
