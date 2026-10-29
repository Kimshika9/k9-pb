# Recurrent Mini App authentication response — 2026-10-29

The owner reports `INVALID_AUTH` again during the signed Python bridge handshake. Native Git read confirmed remote main still points to `a1e4cb6ff9c1342ccee0361be6906d50e8bd94ed`. Inspection of that commit's Worker shows every API request going through Mini App authentication with no bridge handler. The workspace retains the newer bridge/publishing/Python implementation. A build of the old main would reproduce the reported routing, but a current production rollback is **not confirmed**: direct public probes failed at the environment proxy and official Cloudflare device login also failed before issuing a code. The previous OAuth profile was not retained after the environment restart.

Added `check_k9_backend.py`: standalone standard-library unsigned HTTPS bridge probe, without local configuration or credentials. It distinguishes expected 401 `INVALID_BRIDGE_AUTH`, old/misrouted 401 `INVALID_AUTH`, 503 configuration failures and unconfirmed/HTML/transport responses. Redirects and credential-bearing origins are rejected; response bodies/transport details are not printed. Its output does not claim real owner authentication. Tests use synthetic urllib responses; a real production result is pending the owner's device or restored environment access.

Verification: **103 Python tests passed**, with two existing PTB RetryAfter deprecation warnings; **195 app tests in 17 files**, TypeScript, lint, production build, Prettier, Black, Python compilation and diff checks also passed. No production deployment, main merge, SQL, secret rotation, Telegram message, webhook or scheduling change was performed during this follow-up. The full reviewed source was committed and pushed to GitHub branch `codex/bridge-recovery-20261029` (initial recovery commit `08e17a1`). Native Git push succeeded; production main remains unchanged. This is a source recovery branch, not a deployment or an existing pull request. Historical production records below are not current remote inspections.

---

# Bridge rejection diagnostics — 2026-10-21

Latest unauthenticated live check: `/api/bridge/identity` returned **401 JSON `INVALID_BRIDGE_AUTH`**, with the timestamp/header validation message expected for an unsigned request. The earlier 503 configuration-format blocker no longer occurs at this route. This does not establish the owner's signed HMAC, actual token validity or matching private credentials. No supplied screenshot credentials were used.

Python now distinguishes timestamp/header rejection from HMAC rejection and offers `python bot.py --diagnose-bridge`. It reports the actual absolute settings path, environment-versus-file secret source/override mismatch, and an approximate TLS response clock difference. It never prints credential values/signatures, changes settings, adjusts signatures/expiry, starts polling, changes a webhook or sends a message. Successful authenticated identity GETs still reserve normal D1 nonce/rate-limit bookkeeping and call backend getMe.

Verification: **95 Python tests passed** (seven added bridge diagnostics regressions), **195 frontend/backend tests in 17 files passed**, Python compilation, Black, strict TypeScript, lint, production build, Prettier and `git diff --check` passed. The first build completed but logged an unwritable default Wrangler log directory; rebuilding with documented `XDG_CONFIG_HOME=/tmp/k9-config WRANGLER_SEND_METRICS=false` passed without that filesystem error. Tests use synthetic credentials/providers. No live owner-signed test, credential rotation, deployment, webhook mutation or publication occurred in this diagnostic change. The downloadable bot-only archive was assembled from explicit source paths without `.env`, credentials, caches or tests. Clean extraction/help passed. The existing offline first/second-run smoke fixture also passed against the extracted archive: hidden setup, confirmed takeover, real PTB polling/update dispatch, owner dashboard, non-owner denial, repeat startup without prompts, and graceful stop/lease release. Every provider was mocked; no live Telegram calls.

The earlier rollout records below remain historical checkpoints; the current owner's signed bridge rejection is still awaiting device diagnostic output.

---

# Approved rollout execution — deployed, runtime credential correction pending

On 2026-10-21, the owner completed official Cloudflare authorization including `workers_scripts:write`. The guarded `npm run deploy` passed its build and deployed Worker version `ac2668e1-f6ca-42a3-8818-c2e116a57095`. The Cloudflare deployments API confirms 100% traffic on this version. All five production migrations had already been applied; none were rerun.

