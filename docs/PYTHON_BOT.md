# K9 advanced Python Telegram bot — Phase 3.1

`bot.py` is now a real **python-telegram-bot 22.8** Application with owner-private command, callback, text and media handlers. Python mode receives updates through polling, displays an HTML/inline-keyboard dashboard and calls the existing Cloudflare Worker for all persistent operations. HTTPX signs bridge requests; python-dotenv loads private configuration. The React editor, D1 database, rich renderer, publication records and Cloudflare scheduling engine remain shared.

These changes exist in the current workspace, alongside uncommitted Phase 3/recovery code. Remote `main` was checked and still points to `a1e4cb6`; do not assume a fresh clone contains these files. Review and publish the complete change set only with deployment approval, since a main push can trigger Cloudflare Builds.

## Install once, then start

Requires Python **3.12+** and the complete reviewed checkout, including the bundled `k9bot` directory. No separate package installation or import-path setup is needed. From that directory:

```sh
pip install -r requirements.txt
python bot.py
```

On first run, missing settings launch a four-field wizard: existing Bot Token (hidden), numeric owner ID, Web App URL (press Enter for the K9 default), and matching private Worker bridge secret (hidden). It checks getMe, saves an ignored `.env` beside `bot.py` atomically with 0600 permissions where supported, and continues automatically. Windows uses its normal file ACLs. Hidden-input echo fallback is refused. Existing unrelated settings are preserved; correcting an existing invalid file asks before replacement.

The same run checks signed Worker connectivity, matching bot/owner/Web App identity, actual D1 health and all required bridge scopes. If a verified K9 webhook is active it explains the conflict and asks once for `SWITCH PYTHON`. It saves restoration metadata, transfers reception safely and starts the real PTB bot in that run. An unrelated webhook is never removed. If no webhook exists, it records the requested Python receiver through the secure backend without changing Telegram webhook settings.

Later runs load the saved settings and start directly, without the wizard or mode confirmation when the backend remains in Python mode and no webhook has reappeared. Interrupted transitions need explicit confirmation; another running Python process is never taken over. Settings and webhook backups are located beside the script even if it is launched from another directory.

If backend setup is incomplete, startup names the missing secret, binding, migration, permission or endpoint, preserves credentials and stops before polling. Fix that backend requirement with the appropriate approval, then retry **the same `python bot.py` command**. It never substitutes fake data or prints Running while the bot is unavailable. The supplied backend must be configured; a local installer cannot silently deploy a Worker or grant itself permissions.

Successful startup prints:

```text
K9 ADVANCED BOT
━━━━━━━━━━━━━━━━━━━━━━
Bot        : Connected
Owner      : Verified
Web Studio : Connected
Backend    : Ready
Database   : Available
Runtime    : Python
━━━━━━━━━━━━━━━━━━━━━━
Status     : Running
```

The banner appears after polling starts. Keep the process running for Telegram reception; Ctrl+C shuts it down gracefully. Advanced handlers, D1 state, media, rich publishing and Cloudflare Cron are unchanged. An isolated virtual environment is optional if required by your Python installation; it is not a project packaging step.

The ignored `.env` uses:

| Name               | Meaning                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ |
| `BOT_TOKEN`        | Same existing BotFather token as Worker `TELEGRAM_BOT_TOKEN`                         |
| `OWNER_ID`         | Same numeric owner as Worker `OWNER_TELEGRAM_ID`; no usernames or bot IDs            |
| `WEB_APP_URL`      | `https://k9-pb.kimshikano.workers.dev/`                                              |
| `API_BASE_URL`     | `https://k9-pb.kimshikano.workers.dev`                                               |
| `K9_BRIDGE_SECRET` | Separate private random secret matching the encrypted Worker secret of the same name |
| `BOT_RUNTIME_MODE` | Saved preference; normal bot startup selects Python after any required confirmation  |

Exported environment variables take precedence over `.env`. The bridge secret must be 32–256 characters in `A-Z a-z 0-9 _ -`; use a distinct random 64-character hex value. It is not the bot token or old CLI credential. It must be configured privately on the Worker after approval; the wizard does not invent or provision it. `--check` reads getMe/getWebhookInfo and private backend identity, runtime and health; it checks bot/owner/Web App agreement. It never calls setWebhook/deleteWebhook. Signed reads update nonce/rate-limit bookkeeping, not workspace content or receiver configuration.

