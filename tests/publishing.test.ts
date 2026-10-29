import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  createDatabase,
  testEnv,
  ownerRequest,
  OWNER_ID,
  signedInitData,
} from "./helpers";
import { handleRequest } from "../worker";
import type { Env } from "../worker/env";
import type { Publication } from "../shared/publishing";
import { plain } from "../shared/editor/model";
import { createBlock } from "../shared/editor/operations";
import { runScheduler } from "../worker/lib/scheduler";
import { localTimeToUTC } from "../shared/publishing";
let db: ReturnType<typeof createDatabase>,
  env: Env,
  channelId: string,
  postId: string;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
let behavior: "ok" | "rate" | "timeout" | "rejected" = "ok";
beforeEach(() => {
  db = createDatabase();
  env = { ...testEnv(db.db), SCHEDULER_ENABLED: "true" };
  channelId = crypto.randomUUID();
  postId = crypto.randomUUID();
  behavior = "ok";
  db.sqlite
    .prepare(
      "INSERT INTO channels(id,telegram_chat_id,title,approved_by,approved_at) VALUES(?,'-1001234567890','K9 Test',?,?)",
    )
    .run(channelId, String(OWNER_ID), new Date().toISOString());
  db.sqlite
    .prepare(
      "INSERT INTO posts(id,title,document_json,schema_version,owner_telegram_id) VALUES(?,'Test post',?,2,?)",
    )
    .run(
      postId,
      JSON.stringify({
        version: 2,
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            text: plain("မြန်မာ / Rich message"),
          },
        ],
      }),
      String(OWNER_ID),
    );
  transport = vi.fn<typeof fetch>(async (url, options) => {
    const method = String(url).split("/").at(-1),
      payload = JSON.parse(String(options?.body ?? "{}")) as {
        chat_id?: string;
        message_id?: number;
        user_id?: number;
        file_id?: string;
      };
    let result: unknown;
    if (method === "getChat")
      result = {
        id: Number(payload.chat_id),
        type: "channel",
        title: "K9 Test",
        username: "k9_test_channel",
      };
    else if (method === "getMe") result = { id: 777, username: "test_bot" };
    else if (method === "getChatMember")
      result =
        payload.user_id === OWNER_ID
          ? { status: "creator" }
          : {
              status: "administrator",
              can_post_messages: true,
              can_delete_messages: true,
            };
    else if (method === "getFile")
      result = {
        file_id: payload.file_id,
        file_unique_id: "test_unique",
        file_size: 500,
      };
    else if (method === "deleteMessage") result = true;
    else if (method === "sendRichMessage" || method === "editMessageText") {
      if (behavior === "rate")
        return Response.json(
          {
            ok: false,
            error_code: 429,
            parameters: { retry_after: 2 },
            description: "sensitive token",
          },
          { status: 429 },
        );
      if (behavior === "timeout")
        throw new Error("secret-bearing URL must not leak");
      if (behavior === "rejected")
        return Response.json(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: message can't be deleted",
          },
          { status: 400 },
        );
      result = {
        message_id: payload.message_id ?? 101,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(payload.chat_id) },
      };
    } else result = true;
    return Response.json({ ok: true, result });
  });
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  db.sqlite.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const send = (path: string, body?: unknown) =>
  handleRequest(
    ownerRequest(path, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
const publish = (operationId = crypto.randomUUID()) =>
  send(`/api/posts/${postId}/publish`, { operationId, revision: 1, channelId });
const sends = () =>
  transport.mock.calls.filter(([url]) =>
    String(url).endsWith("/sendRichMessage"),
  );
describe("rich publishing engine", () => {
  it("publishes valid snapshots, stores receipt/history, preserves the draft and deduplicates requests", async () => {
    const id = crypto.randomUUID(),
      response = await publish(id);
    expect(response.status).toBe(200);
    const p = ((await response.json()) as { publication: Publication })
      .publication;
    expect(p).toMatchObject({
      status: "published",
      telegram_message_id: 101,
      source_revision: 1,
    });
    expect(p.message_url).toBe("https://t.me/k9_test_channel/101");
    expect((await publish(id)).status).toBe(200);
    expect(sends()).toHaveLength(1);
    expect(
      db.sqlite.prepare("SELECT status FROM posts WHERE id=?").get(postId),
    ).toMatchObject({ status: "draft" });
    expect(
      db.sqlite
        .prepare("SELECT * FROM history WHERE action='publication.publish'")
        .all(),
    ).toHaveLength(1);
    expect((await publish()).status).toBe(409);
    expect(sends()).toHaveLength(1);
  });
  it("requires owner access, channel approval and valid complete content", async () => {
    expect(
      (
        await handleRequest(
          new Request(
            `https://studio.example.com/api/posts/${postId}/publish`,
            { method: "POST" },
          ),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRequest(
          ownerRequest(
            `/api/posts/${postId}/publish`,
            {
              method: "POST",
              body: JSON.stringify({
                operationId: crypto.randomUUID(),
                revision: 1,
                channelId,
              }),
            },
            signedInitData({ user: { id: 55, first_name: "Other" } }),
          ),
          env,
        )
      ).status,
    ).toBe(403);
    db.sqlite.prepare("UPDATE channels SET active=0 WHERE id=?").run(channelId);
    expect((await publish()).status).toBe(403);
    expect(sends()).toHaveLength(0);
    db.sqlite.prepare("UPDATE channels SET active=1 WHERE id=?").run(channelId);
    db.sqlite
      .prepare("UPDATE posts SET document_json=? WHERE id=?")
      .run(JSON.stringify({ version: 2, blocks: [] }), postId);
    expect((await publish()).status).toBe(422);
    expect(sends()).toHaveLength(0);
  });
  it("verifies media ownership and current getFile acceptance", async () => {
    const photo = createBlock("photo");
    if (photo.type !== "photo") throw Error();
    photo.media = { fileId: "AgAC_media_test", libraryId: null, name: "Photo" };
    db.sqlite
      .prepare("UPDATE posts SET document_json=? WHERE id=?")
      .run(JSON.stringify({ version: 2, blocks: [photo] }), postId);
    expect((await publish()).status).toBe(400);
    expect(sends()).toHaveLength(0);
    db.sqlite
      .prepare(
        "INSERT INTO media(id,telegram_file_id,file_unique_id,kind,owner_telegram_id,original_name,mime_type,size_bytes) VALUES(?,'AgAC_media_test','test_unique','photo',?,'Photo','image/jpeg',500)",
      )
      .run(crypto.randomUUID(), String(OWNER_ID));
    expect((await publish()).status).toBe(200);
    expect(
      transport.mock.calls.some(([url]) => String(url).endsWith("/getFile")),
    ).toBe(true);
  });
  it("sends clearly labelled private previews and makes callbacks inert", async () => {
    const buttons = createBlock("buttons");
    if (buttons.type !== "buttons") throw Error();
    buttons.buttons[0]!.action = {
      type: "callback",
      value: "dangerous_delete",
    };
    db.sqlite
      .prepare("UPDATE posts SET document_json=? WHERE id=?")
      .run(JSON.stringify({ version: 2, blocks: [buttons] }), postId);
    const response = await send(`/api/posts/${postId}/preview`, {
      operationId: crypto.randomUUID(),
      revision: 1,
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(String(sends()[0]?.[1]?.body));
    expect(body.chat_id).toBe(String(OWNER_ID));
    expect(body.rich_message.blocks[0].text[0]).toContain("TEST PREVIEW");
    expect(body.rich_message.blocks[1].buttons[0].callback_data).toBe(
      "k9:preview",
    );
  });
  it("edits confirmed messages, deletes only on confirmation, retains source/history", async () => {
    const p = ((await (await publish()).json()) as { publication: Publication })
      .publication;
    db.sqlite.prepare("UPDATE posts SET revision=2 WHERE id=?").run(postId);
    const edit = await send(`/api/publications/${p.id}/edit`, {
      operationId: crypto.randomUUID(),
      revision: p.revision,
      postId,
      postRevision: 2,
    });
    expect(edit.status).toBe(200);
    const updated = ((await edit.json()) as { publication: Publication })
      .publication;
    expect(updated.revision).toBe(p.revision + 1);
    const request = transport.mock.calls.find(([url]) =>
      String(url).endsWith("/editMessageText"),
    );
    expect(JSON.parse(String(request?.[1]?.body))).toHaveProperty(
      "rich_message",
    );
    const removed = await send(`/api/publications/${p.id}/delete`, {
      operationId: crypto.randomUUID(),
      revision: updated.revision,
    });
    expect(removed.status).toBe(200);
    expect(
      ((await removed.json()) as { publication: Publication }).publication
        .status,
    ).toBe("deleted");
    expect(
      db.sqlite.prepare("SELECT id FROM posts WHERE id=?").get(postId),
    ).toBeTruthy();
    expect(
      db.sqlite.prepare("SELECT * FROM history").all().length,
    ).toBeGreaterThanOrEqual(3);
  });
  it("prevents concurrent deliveries even with different operation IDs", async () => {
    const responses = await Promise.all([publish(), publish()]);
    expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(sends()).toHaveLength(1);
  });
  it("retains uncertain sends and requires explicit reconciliation rather than retry", async () => {
    behavior = "timeout";
    const id = crypto.randomUUID();
    const response = await publish(id);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "DELIVERY_UNCERTAIN" },
    });
    expect((await publish(id)).status).toBe(409);
    expect((await publish()).status).toBe(409);
    expect(sends()).toHaveLength(1);
    const p = db.sqlite
      .prepare("SELECT * FROM publications")
      .get() as unknown as Publication;
    expect(
      (
        await send(`/api/publications/${p.id}/reconcile`, {
          revision: p.revision,
          resolution: "delivered",
          confirmed: true,
          messageId: 101,
        })
      ).status,
    ).toBe(200);
    expect((await publish(id)).status).toBe(200);
    expect(sends()).toHaveLength(1);
  });
  it("keeps confirmed rate limits retryable with the same operation ID", async () => {
    vi.useFakeTimers();
    const id = crypto.randomUUID();
    behavior = "rate";
    expect((await publish(id)).status).toBe(429);
    expect((await publish(id)).status).toBe(429);
    vi.advanceTimersByTime(3000);
    behavior = "ok";
    expect((await publish(id)).status).toBe(200);
    expect(sends()).toHaveLength(2);
  });
  it("allows independent channels and explicit republishing, and blocks expired deletion", async () => {
    const p = ((await (await publish()).json()) as { publication: Publication })
      .publication;
    const second = crypto.randomUUID();
    db.sqlite
      .prepare(
        "INSERT INTO channels(id,telegram_chat_id,title,approved_by,approved_at) VALUES(?,'-10099999','Second',?,?)",
      )
      .run(second, String(OWNER_ID), new Date().toISOString());
    expect(
      (
        await send(`/api/posts/${postId}/publish`, {
          operationId: crypto.randomUUID(),
          revision: 1,
          channelId: second,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await send(`/api/publications/${p.id}/republish`, {
          operationId: crypto.randomUUID(),
          revision: p.revision,
          channelId,
        })
      ).status,
    ).toBe(200);
    db.sqlite
      .prepare("UPDATE publications SET published_at=? WHERE id=?")
      .run(new Date(Date.now() - 49 * 3600000).toISOString(), p.id);
    expect(
      (
        await send(`/api/publications/${p.id}/delete`, {
          operationId: crypto.randomUUID(),
          revision: p.revision,
        })
      ).status,
    ).toBe(400);
  });
});
describe("leased UTC scheduling", () => {
  async function schedule() {
    const response = await send(`/api/posts/${postId}/schedule`, {
      operationId: crypto.randomUUID(),
      revision: 1,
      channelId,
      runAt: new Date(Date.now() + 120000).toISOString(),
      timezone: "Asia/Yangon",
    });
    expect(response.status).toBe(201);
    return (
      (await response.json()) as { job: { id: string; revision: number } }
    ).job;
  }
  it("converts Yangon wall time, rejects invalid dates and publishes a frozen snapshot once", async () => {
    expect(localTimeToUTC("2026-10-14T12:00", "Asia/Yangon")).toBe(
      "2026-10-14T05:30:00.000Z",
    );
    expect(() => localTimeToUTC("2026-02-30T12:00", "UTC")).toThrow();
    const job = await schedule();
    db.sqlite
      .prepare("UPDATE scheduled_jobs SET run_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    db.sqlite
      .prepare("UPDATE posts SET title='Newer draft',revision=2 WHERE id=?")
      .run(postId);
    await Promise.all([runScheduler(env), runScheduler(env)]);
    expect(sends()).toHaveLength(1);
    expect(
      db.sqlite
        .prepare("SELECT status,delivery_state FROM scheduled_jobs WHERE id=?")
        .get(job.id),
    ).toMatchObject({ status: "succeeded", delivery_state: "delivered" });
    expect(
      db.sqlite.prepare("SELECT title,source_revision FROM publications").get(),
    ).toMatchObject({ title: "Test post", source_revision: 1 });
  });
  it("cancels pending work, blocks draft deletion until cancellation and handles revoked channels", async () => {
    const job = await schedule();
    const blocked = await handleRequest(
      ownerRequest(`/api/drafts/${postId}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: 1 }),
      }),
      env,
    );
    expect(blocked.status).toBe(409);
    expect(
      (
        await send(`/api/scheduled/${job.id}/cancel`, {
          operationId: crypto.randomUUID(),
          revision: job.revision,
        })
      ).status,
    ).toBe(200);
    db.sqlite
      .prepare("UPDATE scheduled_jobs SET run_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    await runScheduler(env);
    expect(sends()).toHaveLength(0);
    const other = await schedule();
    db.sqlite
      .prepare("UPDATE scheduled_jobs SET run_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), other.id);
    db.sqlite.prepare("UPDATE channels SET active=0 WHERE id=?").run(channelId);
    await runScheduler(env);
    expect(
      db.sqlite
        .prepare("SELECT status FROM scheduled_jobs WHERE id=?")
        .get(other.id),
    ).toMatchObject({ status: "failed" });
    expect(sends()).toHaveLength(0);
  });
  it("retries definite rate limits but never retries uncertain sends", async () => {
    vi.useFakeTimers();
    const job = await schedule();
    db.sqlite
      .prepare("UPDATE scheduled_jobs SET run_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    behavior = "rate";
    await runScheduler(env);
    expect(
      db.sqlite.prepare("SELECT status FROM scheduled_jobs").get(),
    ).toMatchObject({ status: "pending" });
    vi.advanceTimersByTime(61000);
    behavior = "timeout";
    await runScheduler(env);
    await runScheduler(env);
    expect(sends()).toHaveLength(2);
    expect(
      db.sqlite.prepare("SELECT delivery_state FROM scheduled_jobs").get(),
    ).toMatchObject({ delivery_state: "uncertain" });
  });
});

describe("delivery regression safeguards", () => {
  it("rechecks bot and owner administrator permissions before each send", async () => {
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, options) =>
      String(url).endsWith("/getChatMember")
        ? Response.json({ ok: true, result: { status: "member" } })
        : normal(url, options),
    );
    expect((await publish()).status).toBe(403);
    expect(sends()).toHaveLength(0);
  });
  it("keeps a publication when Telegram rejects deletion and rejects operation body changes", async () => {
    const id = crypto.randomUUID(),
      p = ((await (await publish(id)).json()) as { publication: Publication })
        .publication;
    expect(
      (
        await send(`/api/posts/${postId}/preview`, {
          operationId: id,
          revision: 1,
        })
      ).status,
    ).toBe(409);
    const normal = transport.getMockImplementation()!;
    transport.mockImplementation(async (url, options) =>
      String(url).endsWith("/deleteMessage")
        ? Response.json(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be deleted",
            },
            { status: 400 },
          )
        : normal(url, options),
    );
    expect(
      (
        await send(`/api/publications/${p.id}/delete`, {
          operationId: crypto.randomUUID(),
          revision: p.revision,
        })
      ).status,
    ).toBe(502);
    expect(
      db.sqlite
        .prepare(
          "SELECT status,telegram_message_id FROM publications WHERE id=?",
        )
        .get(p.id),
    ).toMatchObject({ status: "published", telegram_message_id: 101 });
    expect(
      db.sqlite
        .prepare("SELECT count(*) AS n FROM posts WHERE id=?")
        .get(postId),
    ).toMatchObject({ n: 1 });
  });
  it("marks a lost database completion uncertain, retains a known message ID, and never resends", async () => {
    const original = env.DB.batch.bind(env.DB);
    let first = true;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      // Fail only after the mocked external send has confirmed delivery.
      if (first && sends().length) {
        first = false;
        throw new Error("synthetic commit failure");
      }
      return original(statements);
    });
    const id = crypto.randomUUID();
    expect((await publish(id)).status).toBe(502);
    expect((await publish(id)).status).toBe(409);
    expect(sends()).toHaveLength(1);
    expect(
      db.sqlite
        .prepare("SELECT status,telegram_message_id FROM publications")
        .get(),
    ).toMatchObject({ status: "uncertain", telegram_message_id: 101 });
  });
  it("returns accepted schedule requests after source changes and time expiry", async () => {
    vi.useFakeTimers();
    const payload = {
      operationId: crypto.randomUUID(),
      revision: 1,
      channelId,
      runAt: new Date(Date.now() + 120000).toISOString(),
      timezone: "UTC",
    };
    expect((await send(`/api/posts/${postId}/schedule`, payload)).status).toBe(
      201,
    );
    db.sqlite.prepare("UPDATE posts SET revision=2 WHERE id=?").run(postId);
    vi.advanceTimersByTime(180000);
    expect((await send(`/api/posts/${postId}/schedule`, payload)).status).toBe(
      200,
    );
    expect(
      (
        await send(`/api/posts/${postId}/schedule`, {
          ...payload,
          channelId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM scheduled_jobs").get(),
    ).toMatchObject({ n: 1 });
  });
  it("recovers expired preparation leases but isolates expired sends for reconciliation", async () => {
    vi.useFakeTimers();
    const request = {
      operationId: crypto.randomUUID(),
      revision: 1,
      channelId,
      runAt: new Date(Date.now() + 120000).toISOString(),
      timezone: "UTC",
    };
    const job = (
      (await (await send(`/api/posts/${postId}/schedule`, request)).json()) as {
        job: { id: string };
      }
    ).job;
    vi.advanceTimersByTime(121000);
    behavior = "rate";
    await runScheduler(env);
    db.sqlite
      .prepare(
        "UPDATE scheduled_jobs SET status='running',delivery_state='sending',lease_until=?,lease_token='crashed' WHERE id=?",
      )
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    db.sqlite
      .prepare(
        "UPDATE publishing_operations SET status='sending',lease_until=0",
      )
      .run();
    db.sqlite
      .prepare(
        "UPDATE publications SET status='sending',active_operation_id=operation_id",
      )
      .run();
    await runScheduler(env);
    await runScheduler(env);
    expect(sends()).toHaveLength(1);
    expect(
      db.sqlite
        .prepare("SELECT delivery_state,status FROM scheduled_jobs")
        .get(),
    ).toMatchObject({ delivery_state: "uncertain", status: "failed" });
    expect(
      db.sqlite.prepare("SELECT status FROM publications").get(),
    ).toMatchObject({ status: "uncertain" });
  });
});

describe("uncertain-copy and preparation crash regressions", () => {
  it("blocks fresh preview IDs while an earlier private delivery is uncertain", async () => {
    behavior = "timeout";
    expect(
      (
        await send(`/api/posts/${postId}/preview`, {
          operationId: crypto.randomUUID(),
          revision: 1,
        })
      ).status,
    ).toBe(502);
    behavior = "ok";
    expect(
      (
        await send(`/api/posts/${postId}/preview`, {
          operationId: crypto.randomUUID(),
          revision: 1,
        })
      ).status,
    ).toBe(409);
    expect(sends()).toHaveLength(1);
  });
  it("keeps failed delivery timestamps empty and records reconciliation only once", async () => {
    behavior = "timeout";
    await publish();
    const p = db.sqlite
      .prepare("SELECT * FROM publications")
      .get() as unknown as Publication;
    const body = {
      revision: p.revision,
      resolution: "not_delivered",
      confirmed: true,
    };
    expect(
      (await send(`/api/publications/${p.id}/reconcile`, body)).status,
    ).toBe(200);
    expect(
      (await send(`/api/publications/${p.id}/reconcile`, body)).status,
    ).toBe(409);
    expect(
      db.sqlite
        .prepare(
          "SELECT status,published_at,telegram_message_id FROM publications",
        )
        .get(),
    ).toMatchObject({
      status: "failed",
      published_at: null,
      telegram_message_id: null,
    });
    expect(
      db.sqlite
        .prepare(
          "SELECT count(*) AS n FROM history WHERE action='publication.reconciled'",
        )
        .get(),
    ).toMatchObject({ n: 1 });
  });
  it("reclaims a crashed job gate only when the operation proves sending never started", async () => {
    vi.useFakeTimers();
    const request = {
      operationId: crypto.randomUUID(),
      revision: 1,
      channelId,
      runAt: new Date(Date.now() + 120000).toISOString(),
      timezone: "UTC",
    };
    const job = (
      (await (await send(`/api/posts/${postId}/schedule`, request)).json()) as {
        job: { id: string };
      }
    ).job;
    vi.advanceTimersByTime(121000);
    behavior = "rate";
    await runScheduler(env);
    vi.advanceTimersByTime(181000);
    db.sqlite
      .prepare(
        "UPDATE scheduled_jobs SET status='running',delivery_state='sending',lease_until=?,lease_token='preparation-crash' WHERE id=?",
      )
      .run(new Date(Date.now() - 1000).toISOString(), job.id);
    db.sqlite
      .prepare(
        "UPDATE publishing_operations SET status='preparing',lease_until=0",
      )
      .run();
    db.sqlite
      .prepare(
        "UPDATE publications SET status='preparing',active_operation_id=operation_id",
      )
      .run();
    behavior = "ok";
    await runScheduler(env);
    expect(sends()).toHaveLength(2);
    expect(
      db.sqlite
        .prepare("SELECT status,delivery_state FROM scheduled_jobs")
        .get(),
    ).toMatchObject({ status: "succeeded", delivery_state: "delivered" });
  });
});
it("fails closed before delivery when the uncertainty-lock migration is missing", async () => {
  db.sqlite.exec(
    "DROP INDEX publications_active_source; CREATE UNIQUE INDEX publications_active_source ON publications(origin_post_id,source_revision,coalesce(channel_id,''),kind) WHERE status IN ('preparing','sending')",
  );
  expect((await publish()).status).toBe(503);
  expect((await send("/api/doctor")).status).toBe(503);
  expect(sends()).toHaveLength(0);
});
