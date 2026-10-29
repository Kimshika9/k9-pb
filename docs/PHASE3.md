# Phase 3: publishing and Python controller

The Mini App, publishing service, Cron handler and single Telegram webhook run in the existing Cloudflare Worker. D1 stores immutable delivery snapshots, receipts, operations, schedules and history. Phase 3.1 upgrades `bot.py` into a real Python Telegram bot with mutually exclusive polling and Cloudflare receiver modes; see [the current Python guide](PYTHON_BOT.md). The previous CLI remains for compatibility. Python is never hosted as an always-on polling process on Cloudflare.

## Owner workflow

Save a complete draft in **Posts**. Select an explicitly approved channel, then use **Send Test Preview**, **Publish Now** or **Schedule Post**. Publish Now confirms the destination. Private previews add a visible K9 test heading and replace callback data with inert `k9:preview` acknowledgments. Browser preview remains available. Nothing is sent merely by saving a draft.

**Published** lists channel deliveries and private previews with status, message IDs, links, errors and operation history. **Edit Published Post** creates a separate editing draft; save its changes, return to the publication and choose **Apply saved draft**. Telegram receives `editMessageText` with `rich_message`. The original source draft remains intact. Delete requires confirmation and calls `deleteMessage`; provider rejection preserves the publication, source draft and history. The app checks the documented 48-hour deletion window; actual Telegram permissions and exceptions still decide acceptance. **Republish copy** is an explicit new delivery, with an approved destination.

Scheduled jobs capture the saved revision at creation. Later edits do not change that snapshot; rescheduling deliberately captures the latest saved source. Select **Asia/Yangon** or UTC; wall times are converted to UTC before submission. **Scheduled** shows queue state, errors, attempts, retries and cancel/reschedule controls. Pending schedules block draft deletion until cancelled. Revocation cancels safe pending work and isolates in-flight sends for reconciliation.

## API

Normal Mini App routes retain raw Telegram initData HMAC, freshness and owner checks. All writes validate strict schemas and owner-scoped resources. UUID operation IDs identify exact actions; repeat requests return known receipts, conflicting bodies return 409. Source/publication/job revisions are positive optimistic concurrency counters.