Authorized post-deployment checks passed: bridge route/authentication, receiver fence, publishing ledger code, original binding names, encrypted credential presence, exact existing D1 UUID, Mini App URL, all eight approved bridge scopes, `SCHEDULER_ENABLED=false`, full migration ledger, static assets and fetch/scheduled handlers. Recovery records were retained privately outside the repository. These checks establish deployment/configuration metadata, not validity of encrypted values.

Direct public HTTP checks: `/` **200 HTML**; `/api/bridge/identity` **503 JSON `NOT_CONFIGURED`**; `/api/profile` **503 JSON `NOT_CONFIGURED`**. The deployed `requireAuthConfig` emits this response only when `TELEGRAM_BOT_TOKEN` or `OWNER_TELEGRAM_ID` fails format validation. At least one stored value needs private correction; Cloudflare metadata cannot identify or recover it. Do not weaken validation or claim owner authentication passed. After correction, repeat unsigned requests expecting 401 `INVALID_BRIDGE_AUTH` / `INVALID_AUTH`, then use genuine private Python credentials and fresh owner Mini App initData.

Earlier local verification on this workspace: **88 Python tests**, **195 frontend/backend tests**, Python compilation, TypeScript, lint, build and formatting passed. The deployment rebuilt successfully. No live owner HMAC check, polling receiver, Mini App authenticated operation, Telegram message, webhook change or scheduling activation was performed. Native Android/Termux and real delivery remain acceptance checks. The historical records below describe earlier checkpoints and are superseded by this execution status.

---

# Legacy backend authentication mismatch — 2026-10-18

The owner's Python bridge request returned `INVALID_AUTH: Telegram authentication is required`. Production was rechecked through authenticated Cloudflare APIs: the runtime credentials remain present, deployed source still lacks `/api/bridge` handling and bridge authentication markers, and D1 still contains only `_cf_KV`. The old deployment routes the Python request through Mini App authentication. The repair requires the reviewed backend rollout and all five pending migrations; no browser authentication bypass or credential rotation was introduced.

Python diagnostics now explain this failure specifically in normal startup and optional `--check`. **88 Python tests passed**, including two new regressions that verify the legacy-backend hint and preservation of settings/receiver state. Existing Worker tests cover the separation of bridge HMAC, CLI and Mini App authentication. The source/backend update remains local pending production approval; the improved error message does not itself deploy the required server code.

Official D1 Time Travel inspection succeeded and a nonempty pre-change recovery bookmark was retained privately. This provides a proposed Cloudflare-managed recovery baseline for the independently verified empty application database. SQL export download remains blocked; no SQL dump or production restore is claimed tested. Owner approval is requested for using this checkpoint and applying the concrete migration/deployment plan. Refresh live schema/checkpoint before execution. See [the rollout plan](PRODUCTION_ROLLOUT.md).

---

# Production runtime verification — 2026-10-18

Cloudflare device authorization succeeded for the owner's account. Read-only inspection of the `k9-pb` production environment now confirms the existing `DB` binding plus runtime `TELEGRAM_BOT_TOKEN`, `OWNER_TELEGRAM_ID`, `K9_BRIDGE_SECRET` (encrypted) and the correct `MINI_APP_URL`. The runtime URL was added through an approved settings-only update; the existing database binding was verified unchanged. Build-time secrets are separate and cannot be recovered through the runtime metadata API. Presence of an encrypted entry does not establish value validity or matching Python credentials. `TELEGRAM_WEBHOOK_SECRET` is still absent; it is needed for Cloudflare webhook reception/restoration, not Python polling.

The deployed Worker source was inspected through the authorized Cloudflare API and preserved privately outside the checkout. It contains none of the Python bridge route/authentication, receiver fence or publishing ledger markers present in the reviewed local implementation. Configuring secrets alone therefore cannot make the new Python bot work with the old deployment. Additional official device authorization granted D1 access. Read-only SQL inspection confirmed the correctly bound `k9-post-studio` database contains only `_cf_KV`: no application tables or migration ledger. All five migrations are pending. The verified existing UUID was pinned locally, the full chain passed locally, and the deployment preflight now passes. No production schema SQL, code deployment, webhook replacement, live Telegram send or secret rotation has occurred.

