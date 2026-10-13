export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}
export interface Profile {
  user: TelegramUser;
  role: "owner";
}
export interface Channel {
  id: string;
  telegram_chat_id: string;
  title: string;
  username: string | null;
  approved_at: string | null;
  active: number;
  created_at: string;
}
export interface PostSummary {
  id: string;
  title: string;
  status: "draft" | "scheduled" | "published" | "failed";
  updated_at: string;
  channel_title: string | null;
}
export interface Dashboard {
  counts: {
    drafts: number;
    scheduled: number;
    published: number;
    channels: number;
  };
  recentPosts: PostSummary[];
  channels: Channel[];
}
export interface ApiErrorBody {
  error: { code: string; message: string };
}
