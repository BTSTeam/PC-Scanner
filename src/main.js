import { Actor } from 'apify';
import { chromium } from 'playwright';

await Actor.init();

// ---------------------------------------------------------------------------
// Config — input values win, but env vars are a safe fallback for the secrets
// so you can store them once on the actor and not in every run's input.
// ---------------------------------------------------------------------------
const input = (await Actor.getInput()) ?? {};

const targetUrl = input.targetUrl || 'https://www.pokemoncenter.com/en-gb';
const botToken = input.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
const chatId = input.telegramChatId || process.env.TELEGRAM_CHAT_ID;
const alertOnRecovery = input.alertOnRecovery !== false;
const navigationTimeoutMs = (input.navigationTimeoutSecs || 45) * 1000;

if (!botToken || !chatId) {
    throw new Error(
        'Missing Telegram credentials. Set "telegramBotToken" and "telegramChatId" in the actor input '
        + '(or as TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID environment variables).',
    );
}

// Persisted across runs so we only notify on state CHANGES (not every 5 min).
const store = await Actor.openKeyValueStore();
const lastStatus = (await store.getValue('LAST_STATUS')) || 'unknown'; // 'ok' | 'down' | 'unknown'

// ---------------------------------------------------------------------------
// Telegram helper
// ---------------------------------------------------------------------------
async function sendTelegram(text) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram send failed: ${res.status} ${body}`);
    }
}

// ---------------------------------------------------------------------------
// Fingerprints that indicate a block / verification / captcha page rather than
// the real store. Lower-cased before matching.
// ---------------------------------------------------------------------------
const BLOCK_MARKERS = [
    'access denied',
    'pardon our interruption',
    'are you a human',
    'verify you are human',
    'verifying you are human',
    'unusual traffic',
    'press & hold',
    'press and hold',
    'captcha',
    'hcaptcha',
    'recaptcha',
    'cf-challenge',
    'just a moment',           // Cloudflare interstitial
    'checking your browser',   // Cloudflare interstitial
    'queue-it',
    'you are now in line',     // Queue-it waiting room
    'reference #',             // Akamai error reference id
    'request blocked',
];

// A healthy pokemoncenter page reliably contains this in the title.
const HEALTHY_TITLE_HINT = 'pok'; // matches "Pokémon Center" / "Pokemon Center"

// ---------------------------------------------------------------------------
// Run the check
// ---------------------------------------------------------------------------
let result = { healthy: false, reason: 'unknown', detail: '', httpStatus: null, title: '' };

// Route through a proxy (residential by default) so the site sees an ordinary
// home visitor rather than a datacenter IP that Akamai blocks with a 403.
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
};
if (proxyUrl) {
    const u = new URL(proxyUrl);
    launchOptions.proxy = {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
    };
    console.log(`Using proxy ${u.hostname}:${u.port}`);
} else {
    console.log('No proxy configured — using Apify datacenter IP (may be blocked).');
}

const browser = await chromium.launch(launchOptions);

try {
    const context = await browser.newContext({
        userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-GB',
        viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    let response;
    try {
        response = await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: navigationTimeoutMs,
        });
    } catch (err) {
        result = {
            healthy: false,
            reason: 'load_failed',
            detail: `Page did not load: ${err.message}`,
            httpStatus: null,
            title: '',
        };
    }

    if (response || result.reason !== 'load_failed') {
        const httpStatus = response ? response.status() : null;
        // Give the page a beat to settle / render the challenge if there is one.
        await page.waitForTimeout(2500);

        const title = (await page.title().catch(() => '')) || '';
        const bodyText = (
            await page.evaluate(() => document.body?.innerText || '').catch(() => '')
        ).toLowerCase();
        const titleLower = title.toLowerCase();

        const matchedMarker = BLOCK_MARKERS.find((m) => bodyText.includes(m) || titleLower.includes(m));

        if (httpStatus && httpStatus >= 400) {
            result = { healthy: false, reason: 'http_error', detail: `HTTP ${httpStatus}`, httpStatus, title };
        } else if (matchedMarker) {
            result = {
                healthy: false,
                reason: 'verification_page',
                detail: `Matched "${matchedMarker}"`,
                httpStatus,
                title,
            };
        } else if (!titleLower.includes(HEALTHY_TITLE_HINT) && bodyText.length < 500) {
            // No block marker but page is near-empty and not the real store — treat as suspicious.
            result = {
                healthy: false,
                reason: 'unexpected_page',
                detail: `Title "${title}", body length ${bodyText.length}`,
                httpStatus,
                title,
            };
        } else {
            result = { healthy: true, reason: 'ok', detail: 'Store page loaded normally', httpStatus, title };
        }
    }
} finally {
    await browser.close();
}

// ---------------------------------------------------------------------------
// Decide whether to notify (only on state changes, to avoid spam every 5 min)
// ---------------------------------------------------------------------------
const nowIso = new Date().toISOString();
const newStatus = result.healthy ? 'ok' : 'down';

console.log(`[${nowIso}] healthy=${result.healthy} reason=${result.reason} detail=${result.detail}`);

await Actor.pushData({ checkedAt: nowIso, url: targetUrl, ...result });

if (newStatus === 'down' && lastStatus !== 'down') {
    await sendTelegram(
        `🚨 <b>Pokémon Center check FAILED</b>\n`
        + `Reason: <b>${result.reason}</b>\n`
        + `${result.detail}\n`
        + `URL: ${targetUrl}\n`
        + `Time: ${nowIso}`,
    );
    console.log('Sent FAILURE alert to Telegram.');
} else if (newStatus === 'ok' && lastStatus === 'down' && alertOnRecovery) {
    await sendTelegram(
        `✅ <b>Pokémon Center is back to normal</b>\n`
        + `${targetUrl}\n`
        + `Time: ${nowIso}`,
    );
    console.log('Sent RECOVERY alert to Telegram.');
} else {
    console.log('No state change — no notification sent.');
}

await store.setValue('LAST_STATUS', newStatus);

await Actor.exit();
