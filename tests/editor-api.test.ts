import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../worker";
import {
  createDatabase,
  ownerRequest,
  testEnv,
  signedInitData,
  OWNER_ID,
} from "./helpers";
import { createBlock } from "../shared/editor/operations";
import { plain } from "../shared/editor/model";
import type { Draft, Template } from "../shared/editor/model";
import type { Env } from "../worker/env";
let db: ReturnType<typeof createDatabase>;
let env: Env;
beforeEach(() => {
  db = createDatabase();
  env = testEnv(db.db);
});
afterEach(() => {
  db.sqlite.close();
  vi.unstubAllGlobals();
});
const document = () => ({
  version: 2 as const,
  blocks: [
    {
      id: crypto.randomUUID(),
      type: "paragraph" as const,
      text: plain("Hello မြန်မာ"),
    },
  ],
});
const send = (path: string, method = "GET", body?: unknown) =>
  handleRequest(
    ownerRequest(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
async function create(): Promise<Draft> {
  const r = await send("/api/drafts", "POST", {
    title: "Draft one",
    document: document(),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { draft: Draft }).draft;
}
describe("persistent owner drafts", () => {
  it("creates, restores, searches, updates, exports, duplicates and deletes", async () => {
    let d = await create();
    expect(d.revision).toBe(1);
    expect(
      ((await (await send("/api/drafts/" + d.id)).json()) as { draft: Draft })
        .draft.document,
    ).toEqual(d.document);
    expect(
      (
        (await (await send("/api/drafts?q=one")).json()) as {
          drafts: unknown[];
        }
      ).drafts,
    ).toHaveLength(1);
    expect(
      (
        (await (await send("/api/drafts?q=missing")).json()) as {
          drafts: unknown[];
        }
      ).drafts,
    ).toHaveLength(0);
    d = (
      (await (
        await send("/api/drafts/" + d.id, "PUT", {
          title: "Saved title",
          document: d.document,
          revision: d.revision,
        })
      ).json()) as { draft: Draft }
    ).draft;
    expect(d.revision).toBe(2);
    expect((await send("/api/drafts/" + d.id + "/export")).status).toBe(200);
    const copy = (
      (await (
        await send("/api/drafts/" + d.id + "/duplicate", "POST")
      ).json()) as { draft: Draft }
    ).draft;
    expect(copy.id).not.toBe(d.id);
    expect(copy.document.blocks[0]?.id).not.toBe(d.document.blocks[0]?.id);
    expect(
      (await send("/api/drafts/" + d.id, "DELETE", { revision: 2 })).status,
    ).toBe(200);
    expect((await send("/api/drafts/" + d.id)).status).toBe(404);
  });
  it("rejects stale update/delete revisions and preserves the newest content", async () => {
    const d = await create();
    const body = { title: "Newest", document: d.document, revision: 1 };
    expect((await send("/api/drafts/" + d.id, "PUT", body)).status).toBe(200);
    expect(
      (
        await send("/api/drafts/" + d.id, "PUT", {
          ...body,
          title: "Overwrite",
        })
      ).status,
    ).toBe(409);
    expect(
      (await send("/api/drafts/" + d.id, "DELETE", { revision: 1 })).status,
    ).toBe(409);
    expect(
      ((await (await send("/api/drafts/" + d.id)).json()) as { draft: Draft })
        .draft.title,
    ).toBe("Newest");
  });
  it("rejects malformed documents and unregistered media while saving incomplete drafts", async () => {
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "Test",
          document: { version: 2, blocks: [{ type: "evil" }] },
        })
      ).status,
    ).toBe(400);
    const photo = createBlock("photo");
    if (photo.type !== "photo") throw Error();
    const incomplete = { version: 2, blocks: [photo] };
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "Incomplete",
          document: incomplete,
        })
      ).status,
    ).toBe(201);
    photo.media = {
      fileId: "AgAC_file_123456",
      libraryId: null,
      name: "Unknown",
    };
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "Foreign media",
          document: incomplete,
        })
      ).status,
    ).toBe(400);
  });
  it("hides foreign-owned resources and refuses non-draft mutation", async () => {
    const d = await create();
    db.sqlite
      .prepare("UPDATE posts SET owner_telegram_id=? WHERE id=?")
      .run("someone-else", d.id);
    expect((await send("/api/drafts/" + d.id)).status).toBe(404);
    expect(
      (
        await send("/api/drafts/" + d.id, "PUT", {
          title: "Bad",
          document: d.document,
          revision: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      ((await (await send("/api/drafts")).json()) as { drafts: unknown[] })
        .drafts,
    ).toHaveLength(0);
  });
  it.each(["/api/drafts", "/api/templates", "/api/media"])(
    "keeps %s protected by Phase 1 authentication",
    async (path) => {
      expect(
        (
          await handleRequest(
            new Request("https://studio.example.com" + path),
            env,
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await handleRequest(
            ownerRequest(
              path,
              {},
              signedInitData({ user: { id: 11, first_name: "Guest" } }),
            ),
            env,
          )
        ).status,
      ).toBe(403);
    },
  );
  it("preserves a legacy Phase 1 draft and upgrades it without deleting it", async () => {
    db.sqlite
      .prepare("INSERT INTO posts (id,title,document_json) VALUES (?,?,?)")
      .run(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Legacy",
        '{"version":1,"blocks":[]}',
      );
    const response = await send(
      "/api/drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(
      ((await response.json()) as { draft: Draft }).draft.document,
    ).toEqual({ version: 2, blocks: [] });
  });
});
describe("templates", () => {
  it("preserves unsupported legacy templates without blocking valid templates or drafts", async () => {
    const id = crypto.randomUUID();
    db.sqlite
      .prepare("INSERT INTO templates (id,name,document_json) VALUES (?,?,?)")
      .run(
        id,
        "Legacy unsupported",
        JSON.stringify({ version: 1, blocks: [{ type: "unknown" }] }),
      );
    const response = await send("/api/templates");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      unavailableTemplates: 1,
      templates: expect.any(Array),
    });
    expect((await send("/api/drafts")).status).toBe(200);
    expect(
      db.sqlite
        .prepare("SELECT document_json FROM templates WHERE id=?")
        .get(id),
    ).toMatchObject({
      document_json: JSON.stringify({
        version: 1,
        blocks: [{ type: "unknown" }],
      }),
    });
    expect((await send("/api/drafts?offset=-1")).status).toBe(400);
  });
  it("includes four valid samples and allows saving, reuse, rename, duplicate and delete", async () => {
    const samples = (
      (await (await send("/api/templates")).json()) as { templates: Template[] }
    ).templates;
    expect(samples).toHaveLength(4);
    for (const sample of samples)
      expect(
        (
          await send("/api/drafts", "POST", {
            title: sample.name,
            document: sample.document,
          })
        ).status,
      ).toBe(201);
    const r = await send("/api/templates", "POST", {
      name: "Saved template",
      document: document(),
    });
    expect(r.status).toBe(201);
    let t = ((await r.json()) as { template: Template }).template;
    t = (
      (await (
        await send("/api/templates/" + t.id, "PATCH", {
          name: "Renamed",
          revision: t.revision,
        })
      ).json()) as { template: Template }
    ).template;
    expect(t.revision).toBe(2);
    expect(
      (
        await send("/api/templates/" + t.id, "PATCH", {
          name: "Stale",
          revision: 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await send("/api/templates", "POST", {
          name: "Duplicate",
          document: t.document,
        })
      ).status,
    ).toBe(201);
    expect(
      (await send("/api/templates/" + t.id, "DELETE", { revision: t.revision }))
        .status,
    ).toBe(200);
  });
});
describe("private bot media library", () => {
  function webhookMedia(
    file: Record<string, unknown>,
    userId = OWNER_ID,
    kind = "photo",
  ) {
    return new Request("https://studio.example.com/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 555,
        message: {
          from: { id: userId },
          chat: { id: userId, type: "private" },
          [kind]: kind === "photo" ? [file] : file,
        },
      }),
    });
  }
  const file = {
    file_id: "AgAC_file_123456",
    file_unique_id: "unique_123",
    file_size: 1000,
    width: 100,
    height: 100,
  };
  it("registers owner media, deduplicates repeated delivery, selects and saves it", async () => {
    expect((await handleRequest(webhookMedia(file), env)).status).toBe(200);
    expect((await handleRequest(webhookMedia(file), env)).status).toBe(200);
    const items = (
      (await (await send("/api/media?kind=photo")).json()) as {
        media: { id: string; telegram_file_id: string }[];
      }
    ).media;
    expect(items).toHaveLength(1);
    const photo = createBlock("photo");
    if (photo.type !== "photo") throw Error();
    photo.media = {
      libraryId: items[0]!.id,
      fileId: items[0]!.telegram_file_id,
      name: "Photo",
    };
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "With photo",
          document: { version: 2, blocks: [photo] },
        })
      ).status,
    ).toBe(201);
  });
  it("ignores non-owner media and rejects invalid IDs, oversized files and unsupported kinds", async () => {
    expect((await handleRequest(webhookMedia(file, 22), env)).status).toBe(200);
    expect(db.sqlite.prepare("SELECT * FROM media").all()).toHaveLength(0);
    expect(
      (
        await handleRequest(
          webhookMedia({ ...file, file_id: "evil://token" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleRequest(
          webhookMedia({ ...file, file_size: 30 * 1024 * 1024 }),
          env,
        )
      ).status,
    ).toBe(413);
    expect((await send("/api/media?kind=audio")).status).toBe(400);
  });
  it("verifies manually supplied IDs through getFile without exposing file URLs or tokens", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        result: { ...file, file_path: "private/path.jpg" },
      }),
    );
    vi.stubGlobal("fetch", transport);
    const r = await send("/api/media", "POST", {
      fileId: file.file_id,
      kind: "photo",
      name: "Existing photo",
    });
    expect(r.status).toBe(201);
    const output = JSON.stringify(await r.json());
    expect(output).not.toContain("file_path");
    expect(output).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
});

