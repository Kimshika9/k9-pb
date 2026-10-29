# Security design

## Authentication

The frontend retrieves **raw** initData from the maintained Telegram Mini Apps SDK and sends it in `Authorization: tma ...`. It never sends SDK-parsed identity as proof. The Worker derives `secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)`, then verifies `HMAC_SHA256(key=secret_key, data=data_check_string)` against the received hex hash with a constant-work byte comparison. The data check string contains decoded `key=value` lines sorted lexicographically, excluding only `hash`; an Ed25519 `signature`, if present, remains in the HMAC data check string. Duplicate parameters, malformed escapes, oversized payloads, bad IDs, invalid JSON, and missing fields are rejected.

The signed auth timestamp is accepted for **15 minutes**, allowing at most **30 seconds** into the future for clock skew. Users must relaunch through the bot after expiry. Valid signed IDs must match the configured owner ID exactly. Missing credentials fail closed. There are no sessions, browser cookies, bypasses, signup, or fallback user IDs.

initData is bearer authentication and can be replayed within its freshness window if stolen. Use HTTPS, never share launch URLs, never log payloads, and treat the entire launch data as sensitive. Phase 2 can add one-time exchange/session lifecycle if needed; freshness validation alone does not make launch data single-use.

## API and channels

All API routes authenticate before routing. Mutations reject mismatched Origin headers; authentication headers are still mandatory when Origin is absent, as with non-browser clients. CORS is not enabled. JSON bodies have a streaming 64 KiB cap. Errors are sanitized, and API responses prohibit caching.

Channel connection is an explicit owner action, with `approved: true`. Telegram must report a channel, the bot as an administrator with posting permission, and the owner as an administrator or creator. Approval and audit writes share a D1 transaction. Revocation cancels jobs and returns scheduled posts to drafts. SQL triggers block initial scheduled/published posts and new jobs targeting unapproved channels. These constraints are defense in depth: the future publishing service must check approval and live Telegram permissions at send time, including when replaying old jobs. The Phase 1 Telegram client exposes no channel publication method.

## Webhook

Use a random **32+ character** secret restricted to Telegram's supported `A-Z a-z 0-9 _ -` alphabet. Cloudflare stores it as a secret. The Worker verifies the Telegram secret header through fixed-length SHA-256 digests before parsing the body. Only owner private commands expose workspace summaries or launch buttons. Preview callbacks are inert; unauthorized callbacks receive a generic acknowledgment without private data. Owner media registration remains private.

D1 stores update IDs, processing leases, completed state and retryable failures. Concurrent delivery receives a retryable 503 while processing; expired leases can be reclaimed. Completed deliveries are deduplicated. Telegram sends and D1 completion cannot share a transaction: a crash after sending but before marking completion can duplicate the launch message (at-least-once delivery). It never triggers channel publication. Define a safe webhook record retention policy in Phase 2, keeping records longer than Telegram's retry horizon.

## Deployment boundaries

Secrets stay Worker-side. Observability is disabled by default to avoid collecting request material. Enable only with deliberate redaction. D1 stores private workspace data and signed user identity never enters public static assets. Use separate development and production bots/databases. `.env*`, `.dev.vars*`, `.wrangler`, and build artifacts are ignored; `.env.example` is explicitly allowed and contains no real credentials.

The official Vite plugin may copy local `.dev.vars` into the **Worker build directory** for local preview. This is excluded from public static assets, but treat local build directories as sensitive whenever credentials were present during build; do not share or upload them as generic artifacts. Production CI must use Cloudflare secrets rather than local credential files.

No remote resources or credentials are provisioned automatically by the guarded deploy command. Pin the existing D1 UUID and production account first. Deployment, remote migrations, main-branch pushes that trigger deployment, and webhook changes require user authorization. See DEPLOYMENT.md.

## Phase 2 data boundaries

Drafts and templates use strict Zod runtime schemas, owner-scoped resource reads/writes and optimistic revisions. Legacy owner-null Phase 1 records belong to the original single-owner workspace and are preserved; new writes record the configured owner. The dashboard also filters owned/legacy records. Client-supplied owner/status/publishing fields are rejected. Stale saves/deletes return 409 without overwriting content. Draft/template media references must match registered owner library IDs, file IDs and kind.

Media registration is allowed only from the authenticated owner private webhook chat, or through owner-authenticated getFile verification. Metadata and file IDs are stored in D1; no token-bearing file_path/download URL reaches the UI. Repeated registration preserves the canonical file ID. Unsupported/oversized registration fails with a sanitized error; no browser upload or download proxy is present. Application caps and pending native/large-video checks are documented separately.

