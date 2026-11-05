# MEGA Meta Pixel + Telegram Private Channel Tracker

This project attributes a landing-page Telegram CTA click to a unique Telegram bot start and then to a verified join in one private Telegram channel.

## Security first

A Telegram bot token was exposed in the setup conversation. Revoke it in @BotFather with `/revoke`, issue a fresh token, and store only the fresh token in Render Environment. Never put it in GitHub, HTML, browser JavaScript, screenshots, or chat.

## What it tracks

- Landing-page CTA clicks (browser Pixel custom event `TelegramClick`)
- Telegram bot starts (server-side CAPI custom event `BotStart`)
- Verified private-channel joins (server-side CAPI standard event `Lead`)
- Campaign/ad-set/ad UTM values in the admin report

A click is not counted as a join. Only the Telegram `chat_member` update tied to the one-use invite link marks a verified join.

## Important hosting choice

The included `render.yaml` uses a paid Render Starter web service with a persistent disk mounted at `/var/data`. This is intentional: Render free web services spin down and their local files are ephemeral, so SQLite data can disappear on restarts/redeploys. Free Render is suitable only for a temporary test; do not use it for paid ad measurement. See Render's current docs: https://render.com/docs/free and https://render.com/docs/disks.

## 1. Prepare Telegram

1. Open @BotFather.
2. Revoke the exposed old token with `/revoke`.
3. Generate/copy the new token. Do not share it.
4. Add your bot to your private channel as an administrator.
5. Grant permission to invite users.
6. Copy the private channel ID. A channel ID commonly begins with `-100`.
7. Note the bot username without the `@`.

## 2. Prepare Meta

1. Open https://business.facebook.com/events_manager2
2. Create a Web dataset/Pixel for your website.
3. Copy its Pixel ID.
4. Create a Conversions API access token in Events Manager.
5. Choose a currently supported Graph API version in Meta's documentation / app settings. Put the exact version (for example, `vXX.X` replaced with a real supported version) in `META_GRAPH_VERSION`.
6. In Events Manager, use Test Events to verify browser `PageView`, browser `TelegramClick`, and server `BotStart` / `Lead` events.

Do not put the CAPI access token in GitHub Pages code.

## 3. Deploy on Render

1. Create a GitHub repository, e.g. `mega-telegram-tracker`.
2. Upload this project's files to the repository root.
3. In Render, choose **New > Blueprint** and connect that repository. Render reads `render.yaml`.
4. Confirm the paid Starter service and 1 GB persistent disk. The service needs the disk to preserve SQLite data.
5. In Render > service > Environment, set:
   - `TELEGRAM_BOT_TOKEN` = fresh BotFather token
   - `TELEGRAM_BOT_USERNAME` = bot username without `@`
   - `TELEGRAM_CHANNEL_ID` = private channel ID
   - `TELEGRAM_WEBHOOK_SECRET` = long random secret (if Blueprint generated one, keep it)
   - `META_PIXEL_ID` = Pixel/Dataset ID
   - `META_ACCESS_TOKEN` = CAPI token
   - `META_GRAPH_VERSION` = current supported version
   - `PUBLIC_URL` = Render service URL, e.g. `https://mega-telegram-tracker.onrender.com`
   - `ADMIN_PASSWORD` = long unique password
   - `ALLOWED_ORIGIN` = `https://gouravchouhan28.github.io`
6. Deploy and wait for `/health` to return `{"ok":true,...}`.

`ADMIN_USER` defaults to `admin` in the Blueprint. Change it if desired.

## 4. Register Telegram webhook

Run this from your own terminal, replacing the values locally. Do not paste the token into a public URL or GitHub file.

```bash
curl -X POST "https://api.telegram.org/bot<NEW_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_RENDER_HOST>/telegram-webhook",
    "secret_token": "<YOUR_TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "chat_member"]
  }'
```

Verify:
```bash
curl "https://api.telegram.org/bot<NEW_BOT_TOKEN>/getWebhookInfo"
```

The Telegram Bot API requires the bot to be an administrator in the channel and `chat_member` to be explicitly included in `allowed_updates` for membership updates.

## 5. Connect GitHub Pages

1. Open your existing repository for `NSE180NUMRETA`.
2. Add the contents of `github-pages-integration.html` to the page:
   - Put the Meta Pixel base code inside `<head>`.
   - Put the second script near the end of `<body>`.
3. Replace `YOUR_PIXEL_ID` with the Pixel ID.
4. Replace `YOUR_RENDER_SERVICE_URL` with the deployed Render service URL.
5. Change the existing Telegram CTA to `<button id="telegramJoin">Join Telegram</button>`. Keep your own styling on this button.
6. Commit and wait for GitHub Pages to publish.

The API CORS allowlist is configured for `https://gouravchouhan28.github.io`. The `page_url` is validated against that origin.

## 6. Open the dashboard

Visit:
`https://<YOUR_RENDER_HOST>/admin`

Sign in with `ADMIN_USER` and `ADMIN_PASSWORD`.

The dashboard reports total clicks, bot starts, verified joins, Meta event delivery counts, and UTM campaign/ad-set/ad breakdowns.

## 7. Test before ads

1. Open the landing page with test UTMs:
   `?utm_source=facebook&utm_campaign=test_campaign&utm_adset=test_adset&utm_ad=test_creative`
2. Open Meta Pixel Helper or Events Manager Test Events and confirm `PageView`.
3. Click the Telegram button. Confirm `TelegramClick` and that the bot opens with a start token.
4. Press Start in the bot. Confirm it replies with a unique private invite link.
5. Join the channel through that link.
6. Confirm the admin dashboard increments bot starts and verified joins.
7. Confirm `BotStart` and `Lead` arrive in Meta Events Manager Test Events / diagnostics.

## Limitations and production notes

- Each tracked CTA click creates a distinct start token and a single-member invite link. A visitor must start the bot and use that generated invite link for attribution.
- Existing channel members, users joining through unrelated links, or users who skip the bot cannot be attributed by this flow.
- Telegram membership updates identify the invite link used; they do not guarantee that Meta can match the event to an ad click.
- Meta matching quality depends on available permitted identifiers such as `_fbp`, `_fbc`, IP address and browser user agent. Obtain any required consent and disclose tracking in your privacy notice.
- Do not send Telegram usernames, phone numbers, or Telegram IDs to Meta.
- Add a privacy policy, data retention/deletion procedure, monitoring, and backups before production use.
- For higher volume or multi-instance hosting, migrate SQLite to managed PostgreSQL and use a durable queue.
- The sample queues failed Meta events and retries them periodically. Check the admin pending count and server logs.
