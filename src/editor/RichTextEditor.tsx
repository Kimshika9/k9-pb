import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, Mark, mergeAttributes, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  EyeOff,
  Code,
  Link2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import type { RichText } from "../../shared/editor/model";
import { fromEditorJSON, toEditorJSON } from "../../shared/editor/operations";
import { isSafeUrl } from "../../shared/editor/schema";
function toggleInlineCode(editor: Editor): boolean {
  const chain = editor.chain();
  const { selection, doc } = editor.state;
  // Convert whole-document selection to a text range before an exclusive mark edit.
  // This preserves Ctrl/Cmd+A after undo/redo when the DOM selection has collapsed.
  if (
    selection.from === 0 &&
    selection.to === doc.content.size &&
    doc.content.size >= 2
  ) {
    chain.setTextSelection({ from: 1, to: doc.content.size - 1 });
  }
  return editor.isActive("code")
    ? chain.focus().unsetCode().run()
    : chain.focus().unsetAllMarks().setCode().run();
}
const CodeShortcut = Extension.create({
  name: "studioCodeShortcut",
  priority: 1100,
  addKeyboardShortcuts() {
    return { "Mod-e": () => toggleInlineCode(this.editor) };
  },
});
const Spoiler = Mark.create({
  name: "spoiler",
  parseHTML: () => [{ tag: "span[data-spoiler]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, {
      "data-spoiler": "true",
      class: "text-spoiler",
    }),
    0,
  ],
});
export function RichTextEditor({
  value,
  onChange,
  label,
}: {
  value: RichText;
  onChange: (text: RichText) => void;
  label: string;
}) {
  const current = useRef(onChange);
  useEffect(() => {
    current.current = onChange;
  }, [onChange]);
  const [linkOpen, setLinkOpen] = useState(false),
    [href, setHref] = useState(""),
    [error, setError] = useState("");
  const last = useRef(JSON.stringify(value));
  const selection = useRef<{ from: number; to: number } | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          isAllowedUri: (uri) => isSafeUrl(uri),
        },
        underline: {},
      }),
      Spoiler,
      CodeShortcut,
    ],
    content: toEditorJSON(value),
    editorProps: {
      handleDOMEvents: {
        mousedown: () => {
          selection.current = null;
          return false;
        },
        beforeinput: () => {
          selection.current = null;
          return false;
        },
      },
      handleKeyDown: (_view, event) => {
        if (!event.ctrlKey && !event.metaKey && event.key !== "Shift")
          selection.current = null;
        return false;
      },
      attributes: {
        "aria-label": label,
        role: "textbox",
        "aria-multiline": "true",
        class: "rich-text-input",
      },
    },
    onSelectionUpdate: ({ editor: e }) => {
      if (!e.state.selection.empty)
        selection.current = {
          from: e.state.selection.from,
          to: e.state.selection.to,
        };
    },
    onUpdate: ({ editor: e }) => {
      const runs = fromEditorJSON(e.getJSON());
      last.current = JSON.stringify(runs);
      current.current(runs);
    },
    immediatelyRender: true,
    shouldRerenderOnTransaction: true,
  });
  useEffect(() => {
    const next = JSON.stringify(value);
    if (editor && next !== last.current) {
      last.current = next;
      editor.commands.setContent(toEditorJSON(value), { emitUpdate: false });
    }
  }, [editor, value]);
  if (!editor) return <p role="status">Loading text editor…</p>;
  function formatChain() {
    const chain = editor!.chain();
    const range = selection.current;
    if (range)
      chain.setTextSelection({
        from: Math.max(1, range.from),
        to: Math.min(editor!.state.doc.content.size - 1, range.to),
      });
    return chain.focus();
  }
  const tools = [
    { name: "Bold", icon: Bold, active: "bold" },
    { name: "Italic", icon: Italic, active: "italic" },
    { name: "Underline", icon: Underline, active: "underline" },
    { name: "Strikethrough", icon: Strikethrough, active: "strike" },
    { name: "Spoiler", icon: EyeOff, active: "spoiler" },
    { name: "Inline code", icon: Code, active: "code" },
  ];
  function format(active: string) {
    const codeActive = editor!.isActive("code");
    const chain = formatChain();
    if (active === "code")
      return codeActive
        ? chain.unsetCode().run()
        : chain.unsetAllMarks().setCode().run();
    return chain.unsetCode().toggleMark(active).run();
  }
  function applyLink() {
    if (!isSafeUrl(href.trim())) {
      setError("Use an http, https or tg URL without credentials.");
      return;
    }
    formatChain()
      .unsetCode()
      .extendMarkRange("link")
      .setLink({ href: href.trim() })
      .run();
    setLinkOpen(false);
    setError("");
  }
  return (
    <div className="rich-text-field">
      <span className="field-label">{label}</span>
      <div
        className="rich-toolbar"
        role="toolbar"
        aria-label={`${label} formatting`}
      >
        {tools.map(({ name, icon: Icon, active }) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={editor.isActive(active)}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format(active)}
          >
            <Icon size={16} />
          </button>
        ))}
        <button
          type="button"
          aria-label="Edit hyperlink"
          title="Edit hyperlink"
          aria-pressed={editor.isActive("link")}
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setHref(String(editor.getAttributes("link").href ?? ""));
            setLinkOpen(!linkOpen);
            setError("");
          }}
        >
          <Link2 size={16} />
        </button>
        <button
          type="button"
          aria-label="Undo text edit"
          title="Undo (Ctrl/Cmd+Z)"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          aria-label="Redo text edit"
          title="Redo (Ctrl/Cmd+Shift+Z)"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          <Redo2 size={16} />
        </button>
      </div>
      {linkOpen && (
        <div className="link-editor">
          <input
            aria-label="Hyperlink URL"
            placeholder="https://…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
          />
          <button
            className="button secondary"
            type="button"
            onClick={applyLink}
          >
            Apply
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              setLinkOpen(false);
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close hyperlink editor"
            onClick={() => setLinkOpen(false)}
          >
            <X size={14} />
          </button>
          {error && (
            <p role="alert" className="error-inline">
              {error}
            </p>
          )}
        </div>
      )}
      <EditorContent editor={editor} />
      <small className="field-help">
        Myanmar & English supported · Ctrl/Cmd+B, I, U · text is stored as
        structured formatting.
      </small>
    </div>
  );
}
