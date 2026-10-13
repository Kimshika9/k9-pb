# Setup and deployment

**Do not execute remote steps without explicit owner confirmation.** Phase 1 implementation does not deploy or register a webhook. Local setup and tests do not require a Cloudflare account.

## Local setup

1. Install Node 24+ and run `npm ci`.
2. Create a separate development bot with BotFather. Obtain its token and your own numeric Telegram user ID through a trusted Telegram source.
3. Copy `.env.example` to `.dev.vars` and replace all placeholders. Generate a webhook secret without printing it into shared logs, for example write `openssl rand -hex 32` into your local password manager. `.dev.vars` is ignored.
4. Run `npm run db:migrate:local`, then `npm run dev`.
5. Use a trusted HTTPS tunnel for Telegram, configure the development bot's Mini App URL in BotFather, and set the same URL in local `MINI_APP_URL`. The webhook must reach that tunnel's `/telegram/webhook` route. Register only after authorization for the bot/tunnel you own.
6. Send `/start` to the bot **in your private chat** and tap the Mini App button. The authenticated dashboard will be empty until channels are connected. Reloading an old URL does not refresh Telegram's signed auth timestamp; relaunch after 15 minutes.

Credentials are required for live auth and Telegram permission checks. A normal browser visit only shows the public access screen. Never place local credentials in a frontend env file.

## Production preparation (after confirmation)

Authenticate Wrangler and create a D1 database:

```sh
npx wrangler login
npx wrangler d1 create k9-post-studio
```

Replace the all-zero `database_id` in `wrangler.jsonc` with the returned UUID. D1 identifiers are configuration, not credentials. Verify the Cloudflare account and target database, then apply the migration and set **all four Worker secrets** interactively:

```sh
npm run db:migrate:remote
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put MINI_APP_URL
npm run check
npm run deploy
```

Use your final HTTPS app URL for `MINI_APP_URL`, such as your assigned Workers URL or custom domain. If the named Worker does not exist yet, Wrangler may offer to create it while storing a secret; that is a remote action covered by the same confirmation. Some accounts require the initial Worker deployment before `secret put`: in that case deploy the validated build (all authenticated routes fail closed until configured), set the secrets, and verify again. No credentials go into `wrangler.jsonc` or Vite.

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
- No publishing or scheduler runs in Phase 1.

Live acceptance checks need real credentials, an HTTPS Telegram launch URL, a configured bot and Cloudflare account. They cannot be completed by local mocks. Inspect logs only with redaction; do not capture initData or token-bearing Telegram URLs. Back up D1 before future schema upgrades; prefer additive migrations and explicit rollback plans.
