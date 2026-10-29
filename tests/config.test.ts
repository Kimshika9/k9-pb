import { describe, expect, it } from "vitest";
import { requireAuthConfig } from "../worker/lib/auth";
import { requireMiniAppUrl, requireWebhookSecret } from "../worker/lib/config";
import { handleRequest } from "../worker/index";
import { ownerRequest, testEnv } from "./helpers";
import type { Env } from "../worker/env";

describe("runtime configuration fails closed", () => {
  it.each([
    "",
    "replace_with_botfather_token",
    " token ",
    "123:short",
    "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL\n",
  ])("rejects invalid bot configuration %s", (value) => {
    expect(() =>
      requireAuthConfig({ ...testEnv(), TELEGRAM_BOT_TOKEN: value }),
    ).toThrow(expect.objectContaining({ status: 503, code: "NOT_CONFIGURED" }));
  });
  it.each([
    "",
    "0",
    "-1",
    "00123456789",
    "123456789 ",
    "1e8",
    "9007199254740992",
    "replace_with_your_numeric_telegram_user_id",
  ])("rejects invalid owner configuration %s", (value) => {
    expect(() =>
      requireAuthConfig({ ...testEnv(), OWNER_TELEGRAM_ID: value }),
    ).toThrow(expect.objectContaining({ status: 503 }));
  });
  it("accepts the configured owner without requiring optional webhook operation settings", () => {
    expect(() =>
      requireAuthConfig({
        ...testEnv(),
        MINI_APP_URL: "",
        TELEGRAM_WEBHOOK_SECRET: "",
      }),
    ).not.toThrow();
  });
  it.each([
    "",
    "x".repeat(31),
    "x".repeat(257),
    " ".repeat(32),
    "a!".repeat(16),
  ])("rejects unsupported webhook secrets", (value) => {
    expect(() =>
      requireWebhookSecret({ ...testEnv(), TELEGRAM_WEBHOOK_SECRET: value }),
    ).toThrow(expect.objectContaining({ status: 503 }));
  });
  it.each([
    "",
    "http://studio.example.com",
    "https://user:pass@studio.example.com",
    "https://studio.example.com/#auth",
    "https://studio.example.com/?token=anything",
    " https://studio.example.com/",
  ])("rejects unsafe launch configuration", (value) => {
    expect(() =>
      requireMiniAppUrl({ ...testEnv(), MINI_APP_URL: value }),
    ).toThrow(expect.objectContaining({ status: 503 }));
  });
  it("preserves the production HTTPS launch origin", () => {
    expect(
      requireMiniAppUrl({
        ...testEnv(),
        MINI_APP_URL: "https://k9-pb.kimshikano.workers.dev/",
      }),
    ).toBe("https://k9-pb.kimshikano.workers.dev/");
  });
  it("returns controlled storage error only after owner authentication", async () => {
    const env = { ...testEnv(), DB: undefined } as unknown as Env;
    expect(
      (
        await handleRequest(
          new Request("https://studio.example.com/api/dashboard"),
          env,
        )
      ).status,
    ).toBe(401);
    const response = await handleRequest(ownerRequest("/api/dashboard"), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "STORAGE_NOT_CONFIGURED" },
    });
  });
});