Verification rerun on the actual workspace: **86 Python tests** and **195 frontend/backend tests** passed; Python compilation, TypeScript, lint, production build and Prettier checks passed. PTB emitted two deprecation warnings concerning future `RetryAfter.retry_after` representation. Tests use synthetic Telegram providers; owner authentication, same-bot identity, backend HMAC agreement, native Android and real delivery remain live acceptance checks.

The official D1 export job completed, but its signed R2 download was blocked by environment egress policy. No private SQL backup is downloaded/restore-verified yet. A draft adds only the exact required Cloudflare storage hostname while preserving existing network rules; it must be reviewed/saved/published before that download can proceed. The subsequent Time Travel checkpoint above offers an alternative recovery baseline for the verified empty database, subject to explicit owner approval. See [the concrete production rollout and rollback plan](PRODUCTION_ROLLOUT.md).

---

# Telegram startup diagnostics — 2026-10-14

Repaired the generic Telegram connection message reported by the owner. Startup now identifies bot initialization, identity checks, webhook inspection or polling as the failing stage, and uses safe exception-type classification for timeout/DNS/TLS/proxy failures, rejected tokens, permission errors, rate limits and receiver conflicts. Setup and optional read-only diagnostics use the same messages. Raw exception URLs/tokens are never rendered. This improves diagnosis; it cannot repair an inaccessible Telegram API on the owner's device or establish the cause of the old generic message without more evidence.

Python verification: **86 tests passed**, including 12 transport-classification/redaction cases and three initialization/identity/webhook regressions that verify preserved credentials, no receiver mutation and no Running banner on network failure. The disposable native PTB first/second-run smoke test passed again with all Telegram/backend requests mocked. All **195 frontend/backend tests**, TypeScript, lint, production build, Python compile/Black and Prettier checks passed. See the troubleshooting section of [PYTHON_BOT.md](PYTHON_BOT.md). No real credentials, Telegram network acceptance, production mutations or deployments were performed for this repair.

---

# One-command startup verification — 2026-10-13

The standard owner workflow is now `pip install -r requirements.txt` and `python bot.py`. Checks below were executed on the actual uncommitted workspace with explicitly mocked Telegram, never live publication or production webhook changes.

