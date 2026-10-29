# Setup and deployment

**Recovery is read-only in production until explicit approval.** Do not push to a deployment-connected main branch, deploy, write secrets, apply remote migrations, change webhooks, or create resources before approval. Local setup and tests do not require a Cloudflare account.

Current execution status (2026-10-21): the owner-approved Time Travel-backed rollout completed. All five migrations and the prepared Worker/frontend are deployed; version `ac2668e1-f6ca-42a3-8818-c2e116a57095` serves 100%. Bridge scopes and disabled scheduling are verified, with existing secrets/DB preserved. The frontend returns 200, but private routes return `503 NOT_CONFIGURED`, meaning the encrypted bot token or owner ID fails format validation. Correct these runtime values privately; metadata cannot reveal their contents. See the [rollout/rollback record](PRODUCTION_ROLLOUT.md). Do not rerun completed SQL or deploy older GitHub main. No Telegram webhook changes or live sends occurred.

## Local setup

1. Install Node 24+ and run `npm ci`.
2. Create a separate development bot with BotFather. Obtain its token and your own numeric Telegram user ID through a trusted Telegram source.
3. Copy `.env.example` to `.dev.vars` and replace all placeholders. Generate a webhook secret without printing it into shared logs, for example write `openssl rand -hex 32` into your local password manager. `.dev.vars` is ignored.
4. Run `npm run db:migrate:local`, then `npm run dev`.
5. Use a trusted HTTPS tunnel for Telegram, configure the development bot's Mini App URL in BotFather, and set the same URL in local `MINI_APP_URL`. The webhook must reach that tunnel's `/telegram/webhook` route. Register only after authorization for the bot/tunnel you own.
6. Send `/start` to the bot **in your private chat** and tap the Mini App button. The authenticated dashboard will be empty until channels are connected. Reloading an old URL does not refresh Telegram's signed auth timestamp; relaunch after 15 minutes.

Credentials are required for live auth and Telegram permission checks. A normal browser visit only shows the public access screen. Never place local credentials in a frontend env file.

## Production preparation (after confirmation)

The existing target is **`k9-pb`**, URL **`https://k9-pb.kimshikano.workers.dev/`**, D1 binding **`DB`**, database **`k9-post-studio`**. Do not create replacements. The verified existing database UUID is pinned in `wrangler.jsonc`; confirm it still matches production before deploying. The deploy wrapper refuses an absent/invalid ID and disables resource provisioning.

Authenticate Wrangler in a local terminal, or securely provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the cloud execution environment. The token must belong to the intended account and allow **Workers Scripts: Edit**, **D1: Edit**, and **Account Settings: Read**. A token held by Cloudflare Builds is not automatically available in a separate Codex workspace. Never paste tokens in chat or commit them.

For read-only diagnostics, use the production account's credentials and inspect metadata only:

```sh
npx wrangler whoami
npx wrangler secret list --name k9-pb
npx wrangler deployments list --name k9-pb
npx wrangler d1 list
npx wrangler d1 info DB --json
npx wrangler d1 migrations list DB --remote
```

Verify the account and D1 UUID/name against the existing dashboard binding, then pin only that database UUID. Secret list reveals names, not values or validity. Never dump credential files or signed launch data. In **Deployments → active version → build details**, compare its Git commit with the exact reviewed repair commit; a working frontend does not prove that the current backend is deployed.

## Repair runtime secrets in Cloudflare Dashboard (after approval)

1. Open the production account → **Workers & Pages → k9-pb → Settings → Variables and Secrets**.
2. Inspect the existing names before adding anything. Preserve valid entries. Add/edit **encrypted runtime secrets**, not frontend/build variables:

| Exact name                | Required value                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`      | The existing bot's actual token from BotFather, without quotes, whitespace or placeholder text. Never generate a substitute.                                                             |
| `OWNER_TELEGRAM_ID`       | Your own positive numeric Telegram user ID; not the bot ID, chat ID or username. No leading zeros, spaces, quotes or scientific notation.                                                |
| `TELEGRAM_WEBHOOK_SECRET` | The existing configured webhook secret, matching Telegram's secret-token header; preserve it unless a coordinated rotation is approved. 32–256 characters, using only `A-Z a-z 0-9 _ -`. |
| `MINI_APP_URL`            | `https://k9-pb.kimshikano.workers.dev/`                                                                                                                                                  |

3. Save/deploy the configuration change only after approval. Never delete unrelated variables/secrets. If a hidden value's validity is uncertain, compare privately with the owner's secure source; Cloudflare metadata cannot reveal it.
4. Confirm **Settings → Bindings** has a D1 binding named exactly `DB`, pointing to the existing `k9-post-studio` database and verified UUID.
5. Relaunch from Telegram's bot button with fresh initData. Once auth configuration is valid, unsigned requests must return JSON **401**, rather than 503 or HTML. Verify the signed owner request returns 200. A syntactically valid wrong/revoked bot token produces signature/Telegram failures; the local token-shape check does not prove it is the correct token.

