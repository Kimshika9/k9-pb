import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Block } from "../../shared/editor/model";
import { textContent } from "../../shared/editor/model";
import { EDITOR_LIMITS } from "../../shared/editor/schema";
import { RichTextEditor } from "./RichTextEditor";
import { RichTextView } from "./Preview";

export function TableBuilder({
  block,
  onChange,
}: {
  block: Extract<Block, { type: "table" }>;
  onChange: (block: Block) => void;
}) {
  const [cell, setCell] = useState({ row: 0, col: 0 });
  const selected = block.cells[cell.row]?.[cell.col] ?? block.cells[0]![0]!;
  const active = block.cells[cell.row]?.[cell.col] ? cell : { row: 0, col: 0 };
  function updateCell(text: typeof selected.text) {
    onChange({
      ...block,
      cells: block.cells.map((r, i) =>
        r.map((c, j) =>
          i === active.row && j === active.col ? { ...c, text } : c,
        ),
      ),
    });
  }
  return (
    <div className="table-builder">
      <div className="builder-controls">
        <button
          className="button secondary"
          type="button"
          disabled={block.cells.length >= EDITOR_LIMITS.rows}
          onClick={() =>
            onChange({
              ...block,
              cells: [
                ...block.cells,
                block.cells[0]!.map(() => ({ text: [], header: false })),
              ],
            })
          }
        >
          <Plus size={14} /> Row
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={block.cells[0]!.length >= EDITOR_LIMITS.columns}
          onClick={() =>
            onChange({
              ...block,
              cells: block.cells.map((r) => [
                ...r,
                { text: [], header: false },
              ]),
            })
          }
        >
          <Plus size={14} /> Column
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {block.cells[0]!.map((_, j) => (
                <th key={j}>
                  Column {j + 1}
                  <button
                    type="button"
                    aria-label={`Remove column ${j + 1}`}
                    disabled={block.cells[0]!.length <= 1}
                    onClick={() =>
                      onChange({
                        ...block,
                        cells: block.cells.map((r) =>
                          r.filter((_, k) => k !== j),
                        ),
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {block.cells.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j}>
                    <button
                      className={`table-cell ${active.row === i && active.col === j ? "active" : ""} ${c.header ? "header" : ""}`}
                      aria-label={`Edit cell row ${i + 1} column ${j + 1}`}
                      type="button"
                      onClick={() => setCell({ row: i, col: j })}
                    >
                      <RichTextView text={c.text} />
                      {!textContent(c.text) && "Empty"}
                    </button>
                  </td>
                ))}
                <td>
                  <button
                    type="button"
                    aria-label={`Remove row ${i + 1}`}
                    disabled={block.cells.length <= 1}
                    onClick={() =>
                      onChange({
                        ...block,
                        cells: block.cells.filter((_, k) => k !== i),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RichTextEditor
        key={`${active.row}-${active.col}`}
        label={`Cell ${active.row + 1}, ${active.col + 1}`}
        value={selected.text}
        onChange={updateCell}
      />
      <label className="check-field">
        <input
          type="checkbox"
          checked={selected.header}
          onChange={(e) =>
            onChange({
              ...block,
              cells: block.cells.map((r, i) =>
                r.map((c, j) =>
                  i === active.row && j === active.col
                    ? { ...c, header: e.target.checked }
                    : c,
                ),
              ),
            })
          }
        />{" "}
        Header cell
      </label>
      <div className="check-grid">
        {(["bordered", "striped", "compact"] as const).map((field) => (
          <label className="check-field" key={field}>
            <input
              type="checkbox"
              checked={block[field]}
              onChange={(e) =>
                onChange({ ...block, [field]: e.target.checked })
              }
            />
            {field}
          </label>
        ))}
      </div>
      <RichTextEditor
        label="Table caption"
        value={block.caption}
        onChange={(caption) => onChange({ ...block, caption })}
      />
      <small className="field-help">
        Studio table limit: 20 rows × 8 columns. Scroll horizontally to reach
        every cell.
      </small>
    </div>
  );
}
