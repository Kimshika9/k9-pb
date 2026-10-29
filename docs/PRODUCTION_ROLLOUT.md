> Latest follow-up (2026-10-21): the public bridge now returns expected 401 `INVALID_BRIDGE_AUTH` for an unsigned request, so the earlier 503 format blocker no longer occurs there. The owner still reports a signed bridge rejection. Use the updated Python `--diagnose-bridge` to identify the config source/override and timestamp-versus-HMAC failure; actual owner authentication remains unverified. No screenshot credentials were used or rotated and no further deployment/SQL/webhook change occurred during diagnosis. The rollout record below preserves the state at its original verification time.

# Production rollout checkpoint — 2026-10-21

The owner explicitly approved the five migrations, prepared Worker deployment and Time Travel recovery baseline. **Database migrations and code deployment are complete. Live owner use remains blocked by an invalid runtime authentication value.** Do not replay completed SQL or request deployment approval for work already completed. The workspace remains uncommitted; remote main is older and must not be rebuilt as a recovery step. A main push needs separate approval.

## Current execution status

- Fresh preflight matched the existing Worker/account/D1, preserved source/settings, and captured a Time Travel bookmark before schema changes. Recovery records remain private outside the checkout under `/workspace/.k9-private/rollout`.
- All five migrations were applied and verified. Required tables are present and foreign-key checks passed. At schema verification, posts/channels/templates/media/jobs/publications had zero rows. No migration was replayed during the final deployment.
- Official OAuth approval included the previously missing `workers_scripts:write` scope. `npm run deploy` built successfully, uploaded Worker/assets and deployed triggers. Active version **`ac2668e1-f6ca-42a3-8818-c2e116a57095`** serves **100%** of traffic at <https://k9-pb.kimshikano.workers.dev/>.
- Authorized post-deployment inspection verified bridge/HMAC, receiver fence and publishing code; preserved original bindings and encrypted credentials; exact existing D1 UUID and Mini App URL; all five migration names; all eight bridge scopes; and `SCHEDULER_ENABLED=false`. Static assets and fetch/scheduled handlers are present.
- Public checks: frontend **200**; unsigned bridge identity and Mini App profile both **503 JSON `NOT_CONFIGURED`**. This is a remaining blocker, not a successful owner-authentication test. No live Telegram sends, polling receiver, webhook changes or scheduling activation occurred.
- Earlier complete local checks passed: 88 Python tests, 195 frontend/backend tests, compilation, TypeScript, lint, build and formatting. The deployment also rebuilt successfully.

## Remaining runtime correction

The deployed `requireAuthConfig` returns `NOT_CONFIGURED` when `TELEGRAM_BOT_TOKEN` or `OWNER_TELEGRAM_ID` fails format validation. Cloudflare confirms both encrypted entries exist but cannot reveal their values or which one is invalid. The updated bridge is present; the old missing-bridge routing problem is resolved at the source/deployment level, while valid private authentication remains unverified.

In **Workers & Pages → k9-pb → Settings → Runtime variables and secrets → Production**, privately replace the affected values from the owner's trusted configuration:

- `TELEGRAM_BOT_TOKEN`: the actual BotFather token, identical to local Python `BOT_TOKEN`. Paste the value alone, without `BOT_TOKEN=`, quotes, spaces or line breaks. Expected shape: positive numeric bot ID, colon, then at least 30 letters/digits/underscores/hyphens. Do not invent a token or rotate a working one to repair formatting.
- `OWNER_TELEGRAM_ID`: the owner's positive numeric Telegram user ID, identical to local Python `OWNER_ID`. Digits only, no username, key name, quotes, spaces or leading zeros; within JavaScript's safe integer range. Do not use the bot ID.

Save/deploy the runtime settings update while preserving all other bindings/secrets. Do not retry the older GitHub build. Then recheck unsigned bridge/profile routes: expect 401 `INVALID_BRIDGE_AUTH` / `INVALID_AUTH`, rather than 503. Run the owner's `python bot.py` to verify actual signed bridge authentication, bot/owner agreement, D1 readiness and runtime receiver checks. Never paste credentials in chat. `K9_BRIDGE_SECRET` must still match privately on both sides; value agreement is not yet tested.