`keep_vars` preserves dashboard variables; Wrangler also preserves omitted secrets. No secrets belong in `wrangler.jsonc` or `VITE_*` variables. Missing URL/webhook configuration affects bot launch/media handling independently of the dashboard auth guard.

## D1 backup, pending migrations and approved rollout

Phase 3 adds `0003_publishing.sql` and `0004_uncertain_delivery_guard.sql`; Phase 3.1 additionally requires 0005_python_bridge.sql for its bridge/receiver control. Preserve all five migrations. Its additive tables retain legacy messages and pause old jobs for review. The full five-migration chain is applied and verified in production as of the rollout above; recheck the ledger before any future SQL write. Drafts are records in `posts` with `status='draft'`; there is no separate drafts table. Inspect pending state and schema with read-only queries before any writes:

```sh
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npx wrangler d1 execute DB --remote --command "PRAGMA table_info(posts)"
npx wrangler d1 execute DB --remote --command "PRAGMA table_info(templates)"
npx wrangler d1 execute DB --remote --command "PRAGMA table_info(media)"
```

Prepare an approved backup export into private storage (keep output and download links out of shared logs):

```sh
umask 077
mkdir -p /tmp/k9-production-backups
npx wrangler d1 export DB --remote --output /tmp/k9-production-backups/pre-phase3.sql
```

Check the backup is nonempty and preserve it securely outside the checkout; record the Cloudflare Time Travel bookmark if available, current deployment/version and migration state. If migration tracking and schema disagree, stop: do not rerun CREATE/ALTER statements blindly or mark migrations applied without a plan.

After explicit approval for the identified pending migrations, apply them separately:

```sh
npm run db:migrate:remote
```

No pending migrations means no migration write is necessary. Do not reset D1. Then obtain approval for the reviewed code/configuration deployment, set the verified `CLOUDFLARE_ACCOUNT_ID`, and run:

```sh
npm run check
npm run format:check
npm run deploy:check
npm run deploy
```

`deploy:check` checks the pinned repository target without deploying; the actual deploy also requires an explicit account ID. `npm run deploy` builds then invokes guarded `deploy:ci`. It never applies remote SQL or provisions resources. Do not push main or press Retry Build until this rollout is approved.

Rollback: use Cloudflare **Deployments → previous verified version → Rollback**, with owner approval. Disable scheduling before rollback; retain all additive tables/columns, receipts and migrations when rolling code back. Reconcile in-flight delivery before any database restore. Do not drop columns/tables as a code rollback. A database restore can lose new writes and needs a separate approved maintenance/restore plan from the private export/Time Travel bookmark. Restoring a Worker version does not reliably restore prior secret values; preserve credential versions privately and coordinate any webhook-secret rollback with Telegram.

## Cloudflare Builds settings

For the Git-connected **`k9-pb`** Worker, open **Settings → Build** and use:

| Setting           | Value               |
| ----------------- | ------------------- |
| Repository        | `Kimshika9/k9-pb`   |
| Production branch | `main`              |
| Root directory    | `/`                 |
| Build command     | `npm run build`     |
| Deploy command    | `npm run deploy:ci` |
| Node.js           | 24 or newer         |

Set the verified `CLOUDFLARE_ACCOUNT_ID` in build settings and pin the existing D1 UUID in the reviewed repository config. The guarded deploy command deliberately does **not** apply migrations. Apply pending SQL separately only after backup and approval. Build access is distinct from Worker runtime configuration: production secrets belong under the Worker's **Settings → Variables and Secrets**. A build token need not grant D1 edit if it only deploys an existing binding; use an appropriately scoped D1 token for approved schema work.

If a build fails after "Success: Build command completed", inspect its final deployment error. No missing credential, account, binding or preflight requirement should be bypassed to obtain a green build. During this recovery the build pipeline settings and active production commit remain unverified without account access.

## Register the webhook (also requires authorization)

First use read-only `getMe` and `getWebhookInfo` through a private script/password-manager environment, and inspect BotFather's **Bot Settings → Configure Mini App** and menu-button configuration for the existing bot. The app origin must be `https://k9-pb.kimshikano.workers.dev/`; expected webhook URL is `https://k9-pb.kimshikano.workers.dev/telegram/webhook`. Do not log full upstream bodies or token-bearing request URLs; report only verified match/failure statuses. No real Telegram configuration was accessible during recovery.

Preserve the existing webhook if it already matches. Replacement and secret rotation require separate explicit approval. Only then call Telegram's `setWebhook` with `url`, `secret_token`, and `allowed_updates: ["message", "callback_query"]`. Use a local script with secrets loaded from your password manager/secure environment, not pasted into shell command history. Example Python script (read values via `getpass`):

