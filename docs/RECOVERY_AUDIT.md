# Recovery audit and production status

Audit date: 2026-10-13. Repository: `Kimshika9/k9-pb`. Reviewed baseline commit: `a1e4cb6`. Production supplied by the owner: <https://k9-pb.kimshikano.workers.dev/>. This report describes local repairs, not a completed production recovery.

## Root cause and evidence

The original `requireAuthConfig` runs before signature verification and before any D1 query. It throws `503 NOT_CONFIGURED` if `TELEGRAM_BOT_TOKEN` is absent/empty or `OWNER_TELEGRAM_ID` fails its numeric positive safe-integer checks. Consequently, the reported dashboard message points to **Worker runtime authentication configuration**, not editor rendering or SQL migrations. A nonempty wrong bot token alone would instead fail signature verification. The URL and webhook secret are separate bot-operation dependencies.

The exact deployed secret at fault **cannot be identified from source alone**. Cloudflare secrets cannot be decrypted through their metadata API. In this execution environment Cloudflare and Telegram credential variables are missing, and Wrangler reports `loggedIn: false`. Read-only HTTP requests to the public root and private paths all returned **403 text/plain**, not the application's JSON error. Those responses do not establish an owner-auth rejection, schema failure or the reported 503; the provider/network refusal remains undiagnosed. No production signed data was requested, captured or printed.

All four exact names must exist in the existing Worker's runtime settings: `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `TELEGRAM_WEBHOOK_SECRET`, `MINI_APP_URL`. The URL must be `https://k9-pb.kimshikano.workers.dev/`. Build-time values, frontend environment variables and local `.dev.vars` do not establish production runtime configuration. Follow the [exact dashboard and rollout instructions](DEPLOYMENT.md).

## Findings and repairs

| Area                    | Finding                                                                                                        | Repair / remaining status                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication          | Token check accepted placeholders; padded numeric owner IDs could pass configuration but fail owner comparison | Reject malformed/padded token and noncanonical owner IDs; preserve HMAC, 900-second freshness, 30-second skew, 401/403 boundaries                |
| Missing storage binding | Valid owner requests could hit a generic internal error when DB was absent                                     | Controlled owner-authenticated `503 STORAGE_NOT_CONFIGURED`; no public configuration endpoint                                                    |
| Session UX              | No early warning; unsaved edits lost across reload/closure                                                     | Two-minute warning; session recovery, optional seven-day device recovery, explicit restore and revision-safe copy/reload; backup fallback        |
| Client transport        | Malformed error JSON and successful SPA HTML could cause confusing failures                                    | Typed sanitized API errors; reject non-JSON successful API responses                                                                             |
| Telegram transport      | Null/malformed upstream envelopes could escape the client's controlled error handling                          | Reject invalid envelopes; disallow redirects; preserve timeouts and sanitized failure messages                                                   |
| Webhook media           | Media registration preceded update leasing                                                                     | Shared D1 update deduplication before media work; completion/failure tied to lease                                                               |
| Rich button labels      | Rich label toolbar allowed marks Telegram's InlineButton schema excludes                                       | Plain Unicode label input; export rejects any formatting/link marks without deleting old drafts                                                  |
| Legacy templates        | One unsupported saved document could fail the complete catalog and workspace load                              | Preserve the raw row, return valid templates plus an unavailable count; show a warning; no destructive conversion                                |
| Draft listing           | Negative offsets silently clamped                                                                              | Reject malformed/negative offsets as 400                                                                                                         |
| Deployment              | Deployment automatically applied SQL and could provision missing resources                                     | Guard existing Worker/database target, require pinned real D1 UUID and explicit account, disable provisioning, separate remote migration command |
| Mobile                  | Table remove controls were too small; hyperlink removal could lose its selection after URL-input focus         | 44-pixel mobile targets; link selection restored; expiry/recovery notices wrap; Chromium overflow checks passed                                  |

## Preserved architecture and schema

The project remains React/TypeScript/Vite/Tailwind with the official Cloudflare Vite plugin, Worker API, D1 and Telegram SDK. No project rewrite, auth bypass, public signup, new provider, publishing, scheduler or callback business workflow was added. The existing secret-preservation settings, same-origin mutations, 64 KiB bodies, owner filtering, approved channels, strict structured editor validation and optimistic revisions remain.

Both migrations match the queries: channels, templates, posts (including drafts), media, history, scheduled_jobs and webhook_updates. Migration 0002 supplies ownership, revisions and media metadata/indexes. **No new migration or reset is needed for these source repairs.** Local Wrangler reports no pending migrations; SQLite tests execute both schemas. Production pending state, data volume, D1 UUID and backups are unknown until authorized read-only account inspection. Never treat that local result as production migration status.

