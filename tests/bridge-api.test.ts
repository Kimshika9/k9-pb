import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { createDatabase, testEnv, OWNER_ID, ownerRequest } from "./helpers";
import { handleRequest } from "../worker";
import type { Env } from "../worker/env";
const SECRET = "synthetic_separate_bridge_secret_32_plus_characters";
let db: ReturnType<typeof createDatabase>, env: Env;
beforeEach(() => {
  db = createDatabase();
  env = {
    ...testEnv(db.db),
    K9_BRIDGE_SECRET: SECRET,
    K9_BRIDGE_ALLOWED_ACTIONS:
      "read,preview,publish,schedule,cancel,media,create,runtime",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, options) => {
      const method = String(url).split("/").at(-1),
        body = JSON.parse(String(options?.body ?? "{}")) as Record<
          string,
          unknown
        >;
      const result =
        method === "getMe"
          ? { id: 777, is_bot: true, username: "synthetic_bot" }
          : method === "getChat"
            ? { id: Number(body.chat_id), type: "channel", title: "Synthetic" }
            : method === "getChatMember"
              ? body.user_id === OWNER_ID
                ? { status: "creator" }
                : { status: "administrator", can_post_messages: true }
              : method === "getFile"
                ? {
                    file_id: body.file_id,
                    file_unique_id: "synthetic_unique",
                    file_size: 500,
                  }
                : method === "sendRichMessage"
                  ? {
                      message_id: 44,
                      date: Math.floor(Date.now() / 1000),
                      chat: { id: Number(body.chat_id) },
                    }
                  : true;
      return Response.json({ ok: true, result });
    }),
  );
});
afterEach(() => {
  db.sqlite.close();
  vi.unstubAllGlobals();
});
function signed(
  path: string,
  body?: unknown,
  options: {
    secret?: string;
    nonce?: string;
    age?: number;
    prefix?: string;
  } = {},
) {
  const full = (options.prefix ?? "/api/bridge") + path,
    method = body === undefined ? "GET" : "POST",
    raw = body === undefined ? "" : JSON.stringify(body),
    stamp = String(Math.floor(Date.now() / 1000) - (options.age ?? 0)),
    nonce = options.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const hash = createHash("sha256").update(raw).digest("hex"),
    signature = createHmac("sha256", options.secret ?? SECRET)
      .update([stamp, nonce, method, full, hash].join("\n"))
      .digest("hex");
  return new Request("https://studio.example.com" + full, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-K9-Timestamp": stamp,
      "X-K9-Nonce": nonce,
      "X-K9-Signature": signature,
    },
    ...(body === undefined ? {} : { body: raw }),
  });
}
const call = (path: string, body?: unknown) =>
  handleRequest(signed(path, body), env);
