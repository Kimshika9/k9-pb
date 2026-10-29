import type { Dashboard, PostSummary } from "../shared/contracts";
import type { Env } from "./env";
import { authenticate } from "./lib/auth";
import { approveChannel, listChannels, revokeChannel } from "./lib/channels";
import { HttpError, json } from "./lib/http";
import { editorRoutes } from "./lib/editor-store";
import { mediaRoutes } from "./lib/media";
import { webhook } from "./lib/webhook";
import { bridgeRoutes } from "./lib/bridge-routes";
import { authenticateCli, authenticateBridge } from "./lib/cli-auth";
import { publishingRoutes } from "./lib/publishing-routes";
import { scheduledHandler } from "./lib/scheduler";

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  let url = new URL(request.url);
  try {
    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST")
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST.");
      return await webhook(request, env);
    }
    if (!url.pathname.startsWith("/api/"))
      throw new HttpError(404, "NOT_FOUND", "Endpoint not found.");
    let user;
    const isBridge = url.pathname.startsWith("/api/bridge/");
    if (isBridge) {
      const authenticated = await authenticateBridge(request, env);
      request = authenticated.request;
      url = authenticated.url;
      user = authenticated.user;
    } else if (url.pathname.startsWith("/api/cli/")) {
      const authenticated = await authenticateCli(request, env);
      request = authenticated.request;
      url = authenticated.url;
      user = authenticated.user;
    } else user = await authenticate(request, env);
    if (!env.DB || typeof env.DB.prepare !== "function")
      throw new HttpError(
        503,
        "STORAGE_NOT_CONFIGURED",
        "Studio storage is not configured yet.",
      );
    if (!["GET", "HEAD"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        throw new HttpError(
          403,
          "INVALID_ORIGIN",
          "Cross-origin requests are not allowed.",
        );
    }
    if (isBridge) {
      const response = await bridgeRoutes(request, env, url);
      if (response) return response;
    }
    const publishingResponse = await publishingRoutes(request, env, url);
    if (publishingResponse) return publishingResponse;
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
          `SELECT COALESCE(SUM(status='draft'),0) AS drafts,
          (SELECT count(*) FROM scheduled_jobs WHERE (owner_telegram_id=? OR owner_telegram_id IS NULL) AND status IN ('pending','running')) AS scheduled,
          (SELECT count(*) FROM publications WHERE owner_telegram_id=? AND kind='publication' AND status='published') AS published
          FROM posts WHERE (owner_telegram_id=? OR owner_telegram_id IS NULL)`,
        )
          .bind(String(user.id), String(user.id), String(user.id))
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
export default {
  fetch: handleRequest,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;
