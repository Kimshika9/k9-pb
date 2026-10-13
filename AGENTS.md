# K9 Post Studio engineering instructions

## Scope and stack

- React + TypeScript + Vite, Tailwind, Cloudflare Workers with the official Vite plugin, D1 migrations, maintained Telegram Mini Apps SDK (`@tma.js/sdk-react`), Telegram HTTP Bot API.
- Phase 1 authentication/dashboard and Phase 2 rich editing/drafts/templates/media are implemented. Publishing, live Telegram preview, callback workflows and scheduling are Phase 3: do not implement or run them without a new request.
- Keep the app at the repository root. Keep Worker, UI, shared contracts, and database migration concerns separate.

## Security boundaries

- Every `/api/*` endpoint must authenticate raw Telegram initData server-side, verify HMAC and freshness, then enforce `OWNER_TELEGRAM_ID`.
- Never trust initDataUnsafe or SDK-parsed identity, use browser auth overrides, or add public signup.
- Invalid auth is 401, valid non-owner is 403, missing configuration is 503. Do not return upstream details or internal SQL errors.
- Keep all credentials in Cloudflare secrets and local ignored `.dev.vars`. Never place secrets in `VITE_*` values or commit/log launch data, tokens, IDs from real accounts, or webhook secrets.
- Webhook requests require `X-Telegram-Bot-Api-Secret-Token`; only the owner in the owner's private chat receives `/start` responses or registers media. Never register non-owner/group media.
- Future publish/edit/retry paths must call `requireApprovedChannel` immediately before sending, check current Telegram permissions, and prevent revoked destinations from receiving content.
- Do not deploy, apply remote migrations, register webhooks, or create remote resources without explicit user authorization.
- The Cloudflare Worker target is `k9-pb`; D1 is resolved by the existing `k9-post-studio` database name. Never restore a fake database UUID. `npm run deploy` includes remote migrations, and Cloudflare Builds must use `npm run deploy:ci` after its build step. Keep deployment authorization separate from credential availability; never claim a live URL without verifying the remote deployment.

## Quality and data

- Maintain strict TypeScript including tests. Use parameterized D1 queries, transactional batches for multi-table mutations, SQL checks and indexes, and additive migrations once deployed.
- Preserve signed Unicode data exactly for authentication. Keep frontend navigation, dialogs, and controls accessible on mobile, respect safe areas and reduced motion.
- Keep empty/error/loading states functional. Label Phase 3 capabilities honestly; avoid fake analytics or fake publishing controls.
- Run `npm run check`; run local migrations for schema changes. Tests use Node 24 SQLite and isolated Telegram mocks.
- Update README and deployment/security documentation for API, schema, configuration, and security changes.

## Phase 2 editor boundaries

- Structured content lives in `shared/editor`; version 2 documents have stable UUIDs. Use strict runtime validation for every draft/template request and reject unsupported fields/cycles/depth/size violations.
- Preserve the distinction between structurally valid incomplete drafts and complete Telegram export payloads. Never serialize editor IDs, ownership, revisions or metadata into Telegram API fields.
- Use the verified official Bot API 10.3 wire mappings. Media blocks contain InputMedia objects, captions are rich caption objects, details use `summary`, and ordered lists specify `value`/`type`. Link button style is callback-only; enforce 1–64 UTF-8 callback bytes and at most 8 buttons per row.
- Keep editor application limits explicitly labeled as Studio limits; do not invent undocumented Telegram maxima. Review docs/TELEGRAM_RICH_MESSAGES.md before changing serializer fields.
- Draft writes and delete operations require current revisions. On conflict, preserve local work and offer reload/copy/backup; never auto-overwrite.
- New resource access must match the configured owner. Legacy owner-null records belong to the single-owner workspace and remain intact. Add migrations; never reset or replace migration 0001.
- Media IDs must come from authenticated owner webhook events or verified same-bot getFile responses. Preserve canonical IDs on repeated registration. No token-bearing file URLs, direct browser uploads or channel sends in Phase 2.
- Use Tiptap structured content and safe React rendering. Do not persist raw editor HTML or use unsafe HTML injection. Keep mobile selected-block properties inline and toolbar controls touch-friendly.
- Run the full Phase 1 and Phase 2 suite, strict type check, lint and production build after substantive changes. Keep screenshots/test reports clearly labeled as local synthetic validation; native Telegram and live Bot API acceptance remain separate checks.
