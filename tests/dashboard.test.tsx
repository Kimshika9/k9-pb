// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { Dashboard } from "../shared/contracts";
vi.mock("../src/lib/telegram", () => ({
  telegramInitData: "test-only-init-data",
}));
vi.mock("../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, api: vi.fn() };
});
import { api, ApiError } from "../src/lib/api";
import App from "../src/App";
import { ChannelForm } from "../src/components/ChannelForm";
const apiMock = vi.mocked(api);
const empty: Dashboard = {
  counts: { drafts: 0, scheduled: 0, published: 0, channels: 0 },
  recentPosts: [],
  channels: [],
};
function respond(dashboard = empty) {
  apiMock.mockImplementation(async (path) =>
    path === "/api/profile"
      ? { user: { id: 123, first_name: "Owner" }, role: "owner" }
      : dashboard,
  );
}
afterEach(() => {
  cleanup();
  apiMock.mockReset();
});
describe("dashboard states and owner controls", () => {
  it("shows loading while authentication and data are pending", () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    render(<App />);
    expect(
      screen.getByText("Loading your private workspace…"),
    ).toBeInTheDocument();
  });
  it("shows real empty state and navigates to channels", async () => {
    respond();
    render(<App />);
    expect(
      await screen.findByText("A fresh start for your content"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Connect your first channel" }),
    );
    expect(screen.getByText("Give your content a home")).toBeInTheDocument();
  });
  it("shows posts from the API and owner profile", async () => {
    respond({
      ...empty,
      counts: { ...empty.counts, drafts: 1 },
      recentPosts: [
        {
          id: "p",
          title: "Launch update",
          status: "draft",
          updated_at: "2026-10-12T00:00:00Z",
          channel_title: "K9 News",
        },
      ],
    });
    render(<App />);
    expect(await screen.findByText("Launch update")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    expect(
      screen.getByText("Signed Telegram Mini App data"),
    ).toBeInTheDocument();
    expect(screen.getByText("123")).toBeInTheDocument();
  });
  it("does not display private controls to a non-owner", async () => {
    apiMock.mockRejectedValue(
      new ApiError(403, "OWNER_ONLY", "This studio is private to its owner."),
    );
    render(<App />);
    expect(
      await screen.findByText("This studio belongs to its owner"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect channel" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Recent posts")).not.toBeInTheDocument();
  });
  it("shows recoverable errors and reloads on retry", async () => {
    apiMock.mockRejectedValue(
      new ApiError(0, "NETWORK_ERROR", "Check your connection."),
    );
    render(<App />);
    expect(
      await screen.findByText("We couldn’t load your studio"),
    ).toBeInTheDocument();
    respond();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("A fresh start for your content"),
    ).toBeInTheDocument();
  });
});
describe("explicit channel approval", () => {
  it("requires approval before enabling connection and sends the approved channel", async () => {
    // JSDOM lacks dialog methods; these are browser primitives, not authentication mocks.
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    const saved = vi.fn();
    apiMock.mockResolvedValue({ channel: { id: "c" } });
    render(<ChannelForm onClose={vi.fn()} onSaved={saved} />);
    const button = screen.getByRole("button", { name: "Approve & connect" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Channel username or ID"), {
      target: { value: "@k9_news" },
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(apiMock).toHaveBeenCalledWith("/api/channels", {
      method: "POST",
      body: JSON.stringify({ chatId: "@k9_news", approved: true }),
    });
  });
});