### Diagnose a bridge rejection without sharing credentials

For `INVALID_AUTH` (the Mini App authentication error), check the deployed route before editing credentials. Open `https://k9-pb.kimshikano.workers.dev/api/bridge/identity` in a normal browser, or use the standalone standard-library check:

```sh
python check_k9_backend.py
# Optional: check the same origin printed by --diagnose-bridge:
python check_k9_backend.py https://your-worker.workers.dev
```

No configuration or Python dependencies are needed for this public check. Expected healthy unsigned response: **401 `INVALID_BRIDGE_AUTH`**. A **401 `INVALID_AUTH`** means that origin routes bridge requests into Mini App authentication, which requires the current bridge Worker deployment or correcting `API_BASE_URL`. Changing the bridge secret cannot fix that routing. A 503, HTML error, redirect or blocked request does not establish a code rollback. The script never follows redirects, prints upstream response bodies, reads/sends credentials or changes state. A successful public probe verifies route availability only, never owner authentication or secret agreement.

If `INVALID_BRIDGE_AUTH` persists after editing settings, run:

```sh
python bot.py --diagnose-bridge
```

This optional diagnostic uses the same configuration and signed identity GET as normal startup. It prints the absolute `.env` path, whether an exported `K9_BRIDGE_SECRET` overrides it, and whether the exported/saved values differ, without printing either value, token, signature or owner ID. An IDE or terminal export can keep using an old secret even after the correct `.env` was edited. Correct/remove that override privately; do not delete the entire settings file.

The Worker has two rejection stages: `Controller signature is missing, malformed or expired` rejects timestamp/header validation before HMAC comparison; `Controller signature verification failed` means timestamp/header formats passed but the signature did not match. These are now distinguished in Python errors. A TLS response `Date` header supplies an approximate server-minus-device clock difference when available. It is diagnostic only: neither the signing timestamp nor the 60-second server expiry is adjusted. Enable automatic date/time on a device with incorrect time; timezone selection alone does not repair clock skew.

The command performs no publication, polling, webhook change or local settings write. Successful signed GETs reserve D1 replay/rate-limit bookkeeping and the backend identity route calls Telegram `getMe`. Identity agreement is checked before reporting success; full normal startup still checks backend capabilities, database and receiver state. Share only the diagnostic text, never `.env` contents or Cloudflare value screenshots.

If a screenshot has exposed a bot token or bridge secret, revoke the bot token through BotFather and generate a new bridge secret privately. Update both local/Worker copies and use encrypted Cloudflare runtime **Secret** entries. Re-encrypting the same exposed value does not revoke it. Do not change webhook reception or rotate credentials automatically as part of diagnosis.

## Two explicit receiver modes

**Cloudflare reception:** the existing Worker webhook is the 24/7 Telegram receiver until a confirmed takeover. Normal `python bot.py` offers that takeover as part of startup; diagnostic/restore utilities and the previous management CLI remain optional. Existing Worker command/media behavior is preserved. Cloudflare does not host a permanently running Python polling process.

**Python mode:** the Python Application handles the advanced Telegram menus. A PC/Termux/server process must stay running. Cloudflare still owns the publishing APIs, D1 and scheduled delivery through Cron. Closing Python stops Telegram command reception until Python restarts or Cloudflare mode is explicitly restored; it does not stop approved Cloudflare scheduled jobs.

Before changing reception, review the consequences and have the existing Worker webhook secret available privately. Stop a running Python receiver with Ctrl+C before switching.

```sh
# Normal usage, including any first-time receiver confirmation:
python bot.py
# Stop Python with Ctrl+C first; optional restoration maintenance:
python bot.py --restore-cloudflare
# Confirm SWITCH CLOUDFLARE and enter the existing Worker webhook secret privately.
```

`--setup` can repair local settings and `--check` performs diagnostics without changing the webhook. Legacy `--run` remains an alias for normal startup and `--switch-mode` remains an optional administrator utility; none is needed for ordinary use. After restoration, Cloudflare remains online without Python. Running `python bot.py` again deliberately requests Python reception and asks for takeover confirmation if the K9 webhook is active.