`TELEGRAM_WEBHOOK_SECRET` is absent. Python polling does not require it; Cloudflare webhook reception/restoration does. Preserve any existing Telegram webhook until the separately confirmed receiver workflow. Do not enable scheduling or send posts merely to test configuration.

## Recovery baseline and backup options

The official D1 SQL export job completed, but download from Cloudflare's R2 storage host was blocked by this environment's egress policy. A private SQL backup has **not** been downloaded or restore-verified. An alternative official recovery baseline is now available: `wrangler d1 time-travel info DB --json` succeeded and its nonempty bookmark was captured privately before any schema changes. This is a Cloudflare-managed recovery checkpoint, not a downloaded SQL dump or a tested production restore. The application database is independently confirmed empty.

The owner authorized using a fresh Time Travel checkpoint for the verified empty database, and that checkpoint was captured before the completed migration stage. Before any further schema operation, inspect the current ledger/data rather than assuming the old empty-schema baseline. A database restore remains a separate approved action because it can discard subsequent writes.

A configuration draft adds only `1ad59b064bfa3690063414a9906129e4.r2.cloudflarestorage.com` to the existing custom network rules, preserving other rules/presets. Review/save and publish the environment to activate it. The draft save itself does not change running networking. Do not print signed export URLs or expose backup data.

If a downloaded SQL backup is preferred, activate the network draft and download the official export with verified TLS and a separate HTTP client that does not forward the Cloudflare OAuth header to the signed storage URL. Keep SQL outside the checkout with restrictive permissions. Check its size/hash and restore it into a disposable local database; verify that the inspected empty application baseline matches. Refresh the export if the baseline or link has changed. Do not describe the blocked SQL download as completed.

## Approved plan — retain for deployment and verification

1. Recheck account, Worker, bound database UUID/name, runtime settings and current schema. Stop if another operator initialized or changed the database; reconcile its migration ledger instead of replaying SQL blindly.
2. Completed: applied `0001_foundation.sql`, `0002_editor.sql`, `0003_publishing.sql`, `0004_uncertain_delivery_guard.sql`, `0005_python_bridge.sql` with the approved fresh Time Travel baseline. Verify the ledger on resume and skip already applied SQL. Never reset the database or erase migration history.
3. Deploy the reviewed local Worker/frontend with `npm run deploy` and the verified account ID supplied securely. The deploy guard disables resource provisioning, preserves runtime variables/secrets and does not apply SQL. Do not push main as an incidental deployment step.
4. Grant the intended bot bridge scopes explicitly: `K9_BRIDGE_ALLOWED_ACTIONS=read,preview,publish,schedule,cancel,media,create,runtime`. This permits the documented owner-validated bot operations, not arbitrary chats or browser authentication bypasses. Keep `SCHEDULER_ENABLED=false` until separate test-channel acceptance and approval. Preserve all existing credentials and the `DB` binding.
5. Verify runtime metadata after deployment and run the owner's private `python bot.py --check`. Ordinary unsigned browser requests must receive controlled 401 JSON; genuine owner Mini App launch must authenticate. Verify same-bot/owner identity, bridge HMAC, D1 health and all required scopes with real private settings. Do not generate fake Telegram authentication for live tests.
6. The owner's normal `python bot.py` handles any existing expected webhook through its explicit one-time confirmation and backup/fence workflow. Do not change Telegram webhook settings as part of the Worker deployment. Keep callback/media/private-chat checks intact. Do not send a live preview/channel post or enable scheduling without the appropriate owner's instruction.

## Rollback

Preserve the previous Worker deployment and private code/settings baseline. If Python reception has begun, stop it gracefully and inspect uncertain deliveries before changing receiver mode. Restore Cloudflare reception only through its separately approved workflow and with a correctly configured matching webhook secret. Then roll back code through a verified previous Cloudflare deployment with approval.

Keep the additive database tables, migration ledger and new runtime secrets. Do not drop tables or restore the database as a code rollback. Any database/Time Travel restore needs a separate approved plan because it can discard writes made after rollout. Keep scheduling disabled and reconcile uncertain external actions before considering retries. Preserve the original empty-schema checkpoint and private backup for that review.
