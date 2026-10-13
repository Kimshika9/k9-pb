# Security design

## Authentication

The frontend retrieves **raw** initData from the maintained Telegram Mini Apps SDK and sends it in `Authorization: tma ...`. It never sends SDK-parsed identity as proof. The Worker derives `secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)`, then verifies `HMAC_SHA256(key=secret_key, data=data_check_string)` against the received hex hash with a constant-work byte comparison. The data check string contains decoded `key=value` lines sorted lexicographically, excluding only `hash`; an Ed25519 `signature`, if present, remains in the HMAC data check string. Duplicate parameters, malformed escapes, oversized payloads, bad IDs, invalid JSON, and missing fields are rejected.

The signed auth timestamp is accepted for **15 minutes**, allowing at most **30 seconds** into the future for clock skew. Users must relaunch through the bot after expiry. Valid signed IDs must match the configured owner ID exactly. Missing credentials fail closed. There are no sessions, browser cookies, bypasses, signup, or fallback user IDs.

initData is bearer authentication and can be replayed within its freshness window if stolen. Use HTTPS, never share launch URLs, never log payloads, and treat the entire launch data as sensitive. Phase 2 can add one-time exchange/session lifecycle if needed; freshness validation alone does not make launch data single-use.

## API and channels

All API routes authenticate before routing. Mutations reject mismatched Origin headers; authentication headers are still mandatory when Origin is absent, as with non-browser clients. CORS is not enabled. JSON bodies have a streaming 64 KiB cap. Errors are sanitized, and API responses prohibit caching.

Channel connection is an explicit owner action, with `approved: true`. Telegram must report a channel, the bot as an administrator with posting permission, and the owner as an administrator or creator. Approval and audit writes share a D1 transaction. Revocation cancels jobs and returns scheduled posts to drafts. SQL triggers block initial scheduled/published posts and new jobs targeting unapproved channels. These constraints are defense in depth: the future publishing service must check approval and live Telegram permissions at send time, including when replaying old jobs. The Phase 1 Telegram client exposes no channel publication method.

## Webhook

Use a random **32+ character** secret restricted to Telegram's supported `A-Z a-z 0-9 _ -` alphabet. Cloudflare stores it as a secret. The Worker verifies the Telegram secret header through fixed-length SHA-256 digests before parsing the body. Only owner `/start` messages in the owner's private chat send a launch button; other events return an empty acknowledgment without exposing private data.

D1 stores update IDs, processing leases, completed state and retryable failures. Concurrent delivery receives a retryable 503 while processing; expired leases can be reclaimed. Completed deliveries are deduplicated. Telegram sends and D1 completion cannot share a transaction: a crash after sending but before marking completion can duplicate the launch message (at-least-once delivery). It never triggers channel publication. Define a safe webhook record retention policy in Phase 2, keeping records longer than Telegram's retry horizon.

## Deployment boundaries

Secrets stay Worker-side. Observability is disabled by default to avoid collecting request material. Enable only with deliberate redaction. D1 stores private workspace data and signed user identity never enters public static assets. Use separate development and production bots/databases. `.env*`, `.dev.vars*`, `.wrangler`, and build artifacts are ignored; `.env.example` is explicitly allowed and contains no real credentials.

The official Vite plugin may copy local `.dev.vars` into the **Worker build directory** for local preview. This is excluded from public static assets, but treat local build directories as sensitive whenever credentials were present during build; do not share or upload them as generic artifacts. Production CI must use Cloudflare secrets rather than local credential files.

No remote resources or credentials are provisioned automatically. Deployment and webhook registration require user authorization. See DEPLOYMENT.md.

## Phase 2 data boundaries

Drafts and templates use strict Zod runtime schemas, owner-scoped resource reads/writes and optimistic revisions. Legacy owner-null Phase 1 records belong to the original single-owner workspace and are preserved; new writes record the configured owner. The dashboard also filters owned/legacy records. Client-supplied owner/status/publishing fields are rejected. Stale saves/deletes return 409 without overwriting content. Draft/template media references must match registered owner library IDs, file IDs and kind.

Media registration is allowed only from the authenticated owner private webhook chat, or through owner-authenticated getFile verification. Metadata and file IDs are stored in D1; no token-bearing file_path/download URL reaches the UI. Repeated registration preserves the canonical file ID. Unsupported/oversized registration fails with a sanitized error; no browser upload or download proxy is present. Application caps and pending native/large-video checks are documented separately.

Editor content is versioned structured data. The Tiptap schema restricts pasted HTML; previews use React text/elements and safe URL protocols. No raw HTML injection is used. Complete exports reject missing actions, unsafe URLs, invalid callback byte lengths, link-style URL buttons and incomplete media. Callback preview clicks execute no live workflow. Export/backup files are private owner data, and backups can contain unsaved content; handle them accordingly.

All Phase 1 signature, freshness, no-store, body-size, same-origin, webhook-secret and no-production-bypass controls remain in place. The Worker still contains no channel send or scheduling handler. Native Telegram acceptance and hosted Rich Message sending require explicit Phase 3 work and owner approval for external actions.
