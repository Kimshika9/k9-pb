import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../worker/index";
import { requireApprovedChannel } from "../worker/lib/channels";
import {
  createDatabase,
  OWNER_ID,
  ownerRequest,
  signedInitData,
  testEnv,
} from "./helpers";
import type { Env } from "../worker/env";

let database: ReturnType<typeof createDatabase>;
let env: Env;
beforeEach(() => {
  database = createDatabase();
  env = testEnv(database.db);
});
afterEach(() => {
  database.sqlite.close();
  vi.unstubAllGlobals();
});
function mockTelegram(
  options: { botCanPost?: boolean; ownerAdmin?: boolean; type?: string } = {},
) {
  const mock = vi.fn(
    async (url: string | URL | Request, optionsArg?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      const body = JSON.parse(String(optionsArg?.body ?? "{}")) as {
        user_id?: number;
      };
      let result: unknown;
      if (method === "getChat")
        result = {
          id: -1001234567890,
          type: options.type ?? "channel",
          title: "K9 Updates",
          username: "k9_updates",
        };
      else if (method === "getMe")
        result = { id: 777, username: "k9_test_bot" };
      else if (method === "getChatMember")
        result =
          body.user_id === OWNER_ID
            ? { status: options.ownerAdmin === false ? "member" : "creator" }
            : {
                status: "administrator",
                can_post_messages: options.botCanPost !== false,
              };
      else result = { message_id: 1 };
      return Response.json({ ok: true, result });
    },
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function connect() {
  const response = await handleRequest(
    ownerRequest("/api/channels", {
      method: "POST",
      body: JSON.stringify({ chatId: "@k9_updates", approved: true }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { channel: { id: string } }).channel.id;
}

describe("private APIs", () => {
  it.each(["/api/profile", "/api/channels", "/api/dashboard", "/api/unknown"])(
    "requires authentication on %s",
    async (path) => {
      expect(
        (
          await handleRequest(
            new Request(`https://studio.example.com${path}`),
            env,
          )
        ).status,
      ).toBe(401);
    },
  );
  it.each(["/api/profile", "/api/channels", "/api/dashboard"])(
    "denies a signed non-owner on %s",
    async (path) => {
      expect(
        (
          await handleRequest(
            ownerRequest(
              path,
              {},
              signedInitData({ user: { id: 9, first_name: "Guest" } }),
            ),
            env,
          )
        ).status,
      ).toBe(403);
    },
  );
  it("returns only authenticated owner profile with no caching", async () => {
    const response = await handleRequest(ownerRequest("/api/profile"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      user: { id: OWNER_ID, first_name: "Studio", username: "studio_owner" },
      role: "owner",
    });
  });
  it("returns an empty dashboard from real SQL tables", async () => {
    const response = await handleRequest(ownerRequest("/api/dashboard"), env);
    expect(await response.json()).toEqual({
      counts: { drafts: 0, scheduled: 0, published: 0, channels: 0 },
      recentPosts: [],
      channels: [],
    });
  });
  it("returns real draft counts and joined channel titles", async () => {
    mockTelegram();
    const id = await connect();
    database.sqlite
      .prepare(
        "INSERT INTO posts (id, channel_id, title) VALUES ('post-1', ?, 'A new chapter')",
      )
      .run(id);
    const body = (await (
      await handleRequest(ownerRequest("/api/dashboard"), env)
    ).json()) as {
      counts: { drafts: number; channels: number };
      recentPosts: unknown[];
    };
    expect(body.counts).toMatchObject({ drafts: 1, channels: 1 });
    expect(body.recentPosts).toMatchObject([
      { title: "A new chapter", channel_title: "K9 Updates" },
    ]);
  });
  it("approves, lists, and revokes a channel with a transactional audit trail", async () => {
    const telegram = mockTelegram();
    const id = await connect();
    expect(telegram).toHaveBeenCalledTimes(4);
    expect(await requireApprovedChannel(env, id)).toMatchObject({
      active: 1,
      title: "K9 Updates",
    });
    const list = (await (
      await handleRequest(ownerRequest("/api/channels"), env)
    ).json()) as { channels: unknown[] };
    expect(list.channels).toHaveLength(1);
    const response = await handleRequest(
      ownerRequest(`/api/channels/${id}`, { method: "DELETE" }),
      env,
    );
    expect(response.status).toBe(200);
    await expect(requireApprovedChannel(env, id)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      database.sqlite
        .prepare("SELECT action FROM history ORDER BY rowid")
        .all(),
    ).toEqual([{ action: "channel.approved" }, { action: "channel.revoked" }]);
  });
  it("reconnecting a channel preserves its ID", async () => {
    mockTelegram();
    const id = await connect();
    expect(await connect()).toBe(id);
  });
  it("requires explicit owner approval before Telegram calls", async () => {
    const mock = mockTelegram();
    const response = await handleRequest(
      ownerRequest("/api/channels", {
        method: "POST",
        body: JSON.stringify({ chatId: "@k9_updates", approved: false }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([
    { botCanPost: false },
    { ownerAdmin: false },
    { type: "supergroup" },
  ])("rejects invalid channel permissions %j", async (options) => {
    mockTelegram(options);
    const response = await handleRequest(
      ownerRequest("/api/channels", {
        method: "POST",
        body: JSON.stringify({ chatId: "@k9_updates", approved: true }),
      }),
      env,
    );
    expect([400, 403]).toContain(response.status);
    expect(
      database.sqlite.prepare("SELECT * FROM channels").all(),
    ).toHaveLength(0);
  });
  it("rejects cross-origin mutations", async () => {
    const mock = mockTelegram();
    expect(
      (
        await handleRequest(
          ownerRequest("/api/channels", {
            method: "POST",
            headers: { Origin: "https://evil.example" },
            body: "{}",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(mock).not.toHaveBeenCalled();
  });
  it("rejects malformed, oversized, and wrong-content-type bodies", async () => {
    expect(
      (
        await handleRequest(
          ownerRequest("/api/channels", { method: "POST", body: "{broken" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleRequest(
          ownerRequest("/api/channels", {
            method: "POST",
            body: JSON.stringify({ text: "x".repeat(66000) }),
          }),
          env,
        )
      ).status,
    ).toBe(413);
    const request = ownerRequest("/api/channels", {
      method: "POST",
      body: "{}",
    });
    request.headers.set("Content-Type", "text/plain");
    expect((await handleRequest(request, env)).status).toBe(415);
  });
  it("returns 404 for missing channels, and no unimplemented publishing endpoint", async () => {
    expect(
      (
        await handleRequest(
          ownerRequest("/api/channels/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
            method: "DELETE",
          }),
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleRequest(
          ownerRequest("/api/publish", { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(404);
  });
  it("does not expose internal SQL errors", async () => {
    database.sqlite.exec("DROP TABLE posts");
    const response = await handleRequest(ownerRequest("/api/dashboard"), env);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("posts");
  });
});

describe("migration constraints", () => {
  it("creates all requested tables", () => {
    const names = database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "posts",
        "channels",
        "templates",
        "media",
        "history",
        "scheduled_jobs",
        "webhook_updates",
      ]),
    );
  });
  it("blocks publishing or scheduling to an unapproved destination", () => {
    expect(() =>
      database.sqlite
        .prepare(
          "INSERT INTO posts (id,title,status) VALUES ('p','Test','published')",
        )
        .run(),
    ).toThrow("Channel is not approved");
    database.sqlite.exec("INSERT INTO posts (id,title) VALUES ('p','Test')");
    expect(() =>
      database.sqlite.exec("UPDATE posts SET status='scheduled' WHERE id='p'"),
    ).toThrow("Channel is not approved");
    expect(() =>
      database.sqlite.exec(
        "INSERT INTO scheduled_jobs (id,post_id,run_at) VALUES ('j','p','2026-12-01')",
      ),
    ).toThrow("Channel is not approved");
  });
  it("revocation cancels pending jobs and unschedules posts", async () => {
    mockTelegram();
    const id = await connect();
    database.sqlite
      .prepare(
        "INSERT INTO posts (id,title,channel_id,status) VALUES ('p','Test',?,'scheduled')",
      )
      .run(id);
    database.sqlite.exec(
      "INSERT INTO scheduled_jobs (id,post_id,run_at) VALUES ('j','p','2026-12-01')",
    );
    expect(
      (
        await handleRequest(
          ownerRequest(`/api/channels/${id}`, { method: "DELETE" }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      database.sqlite
        .prepare("SELECT status FROM scheduled_jobs WHERE id='j'")
        .get(),
    ).toEqual({ status: "cancelled" });
    expect(
      database.sqlite.prepare("SELECT status FROM posts WHERE id='p'").get(),
    ).toEqual({ status: "draft" });
  });
});
