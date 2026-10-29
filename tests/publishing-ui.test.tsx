// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Channel } from "../shared/contracts";
import type { Publication } from "../shared/publishing";
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  api: vi.fn(),
}));
import { api, ApiError } from "../src/lib/api";
import { PublishingPanel } from "../src/editor/PublishingPanel";
import { DeliveryWorkspace } from "../src/editor/DeliveryWorkspace";
const apiMock = vi.mocked(api);
const postId = "12345678-1234-4234-8234-123456789012";
const channel: Channel = {
  id: "23456789-1234-4234-8234-123456789012",
  title: "Approved test channel",
  telegram_chat_id: "-1001234567890",
  username: "test_channel",
  approved_at: "2026-10-13T00:00:00Z",
  active: 1,
  created_at: "2026-10-13T00:00:00Z",
};
afterEach(() => {
  cleanup();
  apiMock.mockReset();
  vi.restoreAllMocks();
});
describe("saved-draft delivery controls", () => {
  it("requires valid saved content and confirmation before publication", () => {
    render(
      <PublishingPanel
        postId={postId}
        revision={1}
        valid={false}
        channels={[channel]}
        initialChannelId={channel.id}
      />,
    );
    expect(screen.getByRole("button", { name: "Publish Now" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Send Test Preview" }),
    ).toBeDisabled();
    expect(apiMock).not.toHaveBeenCalled();
  });
  it("prevents duplicate clicks and reuses operation IDs after rate limits", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish: (result: unknown) => void = () => {};
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <PublishingPanel
        postId={postId}
        revision={1}
        valid
        channels={[channel]}
        initialChannelId={channel.id}
      />,
    );
    const publish = screen.getByRole("button", { name: "Publish Now" });
    fireEvent.click(publish);
    fireEvent.click(publish);
    expect(apiMock).toHaveBeenCalledOnce();
    finish({ publication: { status: "published", telegram_message_id: 101 } });
    await screen.findByText(/Channel delivery confirmed/);
    apiMock.mockRejectedValueOnce(
      new ApiError(429, "TELEGRAM_RATE_LIMIT", "Retry later."),
    );
    fireEvent.click(publish);
    await screen.findByText("Retry later.");
    apiMock.mockResolvedValueOnce({
      publication: { status: "published", telegram_message_id: 101 },
    });
    fireEvent.click(publish);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
    const ids = apiMock.mock.calls.map(
      ([, options]) => JSON.parse(String(options?.body)).operationId,
    );
    expect(new Set(ids).size).toBe(1);
  });
  it("sends owner previews and serializes Yangon schedules to UTC", async () => {
    apiMock
      .mockResolvedValueOnce({
        publication: { status: "published", telegram_message_id: 101 },
      })
      .mockResolvedValueOnce({ job: { id: "scheduled" } });
    render(
      <PublishingPanel
        postId={postId}
        revision={3}
        valid
        channels={[channel]}
        initialChannelId={channel.id}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send Test Preview" }));
    await screen.findByText(/Private test preview confirmed/);
    expect(apiMock.mock.calls[0]?.[0]).toBe(`/api/posts/${postId}/preview`);
    expect(
      JSON.parse(String(apiMock.mock.calls[0]?.[1]?.body)),
    ).not.toHaveProperty("channelId");
    fireEvent.change(screen.getByLabelText("Schedule date and time"), {
      target: { value: "2027-01-02T12:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule Post" }));
    await screen.findByText(/Schedule saved in UTC/);
    expect(JSON.parse(String(apiMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      runAt: "2027-01-02T05:30:00.000Z",
      timezone: "Asia/Yangon",
      revision: 3,
    });
  });
});
describe("published manager", () => {
  const publication: Publication = {
    id: postId,
    post_id: postId,
    origin_post_id: postId,
    edit_draft_id: null,
    channel_id: channel.id,
    kind: "publication",
    title: "Published fixture",
    document_json: '{"version":2,"blocks":[]}',
    source_revision: 1,
    revision: 2,
    status: "published",
    telegram_message_id: 101,
    telegram_chat_id: channel.telegram_chat_id,
    message_url: "https://t.me/test_channel/101",
    operation_id: postId,
    active_operation_id: null,
    last_error_code: null,
    published_at: "2026-10-13T00:00:00Z",
    created_at: "2026-10-13T00:00:00Z",
    updated_at: "2026-10-13T00:00:00Z",
  };
  it("requires deletion confirmation and keeps status/history on Telegram failure", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    apiMock.mockImplementation(async (path) => {
      if (path.endsWith("/delete"))
        throw new ApiError(
          502,
          "TELEGRAM_REJECTED",
          "Telegram cannot delete this message.",
        );
      return path.includes("?")
        ? { publications: [publication], nextOffset: null }
        : { publication, history: [], operations: [] };
    });
    render(
      <DeliveryWorkspace
        mode="published"
        channels={[channel]}
        onDraft={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage publication" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete Telegram message" }),
    );
    expect(apiMock.mock.calls.some(([path]) => path.endsWith("/delete"))).toBe(
      false,
    );
    confirm.mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete Telegram message" }),
    );
    expect(
      await screen.findByText("Telegram cannot delete this message."),
    ).toBeInTheDocument();
    expect(screen.getByText("Publishing history")).toBeInTheDocument();
    expect(
      screen.getByText("Publication status:", { exact: false }),
    ).toHaveTextContent("published");
  });
});