All block types, add/edit/clone/delete/reorder, formatted paragraphs, lists, code, tables, details, media selection, button actions, preview, exports, drafts and templates have local tests. JSON field mappings were checked against current official Telegram source. Exact table/details/media fields remain unchanged; only the incompatible button-label validation was corrected. Hosted sendRichMessage acceptance was not tested and no channel post was sent.

## Production gates

| Check                                                  | Status                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Account and active Worker/version/build commit         | Unverified: no Cloudflare access                                             |
| Runtime secret names/presence/validity                 | Unverified; operator must inspect privately                                  |
| GitHub Builds repository/main/build/deploy settings    | Documented; dashboard state unverified                                       |
| API routed through Worker instead of SPA               | Verified locally; production HTTP blocked from this environment              |
| D1 target UUID, migration state, backup                | Unverified; deploy preflight stops without a pinned existing UUID            |
| Real owner Mini App HMAC and dashboard                 | Unverified: no real owner launch credentials                                 |
| getMe, getWebhookInfo, BotFather configuration, /start | Unverified: no bot credentials; mock regression tests pass                   |
| Private media registration with real Telegram          | Unverified; synthetic secure webhook and mocked getFile tests pass           |
| Native Telegram Android/keyboard/large media           | Unverified; Chromium mobile widths are an approximation                      |
| Production writes in this recovery                     | None: no deploy, push, secret write, remote migration or webhook replacement |

## Explicit remaining actions

1. Privately inspect runtime secrets in **Workers & Pages → k9-pb → Settings → Variables and Secrets**; preserve existing valid values and use the exact names and owner ID format documented in DEPLOYMENT.md. Fixing a secret is a production mutation and requires approval.
2. Obtain secure, scoped account access for read-only Worker/D1 diagnostics; verify active Git commit and build settings, binding `DB`, existing database name/UUID and pending migrations. Pin that verified UUID in the reviewed code. Do not create a new database/Worker to bypass access problems.
3. Prepare a private backup/Time Travel bookmark and record previous deployment/configuration. Obtain approval for identified pending SQL separately from deployment. If both migrations are already applied, leave them alone.
4. Review local source changes and tests. Obtain approval before pushing main or deploying. Cloudflare Builds must run `npm run build` and `npm run deploy:ci`; remote SQL is never embedded in that deploy command.
5. Inspect getMe/getWebhookInfo and BotFather's existing Mini App/menu URL. Preserve the webhook when correct; seek separate approval before replacement or secret rotation.
6. Run real acceptance: fresh owner /start and launch, dashboard data, draft save/reopen/conflict, template save/reuse and private media picker. Test unsigned/forged/expired 401, authentic non-owner 403 and invalid webhook 401 without capturing signed data or secrets. Native rendering and provider acceptance remain separate gates.

Rollback source through the previously verified Cloudflare deployment version, with approval; retain additive schema columns. Restore database data only under a separately approved restore plan because it can discard newer writes. Credential/webhook rollback must be coordinated privately. See [DEPLOYMENT.md](DEPLOYMENT.md) for commands.

## Changed files

Worker: `worker/index.ts`, `worker/lib/auth.ts`, new `worker/lib/config.ts`, `worker/lib/webhook.ts`, `worker/lib/telegram.ts`, `worker/lib/editor-store.ts`. Shared: new `shared/auth.ts`, `shared/editor/telegram.ts`. UI: `src/App.tsx`, `src/lib/api.ts`, new `src/lib/session.ts`, `src/editor/ButtonsBuilder.tsx`, `src/editor/DraftEditor.tsx`, `src/editor/PostsWorkspace.tsx`, `src/editor/RichTextEditor.tsx`, new `src/editor/recovery.ts`, `src/index.css`. Deployment: `package.json`, new `scripts/deploy.mjs`. Tests: `tests/helpers.ts`, `tests/editor-api.test.ts`, `tests/editor-model.test.ts`, `tests/editor-ui.test.tsx`, `tests/richtext-ui.test.tsx`, `tests/webhook.test.ts`, `tests/telegram.test.ts`, new `tests/config.test.ts`, `tests/recovery.test.ts`, `tests/api-client.test.ts`. Documentation: `README.md`, `AGENTS.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY.md`, `docs/TELEGRAM_RICH_MESSAGES.md`, `docs/VERIFICATION.md`, this report, and four `docs/screenshots/recovery-*.png` local synthetic captures.