Editor content is versioned structured data. The Tiptap schema restricts pasted HTML; previews use React text/elements and safe URL protocols. No raw HTML injection is used. Complete exports reject missing actions, unsafe URLs, invalid callback byte lengths, link-style URL buttons and incomplete media. Callback preview clicks execute no live workflow. Export/backup files are private owner data, and backups can contain unsaved content; handle them accordingly.

All Phase 1 signature, freshness, no-store, body-size, same-origin, webhook-secret and no-production-bypass controls remain in place. Phase 3 adds authenticated publishing and a disabled-by-default Cron handler. Native Telegram acceptance and live Rich Message sending still require owner approval for external actions.

## Recovery audit hardening

Runtime checks reject placeholder/malformed or padded bot tokens, non-canonical owner IDs and unsupported webhook-secret characters. The token shape check cannot verify issuance or revocation; use an authorized private getMe check for that. Missing D1 is reported only after owner authentication, with a sanitized storage error. No public configuration/debug endpoint is introduced.

Owner media updates now use the update lease before getFile/storage and deduplicate completed deliveries. Lease-scoped completion protects against a stale worker marking a newer attempt complete. Media upserts retain canonical IDs; Telegram send completion still cannot be atomic with D1.

Unsaved session recovery contains only the draft ID, revision, timestamp, title, destination and validated editor document. Persistent device recovery is opt-in, checked for a seven-day lifetime and read only after opening an authenticated server draft. It is local plaintext private content: trusted-device use only, optional, cleared on successful save, with backup fallback on storage failure. Recovery never stores signed launch data or credentials and never refreshes authentication. Legacy owner-null data remains owned by the single-owner workspace: changing the owner is an explicit data-migration/security decision, not a routine configuration workaround.

## Phase 3 controller and delivery security

Only /api/cli/* uses a separate CLI secret; all Mini App routes retain their original initData checks. HMAC covers timestamp, nonce, uppercase method, exact original path/query and SHA-256 of raw bytes. Strict expiry, bounded body, constant-work signature comparison, method/path scope whitelist and atomic D1 nonce reservation reject forged, modified and replayed requests. Default scope is read-only. Valid scoped requests enter the same configured owner context and resource/channel/serializer/permission checks; no arbitrary destination or client-selected owner is accepted. Public status/debug endpoints are not introduced. Rotate the separate secret privately to revoke controllers.

Immutable snapshots and revision locks prevent accidental overwrites. Durable operation IDs, unique active claims and sending leases protect retries. A confirmed provider rejection can retry safely with the original operation; uncertain external results never automatically retry. Owner reconciliation records explicit observation and is not live verification. Application approval can be revoked while a Telegram request is already in flight; the system cannot recall an external request and exposes uncertainty rather than claiming no delivery.

Provider errors and network exceptions are sanitized; Telegram token-bearing request URLs never appear in reports/logs/UI. Native fetch retains its global receiver, uses manual redirects and validates chat/message confirmations. No paid broadcasts, business callback side effects, media token URLs or production auth bypasses are added. Phase 3.1 introduces only explicitly confirmed, fenced Python polling. The synthetic test gateway is outside all app imports/build entrypoints and must never be deployed.

## Phase 3.1 Telegram receiver and bridge

The bot bridge has a distinct K9_BRIDGE_SECRET and a narrow /api/bridge whitelist, separate from old CLI and raw Mini App auth. Server-scoped owner identity, HMAC/timestamp/body/path validation, constant-work comparisons, durable nonce reservation and per-owner read/write limits precede routing. It cannot approve arbitrary channels, mutate publication records directly or read production secrets. Sender identity alone is not backend proof.

Python commands/media/callbacks check both owner identity and private chat context; stale menu epochs/message IDs expire and mutations require confirmation. Polling requires a unique renewable D1 lease and current Python fence. Worker webhook traffic is paused after secret verification whenever the fence is python/transition. PTB automatic webhook deletion is blocked. Mode switches must be separately confirmed and restore known metadata with the existing privately supplied Worker secret. Unknown/custom certificate integrations are preserved by refusing unsafe takeover.

.env and .k9-webhook-backup.json are ignored and privately written. Hidden secret input refuses echo fallback; diagnostic output and logs omit tokens, updates, HTTP URLs and exception reprs. Native Telegram/Windows/Termux and production mode-switch acceptance remain separate live tests.
