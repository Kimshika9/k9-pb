import type { EditorDocument } from "../../shared/editor/model";
import { parseDocument } from "../../shared/editor/schema";

export interface DraftValue {
  title: string;
  document: EditorDocument;
  channelId: string | null;
}
export interface Recovery {
  draftId: string;
  revision: number;
  savedAt: number;
  value: DraftValue;
}
const key = (id: string) => `k9:draft-recovery:v1:${id}`;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function readRecovery(
  id: string,
): { recovery: Recovery; persistent: boolean } | null {
  for (const persistent of [false, true]) {
    try {
      const storage = persistent ? localStorage : sessionStorage;
      const raw = storage.getItem(key(id));
      if (!raw) continue;
      if (raw.length > 100_000) throw new Error();
      const value = JSON.parse(raw) as Recovery;
      if (
        value.draftId !== id ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1 ||
        !Number.isSafeInteger(value.savedAt) ||
        value.savedAt > Date.now() ||
        Date.now() - value.savedAt > RETENTION_MS ||
        typeof value.value?.title !== "string" ||
        value.value.title.length > 160 ||
        !(
          value.value.channelId === null ||
          (typeof value.value.channelId === "string" &&
            /^[a-f0-9-]{36}$/.test(value.value.channelId))
        )
      )
        throw new Error();
      const document = parseDocument(value.value.document);
      // Copy only the structured draft fields; never restore auth or arbitrary metadata.
      return {
        recovery: {
          draftId: id,
          revision: value.revision,
          savedAt: value.savedAt,
          value: {
            title: value.value.title,
            channelId: value.value.channelId,
            document,
          },
        },
        persistent,
      };
    } catch {
      try {
        (persistent ? localStorage : sessionStorage).removeItem(key(id));
      } catch {
        /* Storage may be disabled. */
      }
    }
  }
  return null;
}
export function clearRecovery(id: string): void {
  for (const persistent of [false, true]) {
    try {
      (persistent ? localStorage : sessionStorage).removeItem(key(id));
    } catch {
      /* No credentials or errors are logged. */
    }
  }
}
export function writeRecovery(
  recovery: Recovery,
  persistent: boolean,
): boolean {
  const raw = JSON.stringify(recovery);
  let stored = false;
  try {
    sessionStorage.setItem(key(recovery.draftId), raw);
    stored = true;
  } catch {
    /* Download backup remains available. */
  }
  try {
    if (persistent) {
      localStorage.setItem(key(recovery.draftId), raw);
      stored = true;
    } else localStorage.removeItem(key(recovery.draftId));
  } catch {
    if (persistent) return false;
  }
  return stored;
}
