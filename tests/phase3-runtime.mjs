// Local-only integration gateway. Serves the compiled app with real workerd/D1
// and replaces every outbound Telegram call. Never deployed or imported by the app.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const owner = 123456789,
  token = "123456789:TEST_ONLY_SYNTHETIC_TOKEN_NOT_A_CREDENTIAL";
const counters = { sends: 0, edits: 0, deletes: 0 };
let nextMessage = 1000;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: "k9-phase3-integration",
        modules: true,
        scriptPath: resolve(root, "dist/k9_pb/index.js"),
        compatibilityDate: "2026-10-06",
        d1Databases: { DB: "phase3-local-test" },
        bindings: {
          TELEGRAM_BOT_TOKEN: token,
          OWNER_TELEGRAM_ID: String(owner),
          TELEGRAM_WEBHOOK_SECRET:
            "test-only-webhook-secret-with-32-characters",
          MINI_APP_URL: "https://studio.example.com",
          K9_BRIDGE_SECRET:
            "synthetic_separate_bridge_secret_32_plus_characters",
          K9_BRIDGE_ALLOWED_ACTIONS:
            "read,preview,publish,schedule,cancel,media,create,runtime",
          CLI_AUTH_SECRET: "test_only_scoped_cli_secret_32_plus_characters",
          CLI_ALLOWED_ACTIONS: "read,preview,publish",
          SCHEDULER_ENABLED: "true",
        },
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.hostname !== "api.telegram.org")
            throw new Error("Unexpected outbound test request");
          const method = url.pathname.split("/").at(-1),
            body = await request.json();
          if (body.allow_paid_broadcast)
            throw new Error("Paid broadcast must not be enabled");
          let result;
          if (method === "getMe")
            result = { id: 777, is_bot: true, username: "k9_synthetic_bot" };
          else if (method === "getChat")
            result = {
              id: Number(body.chat_id),
              type: "channel",
              title: "Synthetic test channel",
              username: "k9_synthetic_channel",
            };
          else if (method === "getChatMember")
            result =
              body.user_id === owner
                ? { status: "creator" }
                : {
                    status: "administrator",
                    can_post_messages: true,
                    can_delete_messages: true,
                  };
          else if (method === "getFile")
            result = {
              file_id: body.file_id,
              file_unique_id: "synthetic_media_unique",
              file_size: 500,
            };
          else if (
            method === "sendRichMessage" ||
            method === "editMessageText"
          ) {
            if (!body.rich_message?.blocks?.length)
              throw new Error("Invalid rich payload");
            if (method === "sendRichMessage") counters.sends++;
            else counters.edits++;
            result = {
              message_id: body.message_id ?? ++nextMessage,
              date: Math.floor(Date.now() / 1000),
              chat: { id: Number(body.chat_id) },
            };
          } else if (method === "deleteMessage") {
            counters.deletes++;
            result = true;
          } else if (method === "sendMessage")
            result = { message_id: ++nextMessage };
          else if (method === "answerCallbackQuery") result = true;
          else throw new Error("Unexpected Telegram method");
          return Response.json({ ok: true, result });
        },
      },
    ],
  }),
);
await mf.ready;
const db = await mf.getD1Database("DB");
for (const name of (await readdir(resolve(root, "migrations")))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  const sql = await readFile(resolve(root, "migrations", name), "utf8");
  // D1 exec splits on newlines; use SQLite's parser for multiline triggers.
  const statements = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        "import sys,json,sqlite3; parts=[]; buf='';\nfor char in sys.stdin.read():\n buf+=char\n if char==';' and sqlite3.complete_statement(buf): parts.append(buf); buf=''\nassert not buf.strip(); print(json.dumps(parts))",
      ],
      { input: sql, encoding: "utf8" },
    ),
  );
  await db.batch(statements.map((statement) => db.prepare(statement)));
}
await db
  .prepare(
    "INSERT INTO channels(id,telegram_chat_id,title,approved_by,approved_at) VALUES(?,'-1001234567890','Synthetic test channel',?,?)",
  )
  .bind(
    "23456789-1234-4234-8234-123456789012",
    String(owner),
    new Date().toISOString(),
  )
  .run();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:5180");
    if (url.pathname === "/__qa/cron") {
      await db
        .prepare(
          "UPDATE scheduled_jobs SET run_at=? WHERE status='pending' AND owner_telegram_id=?",
        )
        .bind(new Date(Date.now() - 1000).toISOString(), String(owner))
        .run();
      const worker = await mf.getWorker();
      await worker.scheduled({ cron: "* * * * *" });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/__qa/stats") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(counters));
      return;
    }
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/telegram/")
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string") headers[key] = value;
      const response = await mf.dispatchFetch(url.toString(), {
        method: req.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const asset = url.pathname.startsWith("/assets/")
      ? resolve(root, "dist/client", url.pathname.slice(1))
      : resolve(root, "dist/client/index.html");
    if (!asset.startsWith(resolve(root, "dist/client") + "/"))
      throw new Error();
    res.setHeader(
      "Content-Type",
      extname(asset) === ".js"
        ? "text/javascript"
        : extname(asset) === ".css"
          ? "text/css"
          : "text/html",
    );
    res.end(await readFile(asset));
  } catch {
    res.statusCode = 500;
    res.end("Local integration gateway failed.");
  }
});
server.listen(5180, "127.0.0.1", () =>
  console.log("Synthetic workerd/D1/Telegram integration ready on port 5180"),
);
async function close() {
  server.close();
  await mf.dispose();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