Mode switching verifies both bot identity and current webhook before any mutation. A different integration URL or an unexportable custom certificate blocks takeover. Known URL/max_connections/allowed_updates and observed IP metadata are saved to ignored `.k9-webhook-backup.json` with private permissions. Telegram does not expose the webhook secret or certificate: restoration requires the actual existing Worker secret. Observed DNS IP is retained for diagnosis but not forced on restoration, so Cloudflare DNS can resolve current addresses. Empty allowed_updates is preserved rather than silently narrowed. Pending updates are never deliberately dropped.

The Worker first enters durable `transition` state, pausing its webhook and denying polling leases. Only after Telegram confirms removal/restoration and getWebhookInfo verifies it does the bridge finalize Python/Cloudflare mode. Successful switching updates BOT_RUNTIME_MODE in an existing private `.env`; update any exported override too. PTB bootstrap is guarded: startup **never deletes an existing webhook**, even though ordinary PTB polling bootstrap normally does so.

Python reception requires a unique two-minute D1 lease, renewed every 20 seconds. Another Python process cannot claim it; mode changes are rejected while it is active. The fence and webhook are checked before each long poll, using the server’s remaining lease budget minus request elapsed time rather than trusting the client wall clock. Enough lease time must remain for the poll. Loss of authorization, lease or receiver state stops polling. Safe update-read network/rate errors use PTB retry behavior; publication writes are not automatically retried. Shutdown stops reception, drains the Application, closes clients and releases its lease. After a crash, wait for expiry before takeover. In-flight external requests cannot be recalled and are not promised exactly once.

An interrupted or uncertain webhook switch leaves the fence in transition when completion is unknown. Inspect Telegram/Worker privately, then rerun `python bot.py`; it detects the incomplete transition and asks for a separately confirmed recovery using the saved backup. Optional `--check` remains read-only. Do not delete pending updates, guess a replacement secret, force another poller or disable the fence to resolve it.

## Dashboard, commands and guided workflows

Send `/start` in the owner's **private** bot chat. The dashboard provides Open Web Studio, Create Post, Post Manager, Channels, Scheduled Posts, Media Library, System Status, Settings and Help. Menus transition using edit_message_text; Back/Home/Refresh/Cancel work. Inline actions are bound to their current message and a random menu epoch, expire after ten minutes and are invalidated after a click or new command. Restarted/forwarded/stale menus require `/start`. Lists and channel choices paginate without skipping records. A preview callback only acknowledges a test; it runs no business workflow.

Commands: `/start`, `/help`, `/studio`, `/status`, `/channels`, `/posts`, `/drafts`, `/published`, `/scheduled`, `/templates`, `/media`, `/preview`, `/publish`, `/schedule`, `/cancel`, `/settings`. ID-based actions guide the owner through selection keyboards; no IDs need memorization. Unauthorized/group commands do not access the backend. Unauthorized callbacks receive a generic private-workspace denial.

- **Create Post:** send title, then paragraph text. A real structured draft is stored in D1. Open Web Studio to add rich formatting/layout. Templates create real drafts from the same editor documents with regenerated content IDs.
- **Drafts:** saved Web App drafts appear after Refresh. Select one to privately preview or choose an approved channel. Before displaying Publish confirmation, the Worker validates serializer completion, registered media and current bot/owner posting permissions; it checks again when sending. Confirm Publish is the only menu action that sends a channel post.
- **Published:** view actual status, message ID, sanitized error and recent history. Editing/deletion/republishing and uncertain-delivery reconciliation remain in the existing Web Studio manager; bridge scopes do not grant those mutations.
- **Schedule:** choose a draft/channel, send `YYYY-MM-DD HH:MM Asia/Yangon` or `YYYY-MM-DD HH:MM UTC`, then confirm. UTC conversion and backend future/revision validation apply; the saved snapshot is captured. Cloudflare Cron must be enabled separately. Cancel a pending/definitively failed job through its confirmation menu; uncertain/in-progress deliveries are not silently cancelled or retried.
- **Media:** send a photo/video/document privately. The bot extracts canonical file/unique IDs and metadata; the Worker verifies same-bot getFile identity/size and upserts the existing D1 library. Refresh the Web App picker to see it. Studio caps are 10 MB photos and 20 MB videos/documents; large-video/native uploads remain live-only checks. No token-bearing download URLs or unrelated local database exists.
- **Mini App:** the launch button uses official `InlineKeyboardButton(web_app=WebAppInfo(...))`. Telegram provides signed initData and the existing Worker still authenticates it; the Python bot adds no browser authentication override.

