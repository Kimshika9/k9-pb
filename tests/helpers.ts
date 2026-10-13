import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { Env } from "../worker/env";

export const TEST_TOKEN = "test-only-bot-token";
export const OWNER_ID = 123456789;
export function signedInitData(
  options: {
    user?: unknown;
    age?: number;
    token?: string;
    extra?: Record<string, string>;
  } = {},
): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - (options.age ?? 0)),
    query_id: "test-query",
    user: JSON.stringify(
      options.user ?? {
        id: OWNER_ID,
        first_name: "Studio",
        username: "studio_owner",
      },
    ),
    ...options.extra,
  });
  const check = [...params]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData")
    .update(options.token ?? TEST_TOKEN)
    .digest();
  params.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return params.toString();
}
export function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    sqlite.exec(
      readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"),
    );
  }
  class Statement {
    private values: (string | number | null)[] = [];
    private readonly query: string;
    constructor(query: string) {
      this.query = query;
    }
    bind(...values: (string | number | null)[]) {
      this.values = values;
      return this;
    }
    async first<T>() {
      return (sqlite.prepare(this.query).get(...this.values) ??
        null) as T | null;
    }
    async all<T>() {
      return this.execute<T>();
    }
    async run() {
      return this.execute();
    }
    execute<T = unknown>() {
      return {
        success: true,
        results: sqlite.prepare(this.query).all(...this.values) as T[],
      };
    }
  }
  const db = {
    prepare(query: string) {
      return new Statement(query);
    },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
}
export function testEnv(db?: D1Database): Env {
  return {
    DB: db ?? ({} as D1Database),
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    OWNER_TELEGRAM_ID: String(OWNER_ID),
    TELEGRAM_WEBHOOK_SECRET: "test-only-webhook-secret-with-32-characters",
    MINI_APP_URL: "https://studio.example.com",
  };
}
export function ownerRequest(
  path: string,
  options: RequestInit = {},
  initData = signedInitData(),
): Request {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `tma ${initData}`);
  if (options.body) headers.set("Content-Type", "application/json");
  return new Request(`https://studio.example.com${path}`, {
    ...options,
    headers,
  });
}
