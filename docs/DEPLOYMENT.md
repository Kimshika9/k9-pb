# Setup and deployment

**Do not execute remote steps without explicit owner confirmation.** The owner's request to set up and deploy on Cloudflare authorizes these steps; credentials are still required. Local setup and tests do not require a Cloudflare account.

## Local setup

1. Install Node 24+ and run `npm ci`.
2. Create a separate development bot with BotFather. Obtain its token and your own numeric Telegram user ID through a trusted Telegram source.
3. Copy `.env.example` to `.dev.vars` and replace all placeholders. Generate a webhook secret without printing it into shared logs, for example write `openssl rand -hex 32` into your local password manager. `.dev.vars` is ignored.
4. Run `npm run db:migrate:local`, then `npm run dev`.
5. Use a trusted HTTPS tunnel for Telegram, configure the development bot's Mini App URL in BotFather, and set the same URL in local `MINI_APP_URL`. The webhook must reach that tunnel's `/telegram/webhook` route. Register only after authorization for the bot/tunnel you own.
6. Send `/start` to the bot **in your private chat** and tap the Mini App button. The authenticated dashboard will be empty until channels are connected. Reloading an old URL does not refresh Telegram's signed auth timestamp; relaunch after 15 minutes.

Credentials are required for live auth and Telegram permission checks. A normal browser visit only shows the public access screen. Never place local credentials in a frontend env file.

## Production preparation (after confirmation)

The production Worker target is **`k9-pb`**, matching the Git-connected project. The D1 binding is `DB`, with database name **`k9-post-studio`**. There is deliberately no fake database UUID: Wrangler 4 resolves an existing database by name or provisions it on deployment. It does not delete or reset an existing database.

Authenticate Wrangler in a local terminal, or securely provide `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the cloud execution environment. The token must belong to the intended account and allow **Workers Scripts: Edit**, **D1: Edit**, and **Account Settings: Read**. A token held by Cloudflare Builds is not automatically available in a separate Codex workspace. Never paste tokens in chat or commit them.

```sh
npx wrangler login
npx wrangler whoami
npm run check
npm run deploy
```

`npm run deploy` builds, deploys the Worker/assets, provisions or reuses D1, and then applies both additive migrations remotely. The first deployment remains inaccessible to private users until secrets are configured. If a remote migration fails, fix it and rerun `npm run db:migrate:remote`; migrations already applied are skipped. A successful Worker upload alone does not establish that the database or authenticated app is ready.

Wrangler prints the actual HTTPS Workers URL after deployment. Use that URL for `MINI_APP_URL`, then set **all four Worker secrets** interactively:

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put MINI_APP_URL
```

Use your final HTTPS app URL for `MINI_APP_URL`, such as your assigned Workers URL or custom domain. Generate `TELEGRAM_WEBHOOK_SECRET` securely with at least 32 random characters. No credentials go into `wrangler.jsonc`, frontend environment variables, or Vite. `keep_vars` preserves dashboard-configured Worker variables on later deployments; credentials should still be stored as encrypted secrets.

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

The deploy command is essential: plain `npx wrangler deploy` does not apply SQL migrations. Ensure the build token has D1 edit permission as well as Worker deployment permission. If permission is denied, use an appropriately scoped token or provision and migrate the database with authorized CLI access before retrying. Production secrets belong under the Worker's **Settings → Variables and Secrets**, not ordinary frontend build variables.

If a build fails after "Success: Build command completed", inspect the final deployment error rather than rebuilding the editor. The supplied screenshot stops before that error. The previous repository configuration had an all-zero database UUID and a different Worker name; those have been corrected, but remote deployment cannot be verified without account access. Do not invent a `workers.dev` URL: the account subdomain comes from Cloudflare.

## Register the webhook (also requires authorization)

Configure the production bot with BotFather: its main Mini App/menu launch URL must be the HTTPS app origin. Then call Telegram's `setWebhook` with `url`, `secret_token`, and `allowed_updates: ["message"]`. Use a local script with secrets loaded from your password manager/secure environment, not pasted into shell command history. Example Python script (read values via `getpass`):

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
        'allowed_updates': ['message'],
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
- No publishing or scheduler runs in Phase 1 or Phase 2.

Live acceptance checks need real credentials, an HTTPS Telegram launch URL, a configured bot and Cloudflare account. They cannot be completed by local mocks. Inspect logs only with redaction; do not capture initData or token-bearing Telegram URLs. Back up D1 before future schema upgrades; prefer additive migrations and explicit rollback plans.
