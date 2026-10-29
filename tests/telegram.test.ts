import { describe, expect, it, vi } from "vitest";
import { TelegramClient } from "../worker/lib/telegram";
describe("Telegram HTTP client", () => {
  it("uses POST JSON with a timeout and parses the Bot API envelope", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ ok: true, result: { id: 42, username: "studio_bot" } }),
      );
    expect(await new TelegramClient("test-token", transport).getMe()).toEqual({
      id: 42,
      username: "studio_bot",
    });
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
      signal: expect.any(AbortSignal),
    });
  });
  it.each([
    Response.json(
      { ok: false, description: "sensitive bot token here" },
      { status: 400 },
    ),
    new Response("not-json", { status: 502 }),
    Response.json({ ok: true }),
    Response.json(null),
    Response.json([]),
    Response.json({ ok: true, result: null }),
  ])("sanitizes invalid upstream responses", async (response) => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      new TelegramClient("test-token", transport).getMe(),
    ).rejects.toMatchObject({ status: 502 });
  });
});