describe("concurrency and media integrity regression checks", () => {
  it("allows exactly one of two saves with the same revision", async () => {
    const d = await create();
    const results = await Promise.all([
      send("/api/drafts/" + d.id, "PUT", {
        title: "First",
        document: d.document,
        revision: 1,
      }),
      send("/api/drafts/" + d.id, "PUT", {
        title: "Second",
        document: d.document,
        revision: 1,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM history WHERE post_id=? AND action='draft.updated'",
        )
        .get(d.id),
    ).toMatchObject({ n: 1 });
  });
  it("omits foreign-owned drafts from dashboard data", async () => {
    const d = await create();
    db.sqlite
      .prepare("UPDATE posts SET owner_telegram_id=? WHERE id=?")
      .run("foreign", d.id);
    const result = (await (await send("/api/dashboard")).json()) as {
      counts: { drafts: number };
      recentPosts: unknown[];
    };
    expect(result.counts.drafts).toBe(0);
    expect(result.recentPosts).toHaveLength(0);
  });
  it("rejects extra ownership fields and unapproved channel assignment", async () => {
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "Test",
          document: document(),
          owner_telegram_id: "foreign",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("/api/drafts", "POST", {
          title: "Test",
          document: document(),
          channelId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(403);
  });
  it("retains the canonical media ID when the same file is registered again", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            result: {
              file_id: "AgAC_original_file_123",
              file_unique_id: "stable_unique",
              file_size: 200,
            },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            result: {
              file_id: "AgAC_newer_file_456",
              file_unique_id: "stable_unique",
              file_size: 200,
            },
          }),
        ),
    );
    await send("/api/media", "POST", {
      fileId: "AgAC_original_file_123",
      kind: "photo",
      name: "Original",
    });
    const result = (await (
      await send("/api/media", "POST", {
        fileId: "AgAC_newer_file_456",
        kind: "photo",
        name: "New",
      })
    ).json()) as { media: { telegram_file_id: string } };
    expect(result.media.telegram_file_id).toBe("AgAC_original_file_123");
  });
});
