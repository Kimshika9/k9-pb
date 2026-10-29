import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createDatabase, testEnv } from "./helpers";
import type { Env } from "../worker/env";
import { handleRequest } from "../worker";
const SECRET = "test_only_scoped_cli_secret_32_plus_characters";
let db: ReturnType<typeof createDatabase>, env: Env;
beforeEach(() => {
  db = createDatabase();
  env = {
    ...testEnv(db.db),
    CLI_AUTH_SECRET: SECRET,
    CLI_ALLOWED_ACTIONS: "read,preview,publish",
  };
});
afterEach(() => {
  db.sqlite.close();
  vi.unstubAllGlobals();
});
function signed(
  path = "/api/cli/status",
  body?: unknown,
  options: {
    nonce?: string;
    timestamp?: number;
    secret?: string;
    method?: string;
  } = {},
) {
  const method = options.method ?? (body === undefined ? "GET" : "POST"),
    data = body === undefined ? "" : JSON.stringify(body),
    timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    nonce = options.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const check = [
    timestamp,
    nonce,
    method,
    path,
    createHash("sha256").update(data).digest("hex"),
  ].join("\n");
  const headers = {
    "X-K9-Timestamp": timestamp,
    "X-K9-Nonce": nonce,
    "X-K9-Signature": createHmac("sha256", options.secret ?? SECRET)
      .update(check)
      .digest("hex"),
    "Content-Type": "application/json",
  };
  return new Request("https://studio.example.com" + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: data }),
  });
}
describe("scoped Python/Worker signatures", () => {
  it("accepts an independently generated Python signature and returns private status", async () => {
    const path = "/api/cli/status",
      stamp = Math.floor(Date.now() / 1000),
      nonce = "a".repeat(32);
    const headers = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          `import bot,json; print(json.dumps(bot.signed_headers(${JSON.stringify(SECRET)},'GET',${JSON.stringify(path)},b'',${stamp},${JSON.stringify(nonce)})))`,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      ),
    ) as Record<string, string>;
    const response = await handleRequest(
      new Request("https://studio.example.com" + path, { headers }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "K9 Post Studio",
      schema: 4,
    });
  });
  it("rejects replay, stale clocks, tampered method/path/body and invalid signatures", async () => {
    const nonce = "b".repeat(32);
    expect(
      (
        await handleRequest(
          signed("/api/cli/status", undefined, { nonce }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleRequest(
          signed("/api/cli/status", undefined, { nonce }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRequest(
          signed("/api/cli/status", undefined, {
            timestamp: Math.floor(Date.now() / 1000) - 61,
          }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRequest(
          signed("/api/cli/status", undefined, { secret: "wrong" }),
          env,
        )
      ).status,
    ).toBe(401);
    const r = signed();
    expect(
      (
        await handleRequest(
          new Request("https://studio.example.com/api/cli/channels", {
            headers: r.headers,
          }),
          env,
        )
      ).status,
    ).toBe(401);
    const post = signed("/api/cli/posts/test/preview", { revision: 1 });
    expect(
      (
        await handleRequest(
          new Request(post.url, {
            method: "POST",
            headers: post.headers,
            body: '{"revision":2}',
          }),
          env,
        )
      ).status,
    ).toBe(401);
  });
  it("defaults to read-only and never authenticates ordinary Mini App routes with a CLI signature", async () => {
    env.CLI_ALLOWED_ACTIONS = "read";
    expect(
      (
        await handleRequest(
          signed("/api/cli/posts/test/preview", {
            operationId: crypto.randomUUID(),
            revision: 1,
          }),
          env,
        )
      ).status,
    ).toBe(403);
    const r = signed("/api/profile");
    expect((await handleRequest(r, env)).status).toBe(401);
    expect(
      (await handleRequest(signed("/api/cli/channels", {}), env)).status,
    ).toBe(403);
  });
  it("rejects missing or placeholder secrets and does not disclose them", async () => {
    env.CLI_AUTH_SECRET = "replace_with_random_64_character_hex_secret";
    const response = await handleRequest(signed(), env);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("replace_with");
  });
  it("still rejects unapproved channel publication and malformed actions after valid CLI auth", async () => {
    const postId = crypto.randomUUID();
    db.sqlite
      .prepare(
        "INSERT INTO posts(id,title,document_json,owner_telegram_id) VALUES(?,'CLI draft',?,?)",
      )
      .run(
        postId,
        JSON.stringify({
          version: 2,
          blocks: [
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              text: [{ text: "CLI", marks: [] }],
            },
          ],
        }),
        env.OWNER_TELEGRAM_ID,
      );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await handleRequest(
      signed(`/api/cli/posts/${postId}/publish`, {
        operationId: crypto.randomUUID(),
        revision: 1,
        channelId: crypto.randomUUID(),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (
        await handleRequest(
          signed(`/api/cli/posts/${postId}/publish`, {
            operationId: crypto.randomUUID(),
            revision: 1,
            channelId: "@arbitrary_chat",
          }),
          env,
        )
      ).status,
    ).toBe(400);
  });
});
