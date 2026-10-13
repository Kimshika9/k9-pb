# K9 Post Studio

Private, owner-only Telegram Mini App for managing advanced channel posts. **Phase 1** provides authentication, dashboard, channel approval and the bot launch flow. **Phase 2** adds the visual rich editor, persistent drafts, templates, media selection and validated Telegram JSON export. Publishing and scheduling remain Phase 3 work.

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

Private endpoints require `Authorization: tma <raw Telegram initData>` on **every request**. Missing, forged, expired, or malformed credentials return **401**; a correctly signed non-owner returns **403**. Missing server configuration returns **503**. Responses are `Cache-Control: no-store` and error responses use `{ "error": { "code": "...", "message": "..." } }`.

| Method | Endpoint            | Behavior                                                                                                          |
| ------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/profile`      | Verified owner profile                                                                                            |
| GET    | `/api/dashboard`    | Counts, eight recent posts, channel list                                                                          |
| GET    | `/api/channels`     | Up to 100 channels including revoked approvals                                                                    |
| POST   | `/api/channels`     | `{ "chatId": "@channel_or_-100_id", "approved": true }`; verifies bot and owner channel administrator permissions |
| DELETE | `/api/channels/:id` | Revokes approval, cancels pending/running jobs, returns scheduled posts to draft                                  |
| POST   | `/telegram/webhook` | Telegram secret header required; only owner `/start` in owner's private chat produces a launch button             |

The protected Phase 2 endpoints below extend this contract. There are no publishing, scheduling, signup or public profile endpoints. Public static files contain only the application shell and product copy. No private data is bundled into the frontend. Channel reads are capped at 100; pagination should precede supporting larger workspaces.

## Credentials and deployment

`.env.example` contains placeholders only. Use `.dev.vars` locally and **Cloudflare secrets** remotely for `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TELEGRAM_WEBHOOK_SECRET`, and `MINI_APP_URL`. Never use `VITE_` prefixes for these values, commit local variable files, or log initData.

Follow [deployment instructions](docs/DEPLOYMENT.md) only after explicit deployment confirmation. The database UUID in `wrangler.jsonc` is a local placeholder; replace it with the created D1 database ID before deployment. No cloud resources were created and nothing was deployed as part of implementation.

Read [security notes](docs/SECURITY.md) and [official Bot API 10.3 research](docs/TELEGRAM_RICH_MESSAGES.md).

## Phase 2 usage and APIs

Open **Posts** to create, search and restore drafts. **Templates** includes four samples and your reusable layouts. Select a block to edit its properties, use **Preview** to inspect the post, and **Telegram JSON** to download a validated payload. Drafts autosave after 1200 ms; stale revisions return 409 and preserve local changes for recovery.

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

Apply `npm run db:migrate:local` to your existing local D1 before running the upgraded Worker. Migration 0002 only adds columns and indexes. Preserve `.dev.vars` and the existing database; no reset or new project is needed.

Read [the Phase 2 editor guide and Phase 3 tasks](docs/PHASE2_EDITOR.md), [verification results](docs/VERIFICATION.md), and [Telegram wire-schema research](docs/TELEGRAM_RICH_MESSAGES.md). Captured local screenshots: [desktop editor](docs/screenshots/phase2-editor-1440.png), [mobile editor](docs/screenshots/phase2-editor-390.png), [desktop preview](docs/screenshots/phase2-preview-1440.png), [mobile preview](docs/screenshots/phase2-preview-390.png).

## Phase 3 TODOs

- Real Telegram preview, owner-approved channel publishing/editing and hosted Bot API 10.3 acceptance tests.
- Recheck approved channels and live Telegram permissions at every send/edit/retry; retain message IDs and sanitized failures.
- Callback workflows, durable scheduling, retries, cancellation, idempotency and timezone handling.
- Native Telegram Android testing, Myanmar IME/clipboard, download behavior and verified media kind/size compatibility.
- Legacy import, larger template pagination, audit viewer and media/webhook retention lifecycle.
