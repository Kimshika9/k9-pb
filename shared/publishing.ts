import type { EditorDocument } from "./editor/model";
export type PublicationStatus =
  "preparing" | "sending" | "published" | "failed" | "uncertain" | "deleted";
export interface Publication {
  id: string;
  post_id: string | null;
  origin_post_id: string;
  channel_id: string | null;
  edit_draft_id: string | null;
  kind: "publication" | "preview";
  title: string;
  document_json: string;
  source_revision: number;
  revision: number;
  status: PublicationStatus;
  telegram_message_id: number | null;
  telegram_chat_id: string | null;
  message_url: string | null;
  operation_id: string;
  active_operation_id: string | null;
  last_error_code: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ScheduledJob {
  id: string;
  post_id: string;
  channel_id: string | null;
  title: string | null;
  source_revision: number | null;
  revision: number;
  timezone: "UTC" | "Asia/Yangon";
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  run_at: string;
  delivery_state:
    | "legacy_review"
    | "waiting"
    | "preparing"
    | "sending"
    | "delivered"
    | "rejected"
    | "uncertain"
    | "cancelled";
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_error_code: string | null;
  publication_id: string | null;
}
export interface DeliverySnapshot {
  postId: string;
  title: string;
  document: EditorDocument;
  revision: number;
}
export function localTimeToUTC(
  input: string,
  timezone: "UTC" | "Asia/Yangon",
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input);
  if (!match) throw new Error("Choose a valid date and time.");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59
  )
    throw new Error("Invalid date/time.");
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    throw new Error("Invalid calendar date.");
  return new Date(
    local.getTime() - (timezone === "Asia/Yangon" ? 390 : 0) * 60_000,
  ).toISOString();
}