```python
import getpass, json, urllib.request
bot_token = getpass.getpass('Bot token: ')
webhook_secret = getpass.getpass('Webhook secret (same Cloudflare secret): ')
app_url = input('HTTPS Mini App URL: ').strip().rstrip('/')
request = urllib.request.Request(
    'https://api.telegram.org/bot' + bot_token + '/setWebhook',
    data=json.dumps({
        'url': app_url + '/telegram/webhook',
        'secret_token': webhook_secret,
        'allowed_updates': ['message', 'callback_query'],
    }).encode(),
    headers={'Content-Type': 'application/json'}, method='POST',
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    print('Webhook registered' if result.get('ok') else 'Registration failed')
except Exception:
    # Do not print the exception: Telegram request URLs contain the bot token.
    print('Registration failed; check configuration privately.')
```

Choose a fresh random secret of at least 32 characters, using only `A-Z a-z 0-9 _ -`. Do not set `drop_pending_updates` casually; it discards queued updates. Switching a bot's webhook replaces its previous integration. Prefer separate bots for development and production.

## Live acceptance checks

- Owner private `/start` produces an **Open K9 Post Studio** web_app button.
- Non-owner `/start` and group commands produce no response.
- Missing/forged/expired auth returns 401; valid non-owner auth returns 403.
- Webhook requests with missing/wrong secret return 401.
- Dashboard data comes from D1; channels require explicit approval, owner admin rights, and bot posting permission.
- Revoking approval removes the destination and cancels pending jobs.
- Phase 3 sends require explicit approved test-channel authorization; scheduler remains disabled until separately enabled after acceptance.

Live acceptance checks need real credentials, an HTTPS Telegram launch URL, a configured bot and Cloudflare account. They cannot be completed by local mocks. Inspect logs only with redaction; do not capture initData or token-bearing Telegram URLs. Back up D1 before future schema upgrades; prefer additive migrations and explicit rollback plans.

## Phase 3 runtime controls

After reviewing and approving the rollout, preserve all four existing runtime secrets. Add a **separate encrypted `CLI_AUTH_SECRET`**, preferably 64 random hex characters generated privately. Set `CLI_ALLOWED_ACTIONS=read` initially; grant `preview,publish` only when the controller should have these owner powers. Set `SCHEDULER_ENABLED=false` initially. Configure these as Worker runtime values, never frontend variables or a build dotenv artifact. Set only the local Python process `K9_API_URL` and `K9_CLI_SECRET`; Python has no deployment resource.

`wrangler.jsonc` includes a one-minute UTC Cron trigger. Disabling the flag stops automatic sends without deleting schedules. Migrations 0003 and 0004 must precede the new Worker; `npm run deploy:ci` never applies it. Existing legacy jobs remain in review and require explicit rescheduling. Inspect Cloudflare account limits and queue load before increasing throughput; current implementation processes one due job per invocation.

The existing webhook must include callback_query only after explicit approval; preserve its URL, secret and pending updates. Deployment does not change reception. Phase 3.1 can deliberately switch reception only through the explicitly confirmed bot.py workflow. Check BotFather URLs privately. Complete [the test-channel checklist](PHASE3.md#test-channel-acceptance-and-deployment-gates) before enabling Cron or using real audience channels. No production migration, secret write, webhook change or deployment was performed during implementation.

## Phase 3.1 Python receiver rollout and rollback

Read [PYTHON_BOT.md](PYTHON_BOT.md). Inspect and back up remote D1 before obtaining explicit approval for migration 0005; it only adds bot_runtime and bridge_rate_limits. Deploy the reviewed code without resetting bindings/data or changing Telegram reception. An empty fence defaults to Cloudflare, so the existing webhook remains functional. Missing bridge migration fails closed for bot API requests.

Preserve CLI_AUTH_SECRET and all existing runtime secrets. Add a separate encrypted K9_BRIDGE_SECRET and start with K9_BRIDGE_ALLOWED_ACTIONS=read. Grant only the needed preview/publish/schedule/cancel/media/create/runtime scopes after reviewing owner authority. Configure matching private Python .env values; no bot credentials go in VITE variables. Normal python bot.py automatically performs these checks and verifies the current identity endpoint’s effective bridgeActions. --check remains an optional read-only utility.

Only a separately approved receiver confirmation offered by normal startup or optional maintenance changes an active webhook, backed by a D1 transition fence, explicit terminal confirmation and saved private webhook metadata. Stop Python before restoration; getWebhookInfo cannot reveal the original webhook secret, so restore with the existing Worker secret entered privately. Never drop pending updates. To roll back code, restore and verify Cloudflare reception while the new bridge remains available, then roll back the Worker with approval. Preserve all additive tables/receipts/history; do not restore/reset D1 to undo code. Receiver mode and scheduled Cron publishing are separate controls.
