export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  OWNER_TELEGRAM_ID: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MINI_APP_URL: string;
  K9_BRIDGE_SECRET?: string;
  K9_BRIDGE_ALLOWED_ACTIONS?: string;
  CLI_AUTH_SECRET?: string;
  CLI_ALLOWED_ACTIONS?: string;
  SCHEDULER_ENABLED?: string;
}
