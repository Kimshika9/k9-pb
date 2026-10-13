import { z } from "zod";
import type {
  Draft,
  DraftSummary,
  EditorDocument,
  Template,
} from "../../shared/editor/model";
import { parseDocument, DocumentError } from "../../shared/editor/schema";
import { cloneDocument } from "../../shared/editor/operations";
import { plain } from "../../shared/editor/model";
import { SAMPLE_TEMPLATES } from "../../shared/editor/samples";
import type { Env } from "../env";
import type { TelegramUser } from "../../shared/contracts";
import { HttpError, json, readJson } from "./http";
import { requireApprovedChannel } from "./channels";
import {
  serializeRichMessage,
  validateForTelegram,
} from "../../shared/editor/telegram";

interface DraftRow {
  id: string;
  title: string;
  document_json: string;
  revision: number;
  channel_id: string | null;
  created_at: string;
  updated_at: string;
}
interface TemplateRow {
  id: string;
  name: string;
  document_json: string;
  revision: number;
}
const title = z.string().trim().min(1).max(160);
const documentValue = z.unknown().transform((v, ctx) => {
  try {
    return parseDocument(v);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : "Invalid document",
    });
    return z.NEVER;
  }
});
const createDraftSchema = z.strictObject({
  title,
  document: documentValue,
  channelId: z.string().uuid().nullable().optional(),
});
const updateDraftSchema = createDraftSchema.extend({
  revision: z.number().int().positive(),
});
const templateSchema = z.strictObject({ name: title, document: documentValue });
const versionSchema = z.strictObject({ revision: z.number().int().positive() });
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success)
    throw new HttpError(
      400,
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "Invalid input.",
    );
  return parsed.data;
}
function storedDocument(raw: string): EditorDocument {
  const value: unknown = JSON.parse(raw);
  // Migrate the small Phase 1 stub model on read; no existing records are reset.
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 1 &&
    "blocks" in value &&
    Array.isArray(value.blocks)
  ) {
    if (!value.blocks.length) return { version: 2, blocks: [] };
    const blocks = value.blocks.map((b: unknown) => {
      if (
        b &&
        typeof b === "object" &&
        "type" in b &&
        "text" in b &&
        typeof b.text === "string"
      ) {
        if (b.type === "paragraph")
          return {
            id: crypto.randomUUID(),
            type: "paragraph" as const,
            text: plain(b.text),
          };
        if (
          b.type === "heading" &&
          "size" in b &&
          [1, 2, 3].includes(Number(b.size))
        )
          return {
            id: crypto.randomUUID(),
            type: "heading" as const,
            text: plain(b.text),
            size: Number(b.size) as 1 | 2 | 3,
          };
      }
      if (b && typeof b === "object" && "type" in b && b.type === "divider")
        return { id: crypto.randomUUID(), type: "divider" as const };
      throw new HttpError(
        422,
        "LEGACY_DOCUMENT",
        "This legacy document needs an explicit import; its original data has been preserved.",
      );
    });
    return parseDocument({ version: 2, blocks });
  }
  return parseDocument(value);
}
const draft = (row: DraftRow): Draft => ({
  id: row.id,
  title: row.title,
  document: storedDocument(row.document_json),
  revision: row.revision,
  channelId: row.channel_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const template = (row: TemplateRow): Template => ({
  id: row.id,
  name: row.name,
  document: storedDocument(row.document_json),
  revision: row.revision,
  builtin: false,
});
const ownerSql = "(owner_telegram_id=? OR owner_telegram_id IS NULL)";
async function getDraft(
  env: Env,
  id: string,
  owner: string,
): Promise<DraftRow> {
  const row = await env.DB.prepare(
    `SELECT * FROM posts WHERE id=? AND status='draft' AND ${ownerSql}`,
  )
    .bind(id, owner)
    .first<DraftRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND", "Draft not found.");
  return row;
}
async function validateMediaOwnership(
  env: Env,
  doc: EditorDocument,
  owner: string,
): Promise<void> {
  async function walk(blocks: EditorDocument["blocks"]) {
    for (const b of blocks) {
      if (b.type === "details" || b.type === "blockquote") await walk(b.blocks);
      if (
        (b.type === "photo" || b.type === "video" || b.type === "document") &&
        b.media
      ) {
        const row = await env.DB.prepare(
          "SELECT id FROM media WHERE telegram_file_id=? AND kind=? AND owner_telegram_id=? AND (? IS NULL OR id=?)",
        )
          .bind(
            b.media.fileId,
            b.type,
            owner,
            b.media.libraryId,
            b.media.libraryId,
          )
          .first();
        if (!row)
          throw new HttpError(
            400,
            "MEDIA_NOT_REGISTERED",
            "Register this file with your bot or media library before saving it.",
          );
      }
    }
  }
  await walk(doc.blocks);
}
function audit(env: Env, owner: string, action: string, postId: string | null) {
  return env.DB.prepare(
    "INSERT INTO history (id,post_id,actor_telegram_id,action) SELECT ?,?,?,? WHERE changes()>0",
  ).bind(crypto.randomUUID(), postId, owner, action);
}
export async function editorRoutes(
  request: Request,
  env: Env,
  user: TelegramUser,
  url: URL,
): Promise<Response | null> {
  const owner = String(user.id),
    path = url.pathname,
    method = request.method;
  try {
    if (path === "/api/drafts") {
      if (method === "GET") {
        const q = (url.searchParams.get("q") ?? "").slice(0, 160);
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
        if (!Number.isSafeInteger(offset))
          throw new HttpError(400, "INVALID_OFFSET", "Invalid offset.");
        const rows = await env.DB.prepare(
          `SELECT id,title,revision,updated_at AS updatedAt FROM posts WHERE status='draft' AND ${ownerSql} AND instr(lower(title),lower(?))>0 ORDER BY updated_at DESC,id LIMIT 51 OFFSET ?`,
        )
          .bind(owner, q, offset)
          .all<DraftSummary>();
        return json({
          drafts: rows.results.slice(0, 50),
          nextOffset: rows.results.length > 50 ? offset + 50 : null,
        });
      }
      if (method === "POST") {
        const input = await body(request, createDraftSchema);
        if (input.channelId) await requireApprovedChannel(env, input.channelId);
        await validateMediaOwnership(env, input.document, owner);
        const id = crypto.randomUUID();
        const results = await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO posts (id,title,document_json,schema_version,owner_telegram_id,channel_id) VALUES (?,?,?,2,?,?) RETURNING *`,
          ).bind(
            id,
            input.title,
            JSON.stringify(input.document),
            owner,
            input.channelId ?? null,
          ),
          audit(env, owner, "draft.created", id),
        ]);
        return json(
          { draft: draft(results[0]!.results[0] as unknown as DraftRow) },
          201,
        );
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
    }
    const match =
      /^\/api\/drafts\/([a-f0-9-]{36})(?:\/(duplicate|export))?$/.exec(path);
    if (match) {
      const id = match[1]!,
        action = match[2];
      if (!action && method === "GET")
        return json({ draft: draft(await getDraft(env, id, owner)) });
      if (!action && method === "PUT") {
        const input = await body(request, updateDraftSchema);
        await getDraft(env, id, owner);
        if (input.channelId) await requireApprovedChannel(env, input.channelId);
        await validateMediaOwnership(env, input.document, owner);
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE posts SET title=?,document_json=?,schema_version=2,owner_telegram_id=?,channel_id=?,revision=revision+1,updated_at=? WHERE id=? AND status='draft' AND ${ownerSql} AND revision=? RETURNING *`,
          ).bind(
            input.title,
            JSON.stringify(input.document),
            owner,
            input.channelId ?? null,
            new Date().toISOString(),
            id,
            owner,
            input.revision,
          ),
          audit(env, owner, "draft.updated", id),
        ]);
        const row = results[0]!.results[0] as unknown as DraftRow | undefined;
        if (!row)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "This draft changed elsewhere. Reload or save your changes as a new draft.",
          );
        return json({ draft: draft(row) });
      }
      if (!action && method === "DELETE") {
        const input = await body(request, versionSchema);
        await getDraft(env, id, owner);
        const result = await env.DB.prepare(
          `DELETE FROM posts WHERE id=? AND status='draft' AND ${ownerSql} AND revision=? RETURNING id`,
        )
          .bind(id, owner, input.revision)
          .first();
        if (!result)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "This draft changed elsewhere. Reload before deleting.",
          );
        return json({ ok: true });
      }
      if (action === "duplicate" && method === "POST") {
        const source = draft(await getDraft(env, id, owner));
        return editorRoutes(
          new Request(request.url.replace("/" + id + "/duplicate", ""), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: `${source.title.slice(0, 150)} (copy)`,
              document: cloneDocument(source.document),
              channelId: source.channelId,
            }),
          }),
          env,
          user,
          new URL(url.origin + "/api/drafts"),
        );
      }
      if (action === "export" && method === "GET") {
        const d = draft(await getDraft(env, id, owner));
        const issues = validateForTelegram(d.document);
        if (issues.length)
          return json(
            {
              error: {
                code: "VALIDATION_FAILED",
                message: issues.map((x) => x.message).join("\n"),
              },
              issues,
            },
            422,
          );
        await validateMediaOwnership(env, d.document, owner);
        return json({ rich_message: serializeRichMessage(d.document) });
      }
      throw new HttpError(
        405,
        "METHOD_NOT_ALLOWED",
        "Unsupported draft operation.",
      );
    }
    if (path === "/api/templates") {
      if (method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT * FROM templates WHERE ${ownerSql} ORDER BY updated_at DESC LIMIT 100`,
        )
          .bind(owner)
          .all<TemplateRow>();
        return json({
          templates: [...SAMPLE_TEMPLATES, ...rows.results.map(template)],
        });
      }
      if (method === "POST") {
        const input = await body(request, templateSchema);
        await validateMediaOwnership(env, input.document, owner);
        const row = await env.DB.prepare(
          "INSERT INTO templates (id,name,document_json,schema_version,owner_telegram_id) VALUES (?,?,?,2,?) RETURNING *",
        )
          .bind(
            crypto.randomUUID(),
            input.name,
            JSON.stringify(input.document),
            owner,
          )
          .first<TemplateRow>();
        return json({ template: template(row!) }, 201);
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
    }
    const tm = /^\/api\/templates\/([a-f0-9-]{36})$/.exec(path);
    if (tm) {
      const id = tm[1]!;
      const row = await env.DB.prepare(
        `SELECT * FROM templates WHERE id=? AND ${ownerSql}`,
      )
        .bind(id, owner)
        .first<TemplateRow>();
      if (!row) throw new HttpError(404, "NOT_FOUND", "Template not found.");
      if (method === "PATCH") {
        const input = await body(
          request,
          z.strictObject({
            name: title,
            revision: z.number().int().positive(),
          }),
        );
        const updated = await env.DB.prepare(
          `UPDATE templates SET name=?,revision=revision+1,owner_telegram_id=?,updated_at=? WHERE id=? AND ${ownerSql} AND revision=? RETURNING *`,
        )
          .bind(
            input.name,
            owner,
            new Date().toISOString(),
            id,
            owner,
            input.revision,
          )
          .first<TemplateRow>();
        if (!updated)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Template changed elsewhere. Refresh the list.",
          );
        return json({ template: template(updated) });
      }
      if (method === "DELETE") {
        const input = await body(request, versionSchema);
        const removed = await env.DB.prepare(
          `DELETE FROM templates WHERE id=? AND ${ownerSql} AND revision=? RETURNING id`,
        )
          .bind(id, owner, input.revision)
          .first();
        if (!removed)
          throw new HttpError(
            409,
            "VERSION_CONFLICT",
            "Template changed elsewhere. Refresh the list.",
          );
        return json({ ok: true });
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use PATCH or DELETE.");
    }
    return null;
  } catch (error) {
    if (error instanceof DocumentError)
      throw new HttpError(422, "INVALID_DOCUMENT", error.message);
    throw error;
  }
}