| Method | Path                                         | Request or response                                                                                       |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/status`, `/api/doctor`                 | Private counts, migration compatibility, scheduler heartbeat/enabled flag and CLI scope names; no secrets |
| GET    | `/api/posts`, `/api/posts/:id`               | Saved sources; `offset` pagination                                                                        |
| POST   | `/api/posts/:id/preview`                     | `{operationId, revision}`                                                                                 |
| POST   | `/api/posts/:id/publish`                     | `{operationId, revision, channelId}`                                                                      |
| POST   | `/api/posts/:id/schedule`                    | `{operationId, revision, channelId, runAt, timezone}`; ISO UTC timestamp, future within 366 days          |
| GET    | `/api/publications`, `/api/publications/:id` | Ledger, per-publication history and saved operation revision metadata                                     |
| POST   | `/api/publications/:id/draft`                | `{operationId, revision}`; isolated editing copy                                                          |
| POST   | `/api/publications/:id/edit`                 | `{operationId, revision, postId, postRevision}`                                                           |
| POST   | `/api/publications/:id/delete`               | `{operationId, revision}`                                                                                 |
| POST   | `/api/publications/:id/republish`            | `{operationId, revision, channelId}`                                                                      |
| POST   | `/api/publications/:id/reconcile`            | `{revision, resolution: "delivered" \| "not_delivered", confirmed: true, messageId?}`                     |
| GET    | `/api/scheduled`                             | Active jobs first, UTC timestamps and delivery state; `offset` pagination                                 |
| POST   | `/api/scheduled/:id/cancel`                  | `{operationId, revision}`                                                                                 |
| POST   | `/api/scheduled/:id/reschedule`              | `{operationId, revision, runAt, timezone}`                                                                |
| GET    | `/api/operations/:id`                        | Read an operation without sending again                                                                   |

`channelId` is the Studio channel record UUID, not an arbitrary Telegram chat ID. Publications have separate channel/message references, allowing the same saved revision in multiple approved channels. Every send/edit/republish validates the existing serializer and owner-registered media; delete can retain and remove an old message with an unsupported legacy snapshot. Live `getFile`, `getChat`, `getMe`, bot posting rights and owner administrator access are checked before delivery. Approval is rechecked immediately before the send transition. Ten distinct media references per delivery is a **Studio operational cap**, not a Telegram limit. No token-bearing media URLs or paid broadcasts are used.

## Delivery safety and scheduling

Migration `0003_publishing.sql` adds `publications`, `publishing_operations`, `cli_nonces`, `scheduler_state` and execution columns on existing jobs. It preserves old published message IDs/snapshots and pauses legacy schedules as `legacy_review`; explicitly reschedule reviewed jobs. Migration `0004_uncertain_delivery_guard.sql` extends active source locks to uncertain outcomes so fresh IDs cannot bypass reconciliation. No reset or replacement database is required. Revisions/snapshots remain archived in operations after editing/deleting source content.

Operations and jobs use compare-and-swap claims with three-minute leases. A unique source/revision/channel key blocks repeat normal publication; republishing and independently created schedules are deliberate copy intents. Active source constraints and publication revision locks prevent simultaneous delivery/mutation. The configured Cron is once a minute, UTC, but **does no work unless `SCHEDULER_ENABLED=true`**. Each invocation processes at most one due job, a conservative starting budget for Cloudflare; it is not a high-throughput or second-precision scheduler. Expired preparation is safely reclaimable. Definitive transient provider rejections (429/5xx) back off with the same operation, honor retry_after and stop after five scheduled attempts. Permanent validation, approval or permission failures do not auto-retry.

Telegram sends and D1 commits cannot be atomic. A timeout, malformed confirmation, expired sending lease or lost database completion can mean a delivered message without a receipt. These become **uncertain** and are never automatically resent. Read the existing operation, inspect Telegram, then record an owner-confirmed outcome in Published. This is manual observation, not programmatic Telegram verification. For a confirmed delivery provide its message ID; for uncertain edit/delete confirm the action itself. If the outcome cannot be established, leave it uncertain. Deletion/edit limitations and changed permissions can prevent subsequent actions. This system does not promise exactly-once delivery.

## Legacy Phase 3 CLI compatibility

The preserved CLI commands require **Python 3.12+** and use the standard library; the advanced bot requires the new Python dependencies. It uses UTF-8 JSON, TLS certificate validation, bounded responses, a timeout and no redirect following. It is designed for Linux, Windows and Termux; only Linux/Python 3.12 was tested here. `.env.example` documents variables but is not automatically loaded. Supply them from a private shell/password-manager environment:

- Worker secret `CLI_AUTH_SECRET`: a separate cryptographically random 64-character hex secret (never the bot token).
- Worker variable `CLI_ALLOWED_ACTIONS`: defaults to `read`; optionally `read,preview,publish` after reviewing write privileges. No channel approval, schedule writes, editing or deletion is exposed to the CLI.
- Local `K9_API_URL=https://k9-pb.kimshikano.workers.dev`.
- Local `K9_CLI_SECRET`: the same private CLI secret. Never put it in frontend variables, command arguments, source or shared output.

```sh
python bot.py --help
python bot.py doctor
python bot.py status
python bot.py channels
python bot.py posts
python bot.py scheduled
python bot.py preview POST_UUID
python bot.py publish POST_UUID CHANNEL_RECORD_UUID
# Read the outcome of an uncertain request without resending:
python bot.py status --operation-id OPERATION_UUID
# Only retry known safe rate/transient failures using the original UUID:
python bot.py publish POST_UUID CHANNEL_RECORD_UUID --operation-id OPERATION_UUID --revision SAVED_REVISION
```

