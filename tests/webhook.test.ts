import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../worker/index";
import { createDatabase, OWNER_ID, testEnv } from "./helpers";
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
function updateRequest(
  options: {
    secret?: string;
    userId?: number;
    chatId?: number;
    chatType?: string;
    text?: string;
    id?: number;
  } = {},
) {
  return new Request("https://studio.example.com/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token":
        options.secret ?? env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      update_id: options.id ?? 1,
      message: {
        from: { id: options.userId ?? OWNER_ID },
        chat: {
          id: options.chatId ?? OWNER_ID,
          type: options.chatType ?? "private",
        },
        text: options.text ?? "/start",
      },
    }),
  });
}
describe("secure Telegram webhook", () => {
  it("requires POST", async () => {
    expect(
      (
        await handleRequest(
          new Request("https://studio.example.com/telegram/webhook"),
          env,
        )
      ).status,
    ).toBe(405);
  });
  it.each(["", "wrong-secret"])(
    "rejects invalid secret %s before calling Telegram",
    async (secret) => {
      const mock = vi.fn();
      vi.stubGlobal("fetch", mock);
      expect((await handleRequest(updateRequest({ secret }), env)).status).toBe(
        401,
      );
      expect(mock).not.toHaveBeenCalled();
    },
  );
  it.each([
    { userId: 1 },
    { chatType: "group" },
    { chatId: -1001 },
    { text: "/help" },
    { text: "/starting" },
  ])("ignores unauthorized or irrelevant commands %j", async (options) => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    expect((await handleRequest(updateRequest(options), env)).status).toBe(200);
    expect(mock).not.toHaveBeenCalled();
  });
  it("sends the owner launch button and deduplicates completed updates", async () => {
    const mock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, result: { message_id: 99 } }),
      );
    vi.stubGlobal("fetch", mock);
    expect(
      (
        await handleRequest(
          updateRequest({ text: "/start@k9_bot welcome" }),
          env,
        )
      ).status,
    ).toBe(200);
    expect((await handleRequest(updateRequest(), env)).status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(mock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(payload).toMatchObject({
      chat_id: OWNER_ID,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Open K9 Post Studio",
              web_app: { url: env.MINI_APP_URL + "/" },
            },
          ],
        ],
      },
    });
  });
  it("fails a delivery safely and permits a retry", async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret-containing transport error"))
      .mockResolvedValueOnce(
        Response.json({ ok: true, result: { message_id: 99 } }),
      );
    vi.stubGlobal("fetch", mock);
    const response = await handleRequest(updateRequest(), env);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret-containing",
    );
    expect((await handleRequest(updateRequest(), env)).status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("returns retryable 503 when an update is already in flight", async () => {
    database.sqlite
      .prepare(
        "INSERT INTO webhook_updates (update_id,status,lease_until) VALUES (1,'processing',?)",
      )
      .run(Math.floor(Date.now() / 1000) + 30);
    expect((await handleRequest(updateRequest(), env)).status).toBe(503);
  });
  it("reclaims expired processing leases", async () => {
    const mock = vi.fn(async () => Response.json({ ok: true, result: {} }));
    vi.stubGlobal("fetch", mock);
    database.sqlite.exec(
      "INSERT INTO webhook_updates (update_id,status,lease_until) VALUES (1,'processing',1)",
    );
    expect((await handleRequest(updateRequest(), env)).status).toBe(200);
    expect(mock).toHaveBeenCalledOnce();
  });
  it("fails closed with missing webhook configuration or insecure launch URL", async () => {
    expect(
      (
        await handleRequest(updateRequest(), {
          ...env,
          TELEGRAM_WEBHOOK_SECRET: "",
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleRequest(updateRequest(), {
          ...env,
          MINI_APP_URL: "http://unsafe.example",
        })
      ).status,
    ).toBe(503);
  });
  it("rejects malformed Telegram updates", async () => {
    const request = new Request("https://studio.example.com/telegram/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: '{"update_id":"bad"}',
    });
    expect((await handleRequest(request, env)).status).toBe(400);
  });
});
