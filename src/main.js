import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// --- Config (token + chat ID come from input or env vars) -------------------
const input = (await Actor.getInput()) ?? {};
const targetUrl = input.targetUrl || 'https://www.pokemoncenter.com/en-gb';
const botToken = input.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
const chatId = input.telegramChatId || process.env.TELEGRAM_CHAT_ID;
const navigationTimeoutMs = (input.navigationTimeoutSecs || 45) * 1000;

if (!botToken || !chatId) {
    throw new Error('Missing Telegram bot token / chat ID (set them in input or as env vars).');
}

// Remember last state so we only message on a CHANGE, not every 5 minutes.
const store = await Actor.openKeyValueStore();
const lastStatus = (await store.getValue('LAST_STATUS')) || 'unknown';

async function sendTelegram(text) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text().catch(() => '')}`);
}

// --- Visit the page ONCE, as a real browser through a residential IP --------
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

const launchOptions = { headless: false, args: ['--no-sandbox'] };
if (proxyUrl) {
    const u = new URL(proxyUrl);
    launchOptions.proxy = {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
    };
}

let healthy = false;
let detail = '';

const browser = await chromium.launch(launchOptions);
try {
    const page = await browser.newPage({ locale: 'en-GB' });
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    await page.waitForTimeout(2000); // let any redirect/challenge settle

    const status = response ? response.status() : 0;
    const finalUrl = page.url();
    const onPokemonCenter = finalUrl.includes('pokemoncenter.com');

    if (status >= 400) {
        detail = `Did not load (HTTP ${status})`;
    } else if (!onPokemonCenter) {
        detail = `Redirected away to ${finalUrl}`;
    } else {
        healthy = true; // loaded fine and stayed on pokemoncenter.com
    }
} catch (err) {
    detail = `Did not load: ${err.message}`;
} finally {
    await browser.close();
}

// --- Notify only when the state changes -------------------------------------
const now = new Date().toISOString();
const newStatus = healthy ? 'ok' : 'down';
console.log(`[${now}] healthy=${healthy} ${detail}`);
await Actor.pushData({ checkedAt: now, url: targetUrl, healthy, detail });

if (newStatus === 'down' && lastStatus !== 'down') {
    await sendTelegram(`🚨 Pokémon Center is NOT loading\n${detail}\n${targetUrl}\n${now}`);
    console.log('Sent FAILURE alert.');
} else if (newStatus === 'ok' && lastStatus === 'down') {
    await sendTelegram(`✅ Pokémon Center is back to normal\n${targetUrl}\n${now}`);
    console.log('Sent RECOVERY alert.');
} else {
    console.log('No change — no notification sent.');
}

await store.setValue('LAST_STATUS', newStatus);
await Actor.exit();
