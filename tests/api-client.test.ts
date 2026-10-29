// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/telegram", () => ({
  telegramInitData: "synthetic-test-init-data",
}));
import { api } from "../src/lib/api";
afterEach(() => vi.unstubAllGlobals());
describe("API response recovery", () => {
  it.each([
    null,
    {},
    { error: null },
    { error: { code: 12, message: { token: "private" } } },
  ])("sanitizes malformed error envelopes", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 503 })),
    );
    await expect(api("/api/profile")).rejects.toMatchObject({
      status: 503,
      code: "REQUEST_FAILED",
      message: "The request failed. Please try again.",
    });
  });
  it("rejects SPA HTML masquerading as a successful private API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>app</html>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    await expect(api("/api/profile")).rejects.toMatchObject({
      status: 502,
      code: "INVALID_RESPONSE",
    });
  });
  it("preserves controlled NOT_CONFIGURED errors and uses signed data only", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: "NOT_CONFIGURED",
            message: "The studio is not configured yet.",
          },
        },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(api("/api/profile")).rejects.toMatchObject({
      status: 503,
      code: "NOT_CONFIGURED",
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("tma synthetic-test-init-data");
  });
});