Writes use stable operation IDs and saved revisions. Completed publishing receipts must have confirmed Telegram message IDs. Repeated clicks become stale; server idempotency and uncertainty locks protect against fresh IDs too. Confirmed rate/transient rejection exposes a manual retry using the original ID. Unconfirmed/time-out delivery instead offers **Inspect operation**, never an automatic or blind new send. Python does not implement a second rich serializer or publishing service.

## Scoped bridge and production preparation

Migration `0005_python_bridge.sql` adds only `bot_runtime` and `bridge_rate_limits`; it preserves all existing data. An empty runtime table means Cloudflare mode. Old Workers without migration 0005 continue their existing webhook behavior; bridge use fails closed until the migration is installed. Do not edit/reset migrations 0001–0004.

After account/binding verification, backup and explicit rollout approval:

1. Apply only inspected pending migrations, including 0005, to the existing DB. Keep its UUID and binding `DB`.
2. Deploy the reviewed Worker code; preserve all existing bot, owner, webhook, Mini App and CLI secrets. Add encrypted `K9_BRIDGE_SECRET`, never a VITE/build credential.
3. Set Worker `K9_BRIDGE_ALLOWED_ACTIONS=read` initially. Needed optional scopes are `preview,publish,schedule,cancel,media,create,runtime`; grant only intended powers. The full bot needs `read,preview,publish,schedule,cancel,media,create,runtime`. Default read-only mode cannot switch/poll or write.
4. Keep SCHEDULER_ENABLED as previously approved. Receiver mode does not grant or disable Cron publishing. Preserve allowed_updates; inspect BotFather Mini App URL and existing webhook without replacing them as part of deployment.
5. Run `python bot.py` with genuine private credentials to complete one-time setup/startup. The bridge identity endpoint must return the current effective `bridgeActions` so startup can verify all required permissions. Obtain approval for a dedicated test channel and any mode switch/live send; use that channel for actual rendering/media/preview/publish checks.

`/api/bridge/*` uses its own secret and the existing canonical HMAC protocol: timestamp, nonce, method, original path/query and SHA-256 of raw UTF-8 body. Expiry is 60 seconds with bounded clock skew. Constant-work comparisons and D1 nonce reservation reject forged, modified and replayed requests. Normal Mini App `/api/*` still requires Telegram initData; CLI credentials cannot authenticate bridge/browser routes. Durable limits are 120 GET and 30 POST requests per owner/minute; preflight checks and lease renewals count in the POST budget. Missing bridge migration/configuration fails closed. HTTPX does not follow redirects, limits response size and retries only safe reads with new signatures/nonces. Logs omit tokens, signed requests, update bodies and exception URLs.

| Bridge route (prefix `/api/bridge`)                                                         | Scope / behavior                                                            |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GET `/identity`, `/runtime`, `/doctor`, `/status`                                           | read; privately verify configured identities/state                          |
| GET `/drafts`, `/drafts/:id`, `/posts`, `/posts/:id`, `/templates`, `/channels`, `/media`   | read; shared owner resources                                                |
| GET `/publications`, `/publications/:id`, `/scheduled`, `/scheduled/:id`, `/operations/:id` | read; private status/history/queue                                          |
| POST `/drafts`                                                                              | create; existing strict editor schema                                       |
| POST `/posts/:id/check`                                                                     | read; content/media/permissions preflight, no send                          |
| POST `/posts/:id/preview`, `/publish`, `/schedule`                                          | corresponding scope; existing publishing services and approved destinations |
| POST `/scheduled/:id/cancel`                                                                | cancel; current revision required                                           |
| POST `/media/register`                                                                      | media; same-bot file/unique ID and size verification                        |
| POST `/runtime`, `/runtime/lease`                                                           | runtime; confirmed transition, revision checks and lease guards             |

Channel approval/revocation, arbitrary-chat sending, template mutation, publication editing/deletion and production secret access are outside bridge privileges. Credential holders have the configured scoped owner's authority; an owner ID alone is never accepted as proof. Rotate a compromised bridge secret only through a separately approved private procedure, preserving the legacy CLI secret.

## Termux and Windows

After the reviewed Phase 3.1 files are available locally or in an approved published Git commit:

