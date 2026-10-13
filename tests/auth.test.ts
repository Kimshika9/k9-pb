import { describe, expect, it } from "vitest";
import { authenticate, verifyInitData } from "../worker/lib/auth";
import {
  OWNER_ID,
  ownerRequest,
  signedInitData,
  TEST_TOKEN,
  testEnv,
} from "./helpers";

describe("Telegram HMAC authentication", () => {
  it("accepts independently signed Telegram data and sanitizes the profile", async () => {
    const user = await verifyInitData(
      signedInitData({
        user: {
          id: OWNER_ID,
          first_name: "K9",
          username: "owner",
          photo_url: "untrusted",
          extra: "ignore",
        },
      }),
      TEST_TOKEN,
    );
    expect(user).toEqual({ id: OWNER_ID, first_name: "K9", username: "owner" });
  });
  it("includes signature and Unicode fields in the HMAC data check string", async () => {
    const raw = signedInitData({
      user: { id: OWNER_ID, first_name: "K9 မြန်မာ" },
      extra: { signature: "test-signature", start_param: "a+b" },
    });
    expect((await verifyInitData(raw, TEST_TOKEN)).first_name).toBe(
      "K9 မြန်မာ",
    );
  });
  it.each([
    ["", "missing data"],
    ["user=%7B%7D", "missing hash"],
    [signedInitData().replace("test-query", "tampered"), "tampered payload"],
    [signedInitData({ token: "wrong-token" }), "wrong bot"],
    [signedInitData({ age: 1000 }), "expired payload"],
    [signedInitData({ age: -60 }), "future payload"],
    [signedInitData() + "&auth_date=1", "duplicate fields"],
    [signedInitData() + "&user=%ZZ", "invalid percent encoding"],
    [
      signedInitData({ user: { id: "123456789", first_name: "K9" } }),
      "string user ID",
    ],
    [
      signedInitData({ user: { id: -1, first_name: "K9" } }),
      "negative user ID",
    ],
    [signedInitData({ user: { id: 1 } }), "missing first name"],
    [signedInitData({ extra: { auth_date: "NaN" } }), "invalid auth date"],
    [signedInitData({ extra: { user: "{broken" } }), "invalid user JSON"],
    ["x".repeat(17000), "oversized payload"],
  ])("rejects invalid payload (%s / %s) as 401", async (raw) => {
    await expect(verifyInitData(raw, TEST_TOKEN)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("rejects the clock-skew boundary beyond 30 seconds", async () => {
    const raw = signedInitData();
    const authDate = Number(new URLSearchParams(raw).get("auth_date"));
    await expect(
      verifyInitData(raw, TEST_TOKEN, authDate - 31),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verifyInitData(raw, TEST_TOKEN, authDate - 30),
    ).resolves.toMatchObject({ id: OWNER_ID });
  });
  it("accepts the 15 minute boundary", async () => {
    const raw = signedInitData({ age: 900 });
    const now = Number(new URLSearchParams(raw).get("auth_date")) + 900;
    await expect(verifyInitData(raw, TEST_TOKEN, now)).resolves.toMatchObject({
      id: OWNER_ID,
    });
    await expect(
      verifyInitData(raw, TEST_TOKEN, now + 1),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("returns 403 for an authentic non-owner", async () => {
    await expect(
      authenticate(
        ownerRequest(
          "/api/profile",
          {},
          signedInitData({ user: { id: 55, first_name: "Other" } }),
        ),
        testEnv(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("fails closed when credentials are absent", async () => {
    await expect(
      authenticate(ownerRequest("/api/profile"), {
        ...testEnv(),
        TELEGRAM_BOT_TOKEN: "",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