| Check                                                 | Actual result                                                                                                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean installation                                    | Copied only bot.py, requirements.txt and bundled k9bot/*.py into /tmp/k9-one-command-clean; created an empty isolated interpreter, installed only runtime requirements successfully and pip check reported no broken dependencies |
| Direct script import/start                            | python bot.py --help worked in the clean directory without project/package installation or PYTHONPATH changes                                                                                                                     |
| Default first run                                     | Actual root entry automatically invoked hidden setup, validated synthetic getMe, saved private .env, verified capabilities/backend, offered exactly one takeover confirmation and started native PTB polling                      |
| Default second run                                    | Same root entry loaded saved settings, asked no questions, performed no additional takeover and started native PTB directly                                                                                                       |
| Native update handling/shutdown                       | Owner /start produced the advanced dashboard, non-owner /start produced no response; POSIX SIGINT gracefully stopped both runs and released their leases; every Telegram request intercepted                                      |
| Default startup → local Worker/D1                     | Passed actual signed HTTPX identity/capability/D1-health checks and automatic no-webhook Python fence registration against compiled workerd/D1; no production state touched                                                       |
| Python suite                                          | **71 tests passed**, including all 47 original bot/CLI cases plus 24 startup cases                                                                                                                                                |
| Frontend/backend suite                                | **195 tests in 17 files passed**, preserving Phase 1/2/3 behavior and adding effective permission-metadata coverage                                                                                                               |
| TypeScript, lint, production build                    | Passed; no frontend/editor redesign or publishing-business rewrite                                                                                                                                                                |
| Python compile, Black, Prettier and whitespace checks | Passed                                                                                                                                                                                                                            |

The clean smoke driver is tests/one_command_smoke.py and must run only beside a disposable bot copy. Its synthetic provider hooks are entirely outside production modules; it exercises the actual root entry and real PTB Application/Updater. An isolated interpreter was used only to prove dependency completeness—owners do not need a project package install or manual module/path activation. The SIGINT test ran on Linux; native Termux/Windows and genuine Telegram were not tested.

Startup regressions cover first/second runs, hidden inputs and echo refusal, 0600 persistence, default URL, missing/old bridge metadata, exact missing scopes, backend secret/signature/migration/binding/endpoint diagnostics, identity mismatch, declined/foreign webhooks, existing leases, interrupted switches and a Running banner withheld before polling. Failed backend checks preserve credentials for retry with the same python bot.py command. Ordinary Mini App authentication, channel approval and publishing idempotency/uncertainty controls remain intact.

The private identity API now reports only effective bridgeActions so startup can verify intended powers. Its normal HMAC/owner/scope/replay protections remain in place. No new database migration or binding is needed for this refactor; migration 0005 from Phase 3.1 still must be present for the bridge. The updated Worker metadata endpoint and existing full bot scopes need an approved production rollout before real use. Current production credentials/account access and D1 UUID remain unverified; nothing was pushed or deployed.

**No live Telegram acceptance was performed.** Native Android Mini App launch/rendering, real owner chat/media/publications, production receiver restoration and Termux/Windows remain live-only checks. See [PYTHON_BOT.md](PYTHON_BOT.md) for the two-command setup, optional restoration and backend prerequisites. Python reception requires the process to stay running.

---

# Phase 3.1 advanced Python bot verification — 2026-10-13

All results below were run locally on the actual current workspace. Remote main remains `a1e4cb6`; the Phase 3/recovery changes and this bot rebuild are still uncommitted workspace files. No production deployment, remote SQL, mode/webhook change, secret rotation or live publication occurred.

| Check                                   | Actual result                                                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python dependencies                     | PTB 22.8 (current stable checked on PyPI), HTTPX 0.28.1 and python-dotenv 1.2.4 installed in .venv; initial download timeout resolved with a longer verified-TLS timeout                                            |
| `python -m py_compile bot.py`           | Passed; k9bot modules also compiled                                                                                                                                                                                 |
| `python -m pytest`                      | **47 tests passed**, Python 3.12.14; 42 advanced-bot cases plus 5 preserved CLI regressions                                                                                                                         |
| Real PTB Application/update dispatch    | Passed with a synthetic BaseRequest transport: owner /start, official WebAppInfo markup, callback acknowledgment/edit transitions and non-owner denial                                                              |
| Real PTB polling loop                   | Passed with intercepted Telegram getUpdates/sendMessage; /start dispatched, clean stop, no deleteWebhook call                                                                                                       |
| HTTPX → compiled Worker → real local D1 | Passed shared draft/list, content/permission preflight, publication receipt/history, private preview, media metadata/library, schedule/cancel, runtime fence/lease and replay rejection; every Telegram call mocked |
| `npm run test`                          | **194 tests in 17 files passed**, complete Phase 1/2/3 suite plus six bridge/runtime regressions                                                                                                                    |
| TypeScript, lint, production build      | Passed; existing frontend assets remain unchanged by Phase 3.1                                                                                                                                                      |
| Prettier / Black                        | Passed                                                                                                                                                                                                              |
| Local Wrangler D1                       | 0005 applied additively; 0001–0005 present, no pending local migrations and no reset                                                                                                                                |
| Deployment readiness guard              | Expected fail-closed result: existing D1 UUID still unverified/unpinned; nothing deployed                                                                                                                           |

Python coverage includes configuration/secret redaction, hidden setup/getMe validation and private files, every command, owner/private-chat restrictions, dashboard/back/stale navigation, channel selection, publish preflight/confirmation/idempotent clicks, private preview, unknown result inspection, text/template drafts, Yangon scheduling, cancellation, media registration, exact UTF-8 HMAC bytes, safe read retries/new nonces, no write retries/redirects, confirmed mode backup/restoration, pending-update preservation, different integrations/running receiver denial, uncertain switch fencing, PTB bootstrap deletion prevention and graceful lease release. Polling lease tests use the authoritative server budget even with a slow client clock.

The Worker suite verifies distinct CLI/bridge/Mini App credentials, expiry/tampering/replay/scope rejection, shared owner D1 records and existing publishing services, same-bot media verification, durable rate caps, missing-migration failure, transition fencing, exclusive/expired leases and owner mismatches. Ordinary browser requests still require real server-verified raw initData; no development auth bypass was added.

Reproduce the isolated HTTPX integration after building:

```sh
node tests/phase3-runtime.mjs
# Separate terminal, with Python virtualenv activated:
python tests/advanced_bot_integration.py
```

The gateway binds loopback only and uses disposable D1/synthetic credentials. Its __qa controls never enter deployed app imports. Reusable install/start instructions were saved to the cloud environment draft; saving does not publish or activate the configuration. Review/save and publish it in environment settings to use it for future tasks.

**Live Telegram and production checks were not performed.** Genuine credentials/account access are absent. Hosted Rich Message rendering, native private-chat Mini App launch/initData, actual media compatibility, dedicated test-channel sends, production bridge deployment/migration/secret configuration, real receiver switching and Termux/Windows operation remain unverified. The Python receiver is runnable but cannot be claimed live/always-on without those steps. Follow [PYTHON_BOT.md](PYTHON_BOT.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for exact configuration, approval and safe restoration/rollback.

---

# Phase 3 verification — 2026-10-13

These are actual local results. No real Telegram send, production mutation, GitHub push or deployment occurred. The existing Phase 1/2 recovery changes were preserved.

| Check                                       | Result                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `npm ci`                                    | Passed, lockfile preserved; 233 packages                                  |
| `npm run test`                              | **188 tests across 16 files passed**, including all Phase 1/2 regressions |
| `npm run typecheck`                         | Passed, strict frontend/Worker/shared/test types                          |
| `npm run lint`                              | Passed without warnings                                                   |
| `npm run build`                             | Passed, official Cloudflare Vite client and Worker builds                 |
| `npm run format:check`                      | Passed                                                                    |
| `python3 -m py_compile bot.py`              | Passed                                                                    |
| Python unittest discovery for `test_bot.py` | **5 tests passed**, Python 3.12                                           |
| Local Wrangler migrations                   | 0001–0004 applied; no pending local migrations; no reset                  |
| Wrangler deployment dry run                 | Passed bundling/assets/binding check; no upload/deployment                |
| `npm run deploy:check`                      | Expected fail-closed stop: existing D1 UUID is not pinned                 |
| Wrangler account diagnostics                | `loggedIn: false`; production configuration unavailable                   |

The JS suite verifies real SQLite schemas/transactions with explicitly mocked Telegram calls: valid publish/preview receipts, owner auth, unapproved destinations, serializer/media rejection, permission changes, edit/delete failures and age limits, revision/concurrency conflicts, duplicate operations, rate limits, lost completion, uncertain outcome locks/reconciliation, frozen schedules, UTC/Yangon conversion, cancellation, revoked channels, expired sending/preparation leases and migration preservation. CLI tests verify Python-generated signatures through the actual Worker router, expiry/tampering/scope rejection and D1 replay protection. Missing uncertainty migration fails closed before sending. Webhook regressions cover owner-only commands, inert preview callbacks, private media and update deduplication.

## Combined local Worker, browser and Python checks

`tests/phase3-runtime.mjs` runs the **compiled Worker in workerd with real isolated D1**, applies all SQL migrations and intercepts every outgoing request. Its Node-only gateway serves compiled assets, synthetic bindings and test-only Cron controls; no auth bypass enters the application. All Telegram responses are explicit mocks. This exposed and fixed native Worker fetch receiver and redirect-mode compatibility problems that Node unit mocks did not reproduce.

Chromium at **1440×1000** and **390×844** passed sample-to-draft, save, private test preview, approved publication, separate published editing draft, save/apply, deletion, republishing, rescheduling and cancellation. No page errors or unintended horizontal overflow occurred. Python doctor/status/channels/posts/scheduled/preview/publish commands successfully called the real local Worker using signatures. A Cron invocation delivered a captured D1 job exactly once in this test. Mock delivery totals: **9 sends, 2 edits, 2 deletes**. These counts describe synthetic confirmations, not real Telegram acceptance.

Screenshots: [desktop delivery/editor](screenshots/phase3-editor-1440.png), [mobile delivery/editor](screenshots/phase3-editor-390.png), [desktop publication manager](screenshots/phase3-published-1440.png), [mobile publication manager](screenshots/phase3-published-390.png).

Reproduce after building, in two local terminals (Python Playwright and Chromium are optional external QA tools, not application dependencies):

```sh
node tests/phase3-runtime.mjs
# Separate terminal; defaults to local Chromium at /usr/bin/chromium:
python3 tests/phase3_browser.py
```

The harness uses disposable synthetic storage and never calls real Telegram. Stop it after testing; its loopback __qa routes must never be hosted or imported into production. Application code has no test credential or auth override. No ignored `.dev.vars` file was present in the final build.

## Unperformed live checks and rollout blockers

**Real Telegram tests: not performed. Production tests: not performed.** Hosted Rich Message acceptance/rendering, actual file delivery/type/size limits, native Android/Myanmar input, Windows/Termux Python and real network/Cron behavior remain unverified. All live sends require explicit owner authorization and a dedicated approved test channel.

Cloudflare account access, runtime secret validity, existing database UUID, active deployed commit, remote migration state and existing Telegram webhook/BotFather settings remain unverified. Code changes alone cannot fix missing production authentication secrets. No token, owner ID or database UUID was fabricated. Keep scheduling disabled and CLI read-only until acceptance; obtain explicit approval before backup/remote migrations/deployment/webhook changes. See [PHASE3.md](PHASE3.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for exact setup, test-channel and rollback steps.

---

# Verification history

Recovery checks run on 2026-10-13. See [RECOVERY_AUDIT.md](RECOVERY_AUDIT.md) for production blockers and [DEPLOYMENT.md](DEPLOYMENT.md) for approved rollout/rollback steps. Passing these local checks does not repair missing production secrets.

## Earlier recovery results

- `npm ci`: completed using the existing lockfile, Node 24+, no disabled integrity checks.
- Automated suite: **150 tests in 12 files**, including all original Phase 1/2 tests and new runtime-config, missing D1, session/recovery, malformed API/Telegram envelope, label compatibility, media update deduplication, hyperlink focus recovery and preserved legacy template regressions.
- Strict TypeScript, lint, production Worker/client build, Prettier and git whitespace checks passed after final cleanup. No production auth bypass or fake deployment config is added. The ignored synthetic local credential file was removed before the final build.
- Local Wrangler D1: both migrations applied, **no pending migrations**; no reset and no new migration. API tests independently run both migrations with isolated SQLite.
- Actual local Worker/D1 HTTP: frontend 200, missing-config 503 before synthetic setup, unsigned/forged/expired 401, signed non-owner 403, signed owner 200, secure webhook rejection, draft create/save/reopen/export/conflict, persistent template create/list/delete passed using synthetic credentials only.
- Chromium at **1440×1000** and **390×844**: formatted Myanmar/English text, table editing, media picker, preview themes/details, actual JSON download, template save, autosave, reopen, real 409 copy recovery passed. Additional formatting/undo/redo/reorder/delete and template rename/duplicate/delete passed.
- An additional mobile Chromium check passed hyperlink creation/removal after input focus changed and confirmed persistence. The toolbar now restores the structured selection when removing links as well as applying them.
- Chromium recovery at both widths: early expiry notice, non-owner UI protection, real server 401 on expired save, optional device recovery retained across a simulated new session, stale revision restore/copy, no page errors or page overflow passed. An initial test used fragment-only navigation rather than reloading the app; corrected to full navigation and rerun successfully. This was a browser test setup issue, not a relaxed authorization check.
- Deployment dry run checks bundling only. `npm run deploy:check` intentionally exits 1 for the current unpinned D1 UUID; production readiness remains blocked. No command to bypass this gate was run.

Screenshots are **local synthetic fixtures**, not real owner data or native Telegram evidence: [desktop editor](screenshots/recovery-editor-1440.png), [mobile editor](screenshots/recovery-editor-390.png), [desktop preview](screenshots/recovery-preview-1440.png), [mobile preview](screenshots/recovery-preview-390.png).

## Not passed / not performed in production

Read-only requests to the provided live URL returned non-JSON 403 from this environment; they did not exercise the authenticated app. Cloudflare login/credentials, secret metadata, active commit, remote schema/migration state and webhook status remain unavailable. **No real Telegram acceptance tests passed or were performed.** No production owner request, getMe/getWebhookInfo, webhook registration, remote migration, deploy, main push, provider Rich Message send or native Android/large-media acceptance test was performed during recovery.

## Previous Phase 2 baseline

Verified locally on 2026-10-12. Phase 1's original 67 tests remain in the full suite. Production database bindings were not changed; no deployment, remote migration, real webhook registration, channel publication or real Telegram Rich Message send was performed.

## Automated checks

The final suite contains **103 tests across 9 files**. It covers Phase 1 HMAC/freshness/owner restrictions and webhook behavior, plus:

- Typed block creation, immutable editing, delete/clone/reorder, nested IDs, malformed fields, cycles and nesting bounds.
- All requested rich text formats, Unicode and plain HTML-looking text, table/details/list/media wire mappings, button action/style validation and exact UTF-8 callback limits.
- Draft create/restore/search/update/export/duplicate/delete, stale revisions, two simultaneous saves, legacy preservation, foreign-resource filtering and approval checks.
- Template samples/save/reuse/rename/duplicate/delete and version conflicts.
- Owner webhook media registration/deduplication, invalid IDs/limits, manual getFile verification, canonical ID preservation and credential-safe responses.
- Loading/empty/error states, preview themes, draft restoration, explicit confirmation, debounced autosave, edits during an in-flight save, 409 recovery and template back-navigation.
- A real Tiptap component test for exclusive inline-code formatting, whole-document selection, selection loss while focusing the toolbar, and undo/redo. Other editor state tests isolate ProseMirror selection through a test-only text component; actual toolbar behavior was also exercised in Chromium.

Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run format:check`, and `git diff --check`. Type checks include frontend, Worker, shared modules, tests and Vite config. The production build uses the existing official Cloudflare Vite plugin; the post workspace and rich text library are split out of the initial dashboard bundle.

The new additive migration `0002_editor.sql` applied successfully to the existing **local D1** database: 14 commands. Migration 0001 and approval constraints were preserved. Automated API tests apply both migrations to isolated real SQLite databases; no production database reset occurs.

## Real local Worker/browser workflow

Chromium used the Vite/Cloudflare Worker runtime and migrated local D1, with temporary synthetic authentication credentials and Telegram update fixtures. At **1440×1000** and **390×844**, the workflow passed:

- Sample template to persistent draft; Myanmar/English text with bold and hyperlinks.
- Table row/cell editing; selecting owner-registered photo metadata and caption.
- Callback button/link style, dark/light preview, expanded details and safe placeholders.
- Actual JSON download and inspection; save-as-template; autosave and reload from D1.
- A second HTTP client updating the same draft, a real 409 in the UI, recovery as a new draft, search and restore.
- No page errors or horizontal page overflow.

An additional Chromium workflow exercised all formatting toolbar marks, undo/redo, switching to inline code, block move/duplicate/delete, confirmed draft deletion, and template duplication/rename/deletion. It caught a selection-preservation edge case, which was fixed and rechecked. Earlier browser checks also caught table-cell CSS and sample back-navigation issues; both have regression coverage or final screenshots.

Screenshots use synthetic/sample content and are browser approximations:

- [Desktop editor](screenshots/phase2-editor-1440.png)
- [Mobile editor](screenshots/phase2-editor-390.png)
- [Desktop preview](screenshots/phase2-preview-1440.png)
- [Mobile preview](screenshots/phase2-preview-390.png)

Temporary `.dev.vars` test configuration is removed before the final production build. Test-created local drafts/templates/media are cleaned up by their fixture identifiers; the database is not reset. No real credentials were supplied or committed.

## Remaining live checks

Telegram's documentation website returned 403; wire fields were verified against its official Bot API 10.3 implementation and pinned TDLib schema. Hosted Rich Message acceptance, complete published provider limits, native Telegram Android behavior (including Myanmar IME and download UX), live media uploads/type compatibility and large-video delivery remain unverified. Media previews use placeholders; no token-bearing URLs or paid upload services were added. Phase 3 requires real credentials, an HTTPS launch URL, an approved test channel and explicit authorization for external actions.