```sh
# Termux, supported Python >=3.12:
pkg update
pkg install python git
# Clone only after the approved code is on the chosen branch:
git clone https://github.com/Kimshika9/k9-pb.git
cd k9-pb
python --version
pip install -r requirements.txt
python bot.py
```

Keep Termux running and consider Android battery restrictions; the process is not a Cloudflare-hosted service. Termux wake locks/device startup are optional owner choices, not provisioned here. Stop with Ctrl+C; optional `python bot.py --restore-cloudflare` restores the 24/7 webhook with explicit confirmation. On Windows use a virtualenv in PowerShell and the same commands; if activation is restricted, call `.venv\Scripts\python.exe bot.py`. Native Android/Termux/Windows execution was not performed here.

## Telegram startup connection errors

**`INVALID_AUTH: Telegram authentication is required` during Python bridge startup:** the request has reached the Mini App authentication guard. Verify `API_BASE_URL` targets the intended current Worker. In the inspected production deployment, `/api/bridge` handling is absent and all five D1 migrations are pending. Deploy the reviewed bridge/backend and initialize the existing database through the [approved rollout](PRODUCTION_ROLLOUT.md). Changing secrets or sending fabricated initData is not a repair. Browser routes retain Telegram initData authentication; only the dedicated bridge routes use the separate HMAC/replay/scope middleware. Updated normal startup and optional `--check` now explain this deployment mismatch instead of suggesting credential replacement.

The old `Bot unavailable: Telegram connection failed` message did not identify the actual transport failure. It does not establish that the token is invalid, and it is separate from Worker bridge-secret authentication. The updated bundle reports the Telegram startup stage and classifies known timeout, DNS, TLS/certificate, proxy, rejected-token, rate-limit and receiver-conflict errors. Only exception types are inspected; token-bearing URLs and raw exceptions are never printed. Settings remain saved for retry, and uncertain operations are not automatically resent.

- **Timeout or connection failure:** the Python process must reach `api.telegram.org`. Try Wi-Fi/mobile data, or a trusted device-wide VPN if Telegram is blocked by the network. A working Telegram app does not prove the Python runtime can reach the Bot API: the app can use its own proxy. Check proxy settings in the device/terminal privately.
- **DNS:** check the network and Android Private DNS configuration. Try a different network before changing credentials.
- **Certificate/TLS:** correct device date/time, update trusted certificates and the Python environment; never disable certificate verification. Certificate updates can be installed with `python -m pip install --upgrade certifi`.
- **Telegram rejected BOT_TOKEN:** use optional `python bot.py --setup` to enter the correct existing BotFather token privately. Do not rotate a token merely because a network request timed out.
- **Receiver conflict:** stop other Python receivers; preserve the existing webhook and use only the confirmed K9 receiver-switch workflow.

For a token-free connectivity check from the same interpreter/terminal:

```sh
python -c "import httpx; print(httpx.get('https://api.telegram.org', timeout=15).status_code)"
```

An HTTP status confirms that this public HTTPS request reached a server; it does not verify your token, Worker bridge or publishing permissions. A timeout/DNS/TLS error points to the connection or device environment. Do not construct or share token-bearing API URLs. After correcting the connection, rerun `python bot.py`. The normal command stops safely when readiness cannot be confirmed; `[Program finished]` means the local receiver exited and is not running.

## Verification and rollback

```sh
python -m pip install -r requirements-dev.txt
python -m py_compile bot.py
python -m pytest
python -m black --check bot.py k9bot tests/test_advanced_bot.py
npm run check
npm run format:check
```

Tests use explicit synthetic Telegram transports. A real PTB Application/polling loop dispatches mocked updates and callbacks; a separate HTTPX integration reaches real local workerd/D1 with every outgoing Telegram call intercepted. See [VERIFICATION.md](VERIFICATION.md) for actual counts and remaining live gaps. No production mode switch, webhook change, secret write, publication, deployment or GitHub push occurred.

For rollback, stop Python gracefully, inspect uncertain deliveries, then use the confirmed Cloudflare restoration while the new bridge is still available. Verify its existing secret privately and Worker fence is cloudflare. Only then roll back the Worker with separate approval. Preserve all additive D1 tables, snapshots, replay/rate records and history; do not DROP/restore the DB to roll back code. Rolling old code back while the fence is python/transition can lose reception protections, so restore first. If the process crashed, wait for the lease and long poll to expire before takeover. Scheduler rollback/disablement remains a separate explicit action.
