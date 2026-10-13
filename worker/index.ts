import type { Dashboard, PostSummary } from "../shared/contracts";
import type { Env } from "./env";
import { authenticate } from "./lib/auth";
import { approveChannel, listChannels, revokeChannel } from "./lib/channels";
import { HttpError, json } from "./lib/http";
import { editorRoutes } from "./lib/editor-store";
import { mediaRoutes } from "./lib/media";
import { webhook } from "./lib/webhook";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST")
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST.");
      return await webhook(request, env);
    }
    if (!url.pathname.startsWith("/api/"))
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    const user = await authenticate(request, env);
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        throw new HttpError(
          403,
          "INVALID_ORIGIN",
          "Cross-origin requests are not allowed.",
        );
    }
    const editorResponse = await editorRoutes(request, env, user, url);
    if (editorResponse) return editorResponse;
    const mediaResponse = await mediaRoutes(request, env, user, url);
    if (mediaResponse) return mediaResponse;
    if (url.pathname === "/api/profile" && request.method === "GET")
      return json({ user, role: "owner" });
    if (url.pathname === "/api/channels") {
      if (request.method === "GET")
        return json({ channels: await listChannels(env) });
      if (request.method === "POST")
        return json({ channel: await approveChannel(request, env, user) }, 201);
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET or POST.");
    }
    const match = /^\/api\/channels\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (match && request.method === "DELETE") {
      await revokeChannel(match[1]!, env, user);
      return json({ ok: true });
    }
    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      const [counts, posts, channels] = await Promise.all([
        env.DB.prepare(
          `SELECT COALESCE(SUM(status='draft'),0) AS drafts, COALESCE(SUM(status='scheduled'),0) AS scheduled,
          COALESCE(SUM(status='published'),0) AS published FROM posts WHERE (owner_telegram_id=? OR owner_telegram_id IS NULL)`,
        )
          .bind(String(user.id))
          .first<{ drafts: number; scheduled: number; published: number }>(),
        env.DB.prepare(
          `SELECT p.id, p.title, p.status, p.updated_at, c.title AS channel_title
          FROM posts p LEFT JOIN channels c ON c.id=p.channel_id WHERE (p.owner_telegram_id=? OR p.owner_telegram_id IS NULL) ORDER BY p.updated_at DESC LIMIT 8`,
        )
          .bind(String(user.id))
          .all<PostSummary>(),
        listChannels(env),
      ]);
      const data: Dashboard = {
        counts: {
          drafts: counts?.drafts ?? 0,
          scheduled: counts?.scheduled ?? 0,
          published: counts?.published ?? 0,
          channels: channels.filter(
            (c) => c.active === 1 && c.approved_at !== null,
          ).length,
        },
        recentPosts: posts.results,
        channels,
      };
      return json(data);
    }
    if (["/api/profile", "/api/dashboard"].includes(url.pathname))
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use GET.");
    throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
  } catch (error) {
    if (error instanceof HttpError)
      return json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    // Do not log requests, initData, Telegram response bodies, or secret-bearing URLs.
    return json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "Something went wrong. Please try again.",
        },
      },
      500,
    );
  }
}
export default { fetch: handleRequest } satisfies ExportedHandler<Env>;
