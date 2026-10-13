import { Fragment, useState } from "react";
import { FileText, Image, Play, Sun, Moon, ShieldCheck } from "lucide-react";
import type {
  Block,
  EditorDocument,
  RichText,
} from "../../shared/editor/model";
import { textContent } from "../../shared/editor/model";
import { isSafeUrl } from "../../shared/editor/schema";
export function RichTextView({
  text,
  interactive = true,
}: {
  text: RichText;
  interactive?: boolean;
}) {
  return (
    <>
      {text.map((run, i) => {
        let node: React.ReactNode = run.text;
        for (const mark of [...run.marks].reverse())
          switch (mark.type) {
            case "bold":
              node = <strong>{node}</strong>;
              break;
            case "italic":
              node = <em>{node}</em>;
              break;
            case "underline":
              node = <u>{node}</u>;
              break;
            case "strikethrough":
              node = <s>{node}</s>;
              break;
            case "code":
              node = <code>{node}</code>;
              break;
            case "spoiler":
              node = (
                <span className="preview-spoiler" tabIndex={0}>
                  {node}
                </span>
              );
              break;
            case "link":
              node =
                interactive && isSafeUrl(mark.href) ? (
                  <a href={mark.href} target="_blank" rel="noopener noreferrer">
                    {node}
                  </a>
                ) : (
                  node
                );
              break;
          }
        return <Fragment key={i}>{node}</Fragment>;
      })}
    </>
  );
}
export function PreviewBlocks({ blocks }: { blocks: Block[] }) {
  const [callbackNotice, setCallbackNotice] = useState("");
  return (
    <>
      {blocks.map((b) => {
        switch (b.type) {
          case "heading": {
            const Tag = `h${b.size}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <Tag key={b.id}>
                <RichTextView text={b.text} />
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={b.id}>
                <RichTextView text={b.text} />
              </p>
            );
          case "pre":
            return (
              <pre key={b.id}>
                <small>{b.language}</small>
                <code>{b.text}</code>
              </pre>
            );
          case "divider":
            return <hr key={b.id} />;
          case "blockquote":
            return (
              <blockquote key={b.id}>
                <PreviewBlocks blocks={b.blocks} />
                {textContent(b.credit) && (
                  <cite>
                    <RichTextView text={b.credit} />
                  </cite>
                )}
              </blockquote>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={b.id}>
                {b.items.map((item) => (
                  <li key={item.id}>
                    <RichTextView text={item.text} />
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div className="preview-table-scroll" key={b.id}>
                <table
                  className={`${b.bordered ? "bordered" : ""} ${b.striped ? "striped" : ""} ${b.compact ? "compact" : ""}`}
                >
                  {textContent(b.caption) && (
                    <caption>
                      <RichTextView text={b.caption} />
                    </caption>
                  )}
                  <tbody>
                    {b.cells.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) =>
                          cell.header ? (
                            <th key={j}>
                              <RichTextView text={cell.text} />
                            </th>
                          ) : (
                            <td key={j}>
                              <RichTextView text={cell.text} />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "details":
            return (
              <details key={b.id} open={b.open}>
                <summary>
                  <RichTextView text={b.summary} />
                </summary>
                <PreviewBlocks blocks={b.blocks} />
              </details>
            );
          case "buttons":
            return (
              <div
                key={b.id}
                className="preview-buttons"
                style={{
                  justifyContent:
                    b.align === "left"
                      ? "flex-start"
                      : b.align === "right"
                        ? "flex-end"
                        : "center",
                }}
              >
                {b.buttons.map((button) =>
                  button.action.type === "url" &&
                  isSafeUrl(button.action.value) ? (
                    <a
                      className={`rich-button ${button.style}`}
                      key={button.id}
                      href={button.action.value}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <RichTextView text={button.label} interactive={false} />
                      <span>↗</span>
                    </a>
                  ) : (
                    <button
                      type="button"
                      className={`rich-button ${button.style}`}
                      key={button.id}
                      onClick={() =>
                        setCallbackNotice(
                          button.action.type === "callback"
                            ? `Callback preview: ${button.action.value || "(empty)"}. No workflow is executed.`
                            : "Add a valid URL in the button designer.",
                        )
                      }
                    >
                      <RichTextView text={button.label} interactive={false} />
                    </button>
                  ),
                )}
              </div>
            );
          case "photo":
          case "video":
          case "document": {
            const Icon =
              b.type === "photo" ? Image : b.type === "video" ? Play : FileText;
            return (
              <figure key={b.id}>
                <div className={`media-placeholder ${b.type}`}>
                  <Icon size={34} />
                  <strong>{b.media?.name ?? `Select a ${b.type}`}</strong>
                  <small>
                    {b.spoiler ? "Spoiler · " : ""}Telegram file · preview
                    placeholder
                  </small>
                </div>
                {textContent(b.caption) && (
                  <figcaption>
                    <RichTextView text={b.caption} />
                  </figcaption>
                )}
              </figure>
            );
          }
        }
      })}
      {callbackNotice && (
        <p className="callback-notice" role="status">
          {callbackNotice}
        </p>
      )}
    </>
  );
}
export function PostPreview({
  document,
  title,
}: {
  document: EditorDocument;
  title: string;
}) {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  return (
    <section className="preview-panel">
      <div className="preview-toolbar">
        <span>Telegram-style preview</span>
        <button
          type="button"
          className="button secondary"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}{" "}
          {theme === "dark" ? "Light" : "Dark"} preview
        </button>
      </div>
      <div className={`telegram-preview ${theme}`}>
        <div className="preview-channel">
          <span className="channel-avatar">K9</span>
          <div>
            <strong>Your channel</strong>
            <small>Rich post preview</small>
          </div>
        </div>
        <article
          className="telegram-message"
          aria-label={`Preview of ${title}`}
        >
          <PreviewBlocks blocks={document.blocks} />
          {!document.blocks.length && (
            <p className="preview-empty">Add a block to start your post.</p>
          )}
          <footer>Preview · {title || "Untitled draft"}</footer>
        </article>
      </div>
      <p className="preview-disclaimer">
        <ShieldCheck size={14} /> Browser approximation. No Telegram message is
        sent.
      </p>
    </section>
  );
}