Write commands fetch the saved revision, validate through the same Worker business service and print an operation ID. Network errors are not proof of failure: retain that ID and inspect its status, never invent a new UUID to bypass uncertain delivery. Rotate the CLI secret to revoke all controllers; previously recorded replay nonces remain harmless. Clock synchronization is required.

CLI requests use only `/api/cli/*`, never bypass normal Mini App authentication. Headers are `X-K9-Timestamp` (Unix seconds), `X-K9-Nonce` (32 lowercase hex characters), `X-K9-Signature` (64 lowercase hex HMAC). Signature input is the UTF-8 string `timestamp + "\n" + nonce + "\n" + METHOD + "\n" + originalPathAndQuery + "\n" + SHA256(rawBody)`; the key is the UTF-8 secret text. Requests expire after 60 seconds with 60 seconds future skew allowance. D1 atomically reserves valid signed nonces; replays fail 401. The strict scope whitelist is enforced after signature verification. The server supplies the configured owner context, then applies the same ownership/channel/validation rules. Missing/placeholder secrets fail 503. Possession of this separate scoped credential is sensitive owner authority.

## Telegram commands

The existing webhook remains the only receiver. Owner private `/start` and `/studio` launch the Mini App; `/help`, `/status`, `/channels`, `/posts` and `/scheduled` return bounded programming-themed workspace summaries. Non-owner/group messages never reveal private data. Read-only `k9:status` and inert preview callbacks are acknowledged; no callback publishing workflow is implemented. Media registration and update deduplication remain intact. To receive callbacks, inspect and, only with explicit approval, update the existing webhook's allowed_updates to `["message", "callback_query"]`. Do not register a competing receiver or discard pending updates. Phase 3.1 can explicitly transfer reception to Python through its confirmed runtime-fence workflow.

## Test-channel acceptance and deployment gates

See [DEPLOYMENT.md](DEPLOYMENT.md) for account/binding verification, remote migration inspection, private D1 backup and approval steps. Keep the scheduler disabled and CLI read-only until a dedicated test channel has passed live acceptance. Obtain explicit authorization for each live-send test; do not use a production audience as a test destination.

1. Confirm configured bot identity, owner identity, existing webhook and BotFather Mini App URL privately; verify fresh owner auth and non-owner rejection.
2. Inspect remote migration state, back up D1 and approve/apply only pending migrations. Pin the actual existing D1 UUID. Review the exact code/version and approve deployment.
3. Connect a dedicated channel through the Mini App with explicit owner approval. Verify bot/owner admin rights and no unapproved destinations.
4. With approval, send a private test containing Unicode, table, details, styled URL/callback buttons and registered small media. Inspect actual Telegram Rich Message rendering and inert callbacks.
5. Publish to the dedicated channel, verify message ID/link, inspect D1 receipt, then edit, republish and delete with confirmed provider results and preserved history.
6. Grant only necessary CLI scopes and verify doctor/read commands, approved preview/publish, invalid signature, expiry and replay rejection. Keep secrets out of screen captures.
7. Approve scheduler enablement; test UTC/Yangon scheduling, cancellation/rescheduling, snapshot isolation and changed permissions. Mocked timeout/retry tests do not prove real network behavior.
8. Test native Telegram Android, Myanmar IME, media compatibility, session expiry/recovery and mobile scrolling. Large-video and hosted API acceptance remain live-only gaps.

Rollback: disable scheduling first, reconcile in-flight operations, record deployment/version and back up new ledger data. Roll back the Worker to the last reviewed version with approval; retain additive tables/columns and migration tracking. An older Worker ignores the new ledger, so do not start old pending delivery logic blindly. Never DROP tables or restore a whole database merely to roll back code. A database restore can lose new receipts and cause duplicate delivery; it requires a separate maintenance plan. Preserve secret versions and coordinate any webhook secret rollback privately.
