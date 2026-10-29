# K9 Post Studio

Private, owner-only Telegram Mini App for managing advanced channel posts. **Phase 1** provides authentication, dashboard, channel approval and the bot launch flow. **Phase 2** adds the visual rich editor, persistent drafts, templates, media selection and validated Telegram JSON export. **Phase 3** adds approved rich publishing, private Telegram previews, published-message management, UTC scheduling and the signed Python companion. **Phase 3.1** adds a real advanced Python Telegram bot with an explicit, confirmed polling mode and shared backend bridge. The approved production rollout is deployed; live owner authentication and Telegram acceptance remain unverified.

## Run locally

Requires Node.js **24+** (tests use Node's built-in SQLite), npm, and a Telegram bot from BotFather.

```sh
npm ci
cp .env.example .dev.vars
# Replace all placeholders in .dev.vars with your real local configuration.
npm run db:migrate:local
npm run dev
```

Open the printed local URL to see the Telegram access screen. To use the authenticated dashboard, expose the local Vite server through a trusted HTTPS tunnel, set `MINI_APP_URL` to that URL, and register it with BotFather. Open through the bot's private `/start` launch button or its configured Mini App. Telegram authenticates the raw launch data; there is no browser login or development bypass. Use a separate development bot: a bot has only one webhook at a time. Never share signed launch URLs or tunnel credentials.

In restricted cloud workspaces, use `npm_config_cache=/tmp/k9-npm-cache` for npm and `XDG_CONFIG_HOME=/tmp/k9-config WRANGLER_SEND_METRICS=false` for Wrangler/Vite if the default home directories are read-only.

## Verification

```sh
npm run test       # Authentication, Worker APIs, SQL constraints, webhook, client, UI
npm run typecheck  # Strict TypeScript: frontend, Worker, shared models, tests, config
npm run lint
npm run build     # Production frontend + Worker using the official Cloudflare Vite plugin
# Or all four:
npm run check
```

The backend test harness executes the actual SQL migration against isolated in-memory SQLite. Telegram HTTP calls are mocked; no tests contact your bot or production D1. UI mocks exist only in test files. Local Wrangler migration and HTTP smoke checks validate Cloudflare integration separately.

## Structure

```text
src/
  App.tsx                     Existing dashboard shell, channels and verified profile
  editor/                    Rich editor, draft/template workspace, builders, preview and media picker
  components/                Channel approval dialog, dashboard presentation components
  lib/api.ts                 Same-origin authenticated API transport
  lib/telegram.ts            Telegram SDK initialization and raw initData retrieval
  index.css                  Tailwind + responsive dark dashboard styles
worker/
  index.ts                   Private API router and error boundary
  env.ts                     Worker-only bindings and secrets
  lib/auth.ts                HMAC, freshness, validated identity, owner restriction
  lib/channels.ts            Permission checks, approval, revocation, audit trail
  lib/http.ts                JSON limits, safe errors, no-store responses
  lib/telegram.ts            Telegram HTTP Bot API abstraction
  lib/webhook.ts             Secret verification, private /start, durable deduplication
  lib/editor-store.ts        Draft/template persistence and optimistic concurrency
  lib/media.ts               Owner media APIs and private webhook registration
shared/
  contracts.ts               Frontend/Worker data contracts
  editor/                    Versioned document model, Zod validation, immutable operations, samples, serializer
  rich-message.ts            Public editor/serializer exports
migrations/0001_foundation.sql
  posts, channels, templates, media, history, scheduled_jobs, webhook_updates
migrations/0002_editor.sql
  Additive owner, revision and media metadata fields; no data reset
tests/                      Auth, API, SQL, webhook, Telegram and frontend tests
docs/                       Deployment, security and Bot API 10.3 research
```

This repository was scaffolded with **create-cloudflare 2.73.4**, `--framework=react --variant=react-ts --no-deploy`, using the official React Workers-with-assets template. Scaffold files were placed at the repository root. npm's lockfile pins the installed versions.

## API contract

Mini App private endpoints require `Authorization: tma <raw Telegram initData>` on **every request**. Only the explicitly scoped `/api/cli/*` and `/api/bridge/*` namespaces use separate signed controller/bot credentials described in [Phase 3](docs/PHASE3.md) and [the Python bot guide](docs/PYTHON_BOT.md). Missing, forged, expired, or malformed credentials return **401**; a correctly signed non-owner returns **403**. Missing server configuration returns **503**. Responses are `Cache-Control: no-store` and error responses use `{ "error": { "code": "...", "message": "..." } }`.

| Method | Endpoint            | Behavior                                                                                                          |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/profile`      | Verified owner profile                                                                                            |
| GET    | `/api/dashboard`    | Counts, eight recent posts, channel list                                                                          |
| GET    | `/api/channels`     | Up to 100 channels including revoked approvals                                                                    |
| POST   | `/api/channels`     | `{ "chatId": "@channel_or_-100_id", "approved": true }`; verifies bot and owner channel administrator permissions |
| DELETE | `/api/channels/:id` | Revokes approval, cancels pending/running jobs, returns scheduled posts to draft                                  |
| POST   | `/telegram/webhook` | Telegram secret header required; only owner `/start` in owner's private chat produces a launch button             |

The protected Phase 2 endpoints below extend this contract. Publishing and scheduling routes are owner-protected as documented below; no signup or public profile endpoints exist. Public static files contain only the application shell and product copy. No private data is bundled into the frontend. Channel reads are capped at 100; pagination should precede supporting larger workspaces.

## Credentials and deployment

Production execution status (2026-10-21): the approved rollout completed. All five production D1 migrations are applied; Worker version `ac2668e1-f6ca-42a3-8818-c2e116a57095` was deployed at 100% with the Python bridge, preserved bindings, all approved bridge scopes and automatic publishing disabled. A later live unsigned bridge check returned the expected **401 `INVALID_BRIDGE_AUTH`**, clearing the earlier 503 configuration-format blocker at that route. The owner's signed Python request is still rejected; use the safe device diagnostic below to distinguish stale local settings/exported overrides, clock errors and signature mismatch. Actual owner HMAC/identity agreement remains unverified. See the [rollout record](docs/PRODUCTION_ROLLOUT.md). Do not rerun completed migrations or rebuild the older GitHub main branch.

`.env.example` contains placeholders only. Use `.dev.vars` locally and **Cloudflare secrets** remotely for `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `MINI_APP_URL`. Never use `VITE_` prefixes for these values, commit local variable files, or log initData.

Follow [deployment instructions](docs/DEPLOYMENT.md) only after explicit deployment confirmation. Production is <https://k9-pb.kimshikano.workers.dev/>. The Worker is `k9-pb`, with binding `DB` to the existing `k9-post-studio` database. Pin its verified UUID in `wrangler.jsonc` before deployment; no fake UUID or automatic resource provisioning is permitted. `npm run deploy` builds and deploys; **remote migrations are a separate, approved operation after backup**. Cloudflare Builds uses `npm run build` and `npm run deploy:ci`, with a verified `CLOUDFLARE_ACCOUNT_ID`. Pushing `main` may trigger deployment and therefore also requires approval during recovery. Passing a local build does not establish production readiness.

If Telegram shows **“The studio is not configured yet”**, check the production Worker's runtime secrets, especially `TELEGRAM_BOT_TOKEN` and `OWNER_TELEGRAM_ID`. This error occurs before database queries. Secret names in build settings do not automatically become Worker runtime secrets. See [the recovery audit and exact setup steps](docs/RECOVERY_AUDIT.md); do not replace configured credentials blindly or expose them through frontend variables.

For Python `INVALID_AUTH`, check the public bridge route first: `python check_k9_backend.py` needs no credentials or dependencies. Expected unsigned response is **401 `INVALID_BRIDGE_AUTH`**; **401 `INVALID_AUTH`** indicates old/misrouted backend code. On 2026-10-29, GitHub main still pointed to the older Phase 2 commit; direct production verification is currently blocked by the cloud environment proxy. The corrected backend/bot source is available on [the recovery branch](https://github.com/Kimshika9/k9-pb/tree/codex/bridge-recovery-20261029); it has not been merged or deployed by this follow-up. Do not infer that replacing the bridge secret will fix this route mismatch.

For Python `INVALID_BRIDGE_AUTH`, use `python bot.py --diagnose-bridge` to check the actual `.env` path, exported overrides, timestamp/header versus HMAC rejection and approximate device/server clock difference without displaying credentials. See [bridge diagnostics](docs/PYTHON_BOT.md#diagnose-a-bridge-rejection-without-sharing-credentials). This performs no publishing or receiver changes; it does not automatically repair secret agreement.

Read [security notes](docs/SECURITY.md) and [official Bot API 10.3 research](docs/TELEGRAM_RICH_MESSAGES.md).

## Phase 2 usage and APIs

Open **Posts** to create, search and restore drafts. **Templates** includes four samples and your reusable layouts. Select a block to edit its properties, use **Preview** to inspect the post, and **Telegram JSON** to download a validated payload. Drafts autosave after 1200 ms; stale revisions return 409 and preserve local changes for recovery.

The app warns two minutes before its 15-minute Telegram session expires. Session recovery survives reloads; optionally enable **Keep unsaved recovery on this device** for recovery across sessions (up to seven days). Expired copies are rejected and removed when accessed; browser storage cannot erase them while the app is closed. Recovery contains private post content, never initData or credentials. It is offered only after authenticating and opening the corresponding server draft. Restore explicitly; stale recovery retains its old revision and offers copy/reload rather than silently overwriting. Successful saves remove recovery. Device storage is optional and can be unavailable; download Backup before closing Telegram when needed. Button labels use plain Unicode text; formatting and hyperlinks belong in post text and the button's action field.

| Method             | Endpoint                    | Behavior                                                                        |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------- |
| GET / POST         | `/api/drafts`               | Paginated title search (`q`, `offset`) / create `{title, document, channelId?}` |
| GET / PUT / DELETE | `/api/drafts/:id`           | Restore / save `{title, document, revision, channelId?}` / delete `{revision}`  |
| POST               | `/api/drafts/:id/duplicate` | Create a copy with fresh content IDs                                            |
| GET                | `/api/drafts/:id/export`    | Validated `{rich_message: InputRichMessage}` or 422 issues                      |
| GET / POST         | `/api/templates`            | Samples and custom layouts / create `{name, document}`                          |
| PATCH / DELETE     | `/api/templates/:id`        | Rename `{name, revision}` / delete `{revision}`                                 |
| GET / POST         | `/api/media`                | Owner library (`kind`, `offset`) / verify and register `{fileId, kind, name}`   |

Send photos/videos/documents to the bot's private chat, refresh the editor media picker, then select the registered ID. Existing same-bot IDs can be checked through `getFile`. Previews use placeholders, not credential-bearing Telegram URLs. Studio supports registration up to 10 MB for photos and 20 MB for videos/documents; native uploads and large-video acceptance remain unverified.

Apply `npm run db:migrate:local` to your existing local D1 before running the upgraded Worker. Migrations 0002–0005 add editor fields, publishing records and a receiver fence while preserving existing data. Preserve `.dev.vars` and the existing database; no reset or new project is needed.

Read [the Phase 2 editor guide and Phase 3 tasks](docs/PHASE2_EDITOR.md), [verification results](docs/VERIFICATION.md), and [Telegram wire-schema research](docs/TELEGRAM_RICH_MESSAGES.md). Captured local screenshots: [desktop editor](docs/screenshots/phase2-editor-1440.png), [mobile editor](docs/screenshots/phase2-editor-390.png), [desktop preview](docs/screenshots/phase2-preview-1440.png), [mobile preview](docs/screenshots/phase2-preview-390.png).

## Remaining live acceptance and future work

- Hosted Bot API Rich Message acceptance and dedicated test-channel preview/publish/edit/delete verification.
- Production account/secrets/binding/migration verification and approved rollout; current local tests do not repair absent production secrets.
- Business callback workflows, higher-throughput scheduling budgets and long-term audit/nonce retention policies.
- Native Telegram Android testing, Myanmar IME/clipboard, download behavior and verified media kind/size compatibility.
- Legacy import, larger template pagination, audit viewer and media/webhook retention lifecycle.

## Phase 3 publishing and Python

Open a saved draft for **Send Test Preview**, confirmed **Publish Now**, or UTC/Yangon **Schedule Post**. **Published** manages receipts, editing copies, republishing, deletion and manual uncertain-delivery reconciliation. **Scheduled** manages pending jobs and safe retries. Automatic delivery remains disabled unless explicitly configured.

The executable root [bot.py](bot.py) requires Python 3.12+ and [Python dependencies](requirements.txt). In **Python mode** it is a real python-telegram-bot Application with interactive owner-private commands and polling. In **Cloudflare mode** it preserves the Worker webhook and starts no polling. Both use the existing Worker business services; mode switching requires explicit confirmation. The former CLI commands remain available for compatibility. See [the full Phase 3 guide](docs/PHASE3.md) for commands, API contracts, state/lease semantics, configuration, test-channel checklist and rollback. Additive migration [0003_publishing.sql](migrations/0003_publishing.sql) and the uncertainty-lock migration 0004 are applied locally only; remote migration state is unverified.

New implementation: `worker/lib/publishing.ts`, `publishing-routes.ts`, `scheduler.ts`, `cli-auth.ts`, `bot-commands.ts`; shared contracts in `shared/publishing.ts`; UI in `src/editor/PublishingPanel.tsx` and `DeliveryWorkspace.tsx`. Sources/drafts remain separate from per-channel publication snapshots. Telegram delivery and D1 completion are not atomic; uncertain sends require inspection and never blindly retry.

```sh
python -m py_compile bot.py
python -m pytest
npm run format:check
```

[Verification results](docs/VERIFICATION.md) distinguish automated tests, local browser/Worker tests and unperformed real Telegram/production checks.

## Run the advanced Python Telegram bot

Use the reviewed workspace containing Phase 3.1; a fresh main clone does not yet contain these uncommitted changes. The signed bridge and migration 0005 must be rolled out with approval before live use. Configure the separate Worker K9_BRIDGE_SECRET and permitted scopes, preserving existing secrets/D1.

```sh
pip install -r requirements.txt
python bot.py
```

First run collects hidden-input credentials, validates getMe and the signed Worker bridge, stores ignored private `.env`, and continues to real polling. A verified active K9 webhook gets a one-time explicit takeover confirmation; another integration is preserved. Later runs start directly without repeating setup or mode switching. Startup checks all required backend scopes and D1 readiness, preserves settings on failure and names exactly what must be fixed before retrying the same command.

No package/path configuration is needed: all internal `k9bot` modules ship with the repository. Configuration and webhook backups live beside `bot.py`. Keep Python running for reception; stop with Ctrl+C. Optional maintenance: `--setup`, `--check`, and `--restore-cloudflare` (after stopping Python, with explicit restoration confirmation). Publishing, rendering, owner auth and shared D1/Cron remain in the existing Worker.

See [the complete Python bot guide](docs/PYTHON_BOT.md) for all 16 commands, dashboard workflows, setup variables, scoped bridge APIs, Termux/Windows instructions, restoration/rollback and remaining live acceptance checks.
