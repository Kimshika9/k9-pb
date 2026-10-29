// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRecovery,
  readRecovery,
  writeRecovery,
  type Recovery,
} from "../src/editor/recovery";
import { sessionState } from "../src/lib/session";
vi.mock("../src/lib/telegram", () => ({ telegramInitData: null }));
const record = (): Recovery => ({
  draftId: crypto.randomUUID(),
  revision: 1,
  savedAt: Date.now(),
  value: {
    title: "မြန်မာ / Unsaved",
    channelId: null,
    document: { version: 2, blocks: [] },
  },
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});
describe("session expiry hints", () => {
  it("warns two minutes before expiry and detects expiry without granting access", () => {
    const raw = "auth_date=1000";
    expect(sessionState(raw, 1779_000).warning).toBe(false);
    expect(sessionState(raw, 1780_000)).toMatchObject({
      warning: true,
      remaining: 120,
    });
    expect(sessionState(raw, 1900_000)).toMatchObject({
      expired: true,
      remaining: 0,
    });
    expect(sessionState("auth_date=bad").remaining).toBeNull();
  });
});
describe("private draft recovery", () => {
  it("keeps session recovery without opting into device persistence", () => {
    const recovery = record();
    expect(writeRecovery(recovery, false)).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(readRecovery(recovery.draftId)).toEqual({
      recovery,
      persistent: false,
    });
  });
  it("keeps opted-in recovery across sessions and clears both stores after save", () => {
    const recovery = record();
    writeRecovery(recovery, true);
    sessionStorage.clear();
    expect(readRecovery(recovery.draftId)).toEqual({
      recovery,
      persistent: true,
    });
    clearRecovery(recovery.draftId);
    expect(readRecovery(recovery.draftId)).toBeNull();
  });
  it("rejects malformed, stale and cross-draft recovery without restoring metadata", () => {
    const recovery = record();
    const key = `k9:draft-recovery:v1:${recovery.draftId}`;
    for (const value of [
      "null",
      "not-json",
      JSON.stringify({ ...recovery, savedAt: 1 }),
      JSON.stringify({ ...recovery, draftId: "other" }),
      JSON.stringify({
        ...recovery,
        value: {
          ...recovery.value,
          document: { version: 2, blocks: [], html: "unsafe" },
        },
      }),
    ]) {
      localStorage.setItem(key, value);
      expect(readRecovery(recovery.draftId)).toBeNull();
      expect(localStorage.getItem(key)).toBeNull();
    }
  });
  it("handles unavailable browser storage without discarding the editor value", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    const recovery = record();
    expect(writeRecovery(recovery, true)).toBe(false);
    expect(recovery.value.title).toBe("မြန်မာ / Unsaved");
  });
});
