# Pokémon Center Monitor (Apify actor)

Visits **pokemoncenter.com** with a real headless browser (Playwright + Chrome).
If the page fails to load, returns an HTTP error, or shows a verification /
captcha / queue page, it sends you a **Telegram** alert. Run it on a schedule
(every 5 minutes) from the Apify console.

To avoid spamming you every 5 minutes, it only notifies on a **state change**:
once when it goes DOWN, and once when it RECOVERS.

---

## 1. One-time setup: create your Telegram bot (free)

1. In Telegram, message **@BotFather** → send `/newbot` → follow prompts.
   It gives you a **bot token** like `123456789:ABCdef...`.
2. Send any message to your new bot (so it's allowed to message you).
3. Message **@userinfobot** → it replies with your numeric **chat ID**.

Keep the token and chat ID handy — you'll paste them into the actor.

## 2. Push this folder to GitHub

```bash
cd pokemoncenter-monitor
git init
git add .
git commit -m "Pokemon Center monitor actor"
git branch -M main
git remote add origin https://github.com/<you>/pokemoncenter-monitor.git
git push -u origin main
```

## 3. Create the actor on Apify from the repo

1. Apify Console → **Actors → Create new → Link Git repository**.
2. Point it at your GitHub repo and **Build**.

## 4. Configure & schedule

- In the actor's **Input**, paste your `telegramBotToken` and `telegramChatId`
  (both are stored encrypted). Optionally tweak the target URL and timeout.
- (Alternative to input) set them as the actor's **environment variables**
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` so you don't re-enter them.
- Apify Console → **Schedules → Create new** → cron `*/5 * * * *` → add this actor.

That's it. You'll get a Telegram message the moment the site starts failing or
showing a captcha/verification page, and another when it's back to normal.

---

## What counts as a failure

- Page doesn't load within the timeout (default 45s).
- HTTP status ≥ 400.
- Page text/title contains block markers: "access denied", "verify you are
  human", "captcha", "just a moment", "queue-it", Akamai "reference #", etc.
- Page is near-empty and isn't the real store.

Edit `BLOCK_MARKERS` in `src/main.js` to tune detection.

## Local test (optional)

```bash
npm install
npx playwright install chromium
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy npm start
```