it("keeps bridge, CLI and browser credentials separate, rejects expiry/tampering/replay", async () => {
  env.CLI_AUTH_SECRET = "synthetic_legacy_cli_secret_32_plus_characters";
  expect(
    (
      await handleRequest(
        signed("/status", undefined, { prefix: "/api/cli" }),
        env,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await handleRequest(
        new Request("https://studio.example.com/api/status", {
          headers: signed("/status").headers,
        }),
        env,
      )
    ).status,
  ).toBe(401);
  expect(
    (await handleRequest(signed("/status", undefined, { age: 61 }), env))
      .status,
  ).toBe(401);
  expect(
    (
      await handleRequest(
        signed("/status", undefined, { secret: "invalid" }),
        env,
      )
    ).status,
  ).toBe(401);
  const r = signed("/status");
  expect(
    (
      await handleRequest(
        new Request("https://studio.example.com/api/bridge/channels", {
          headers: r.headers,
        }),
        env,
      )
    ).status,
  ).toBe(401);
  const nonce = "a".repeat(32);
  expect(
    (await handleRequest(signed("/status", undefined, { nonce }), env)).status,
  ).toBe(200);
  expect(
    (await handleRequest(signed("/status", undefined, { nonce }), env)).status,
  ).toBe(401);
  expect(await (await call("/identity")).json()).toMatchObject({
    botId: 777,
    ownerId: OWNER_ID,
    webAppUrl: "https://studio.example.com/",
  });
});
it("limits scopes to necessary bot routes and defaults read-only", async () => {
  expect(
    (await call("/channels", { chatId: "-1001", approved: true })).status,
  ).toBe(403);
  expect(
    (await call("/publications/unknown/delete", { revision: 1 })).status,
  ).toBe(403);
  expect((await call("/templates", {})).status).toBe(403);
  delete env.K9_BRIDGE_ALLOWED_ACTIONS;
  // Preflight is read-only, so schedule-only operators do not need publish power.
  expect(
    (
      await call("/posts/missing/check", {
        revision: 1,
        channelId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call("/runtime", {
        mode: "transition",
        revision: 0,
        confirmed: true,
      })
    ).status,
  ).toBe(403);
  expect((await call("/media/register", {})).status).toBe(403);
});
it("shares drafts, templates, media and publication snapshots with the Mini App", async () => {
  const id = crypto.randomUUID(),
    channel = crypto.randomUUID();
  const created = await call("/drafts", {
    title: "From Python",
    document: {
      version: 2,
      blocks: [
        {
          id,
          type: "paragraph",
          text: [{ text: "မြန်မာ shared draft", marks: [] }],
        },
      ],
    },
  });
  expect(created.status).toBe(201);
  const p = (
    (await created.json()) as { draft: { id: string; revision: number } }
  ).draft;
  expect(
    (await handleRequest(ownerRequest("/api/drafts/" + p.id), env)).status,
  ).toBe(200);
  expect((await call("/templates")).status).toBe(200);
  db.sqlite
    .prepare(
      "INSERT INTO channels(id,telegram_chat_id,title,approved_by,approved_at) VALUES(?,'-1001234567890','Synthetic',?,?)",
    )
    .run(channel, String(OWNER_ID), new Date().toISOString());
  expect(
    (
      await call(`/posts/${p.id}/check`, {
        revision: p.revision,
        channelId: channel,
      })
    ).status,
  ).toBe(200);
  const op = crypto.randomUUID(),
    payload = { operationId: op, revision: p.revision, channelId: channel };
  expect((await call(`/posts/${p.id}/publish`, payload)).status).toBe(200);
  expect((await call(`/posts/${p.id}/publish`, payload)).status).toBe(200);
  const pubs = await handleRequest(ownerRequest("/api/publications"), env);
  expect(await pubs.json()).toMatchObject({
    publications: [{ telegram_message_id: 44, title: "From Python" }],
  });
  expect(
    (
      await call(`/posts/${p.id}/publish`, {
        ...payload,
        operationId: crypto.randomUUID(),
        channelId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  const media = await call("/media/register", {
    fileId: "AgAC_synthetic_python_photo_12345",
    uniqueId: "synthetic_unique",
    kind: "photo",
    name: "Shared photo",
    width: 640,
    height: 480,
  });
  expect(media.status).toBe(201);
  const library = await handleRequest(ownerRequest("/api/media"), env);
  expect(await library.json()).toMatchObject({
    media: [{ kind: "photo", width: 640, height: 480 }],
  });
  expect(
    (
      await call("/media/register", {
        fileId: "AgAC_synthetic_other_photo_12345",
        uniqueId: "forged_unique",
        kind: "photo",
        name: "Bad",
      })
    ).status,
  ).toBe(422);
});
it("fences webhook receivers, requires transitions and excludes simultaneous Python leases", async () => {
  expect(await (await call("/runtime")).json()).toMatchObject({
    runtime: { mode: "cloudflare", revision: 0 },
  });
  expect(
    (await call("/runtime", { mode: "python", revision: 0, confirmed: true }))
      .status,
  ).toBe(409);
  expect(
    (
      await call("/runtime", {
        mode: "transition",
        revision: 0,
        confirmed: false,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("/runtime", {
        mode: "transition",
        revision: 0,
        confirmed: true,
      })
    ).status,
  ).toBe(200);
  const hook = () =>
    new Request("https://studio.example.com/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 123,
        message: {
          text: "/start",
          from: { id: OWNER_ID },
          chat: { id: OWNER_ID, type: "private" },
        },
      }),
    });
  expect((await handleRequest(hook(), env)).status).toBe(503);
  expect(
    (await call("/runtime", { mode: "python", revision: 1, confirmed: true }))
      .status,
  ).toBe(200);
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  expect(
    (await call("/runtime/lease", { instanceId: first, action: "claim" }))
      .status,
  ).toBe(200);
  expect(
    (await call("/runtime/lease", { instanceId: second, action: "claim" }))
      .status,
  ).toBe(409);
  expect(
    (
      await call("/runtime", {
        mode: "transition",
        revision: 2,
        confirmed: true,
      })
    ).status,
  ).toBe(409);
  expect(
    (await call("/runtime/lease", { instanceId: first, action: "heartbeat" }))
      .status,
  ).toBe(200);
  expect(
    (await call("/runtime/lease", { instanceId: first, action: "release" }))
      .status,
  ).toBe(200);
  expect(
    (
      await call("/runtime", {
        mode: "transition",
        revision: 2,
        confirmed: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("/runtime", {
        mode: "cloudflare",
        revision: 3,
        confirmed: true,
      })
    ).status,
  ).toBe(200);
  expect((await handleRequest(hook(), env)).status).toBe(200);
});
it("enforces durable rate limits and fails closed if bridge migration is missing", async () => {
  db.sqlite
    .prepare("INSERT INTO bridge_rate_limits(id,window,count) VALUES(?,?,120)")
    .run(String(OWNER_ID) + ":read", Math.floor(Date.now() / 60000));
  expect((await call("/status")).status).toBe(429);
  db.sqlite.exec("DROP TABLE bridge_rate_limits");
  expect((await call("/status")).status).toBe(503);
});
it("reclaims expired receiver leases while refusing stale heartbeats and owner mismatches", async () => {
  await call("/runtime", { mode: "transition", revision: 0, confirmed: true });
  await call("/runtime", { mode: "python", revision: 1, confirmed: true });
  const old = crypto.randomUUID(),
    fresh = crypto.randomUUID();
  await call("/runtime/lease", { instanceId: old, action: "claim" });
  db.sqlite
    .prepare("UPDATE bot_runtime SET lease_until=0 WHERE id='receiver'")
    .run();
  expect(
    (await call("/runtime/lease", { instanceId: fresh, action: "claim" }))
      .status,
  ).toBe(200);
  expect(
    (await call("/runtime/lease", { instanceId: old, action: "heartbeat" }))
      .status,
  ).toBe(409);
  expect(
    (await call("/runtime/lease", { instanceId: old, action: "release" }))
      .status,
  ).toBe(409);
  db.sqlite
    .prepare(
      "UPDATE bot_runtime SET owner_telegram_id='111111111' WHERE id='receiver'",
    )
    .run();
  expect((await call("/runtime")).status).toBe(403);
});
it("reports exactly the effective bridge permissions privately for startup checks", async () => {
  env.K9_BRIDGE_ALLOWED_ACTIONS = " read, preview ,runtime,runtime,unknown ";
  const response = await call("/identity");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ bridgeActions: ["read", "preview", "runtime"] });
  expect(JSON.stringify(body)).not.toContain(SECRET);
  expect(
    (
      await handleRequest(
        new Request("https://studio.example.com/api/bridge/identity"),
        env,
      )
    ).status,
  ).toBe(401);
});
