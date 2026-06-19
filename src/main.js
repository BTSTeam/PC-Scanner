import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

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
const navigationTimeoutSecs = input.navigationTimeoutSecs || 45;

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
// Fingerprints that indicate a verification / captcha page rather than the
// real store, even when the page returns HTTP 200. Lower-cased before matching.
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
// Run the check with a real (headful) fingerprinted browser. On a block,
// Crawlee retires the session and retries through a fresh residential IP.
// ---------------------------------------------------------------------------
let result = { healthy: false, reason: 'unknown', detail: 'Check did not complete', httpStatus: null, title: '' };

const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    // Headful via the image's virtual display — far less detectable than headless.
    headless: false,
    // Inject realistic browser fingerprints (this is on by default, set explicitly).
    browserPoolOptions: { useFingerprints: true },
    // Rotate session/IP and retry a few times if we get blocked.
    useSessionPool: true,
    sessionPoolOptions: { maxPoolSize: 20 },
    maxRequestRetries: 4,
    navigationTimeoutSecs,
    requestHandlerTimeoutSecs: navigationTimeoutSecs + 30,

    async requestHandler({ page, response }) {
        const httpStatus = response?.status() ?? null;
        // Give the page a beat to settle / render any challenge.
        await page.waitForTimeout(2500);

        const title = (await page.title().catch(() => '')) || '';
        const bodyText = (
            await page.evaluate(() => document.body?.innerText || '').catch(() => '')
        ).toLowerCase();
        const titleLower = title.toLowerCase();

        const matchedMarker = BLOCK_MARKERS.find((m) => bodyText.includes(m) || titleLower.includes(m));

        if (httpStatus && httpStatus >= 400) {
            // Throw so Crawlee retires the session and retries via a fresh IP.
            throw new Error(`HTTP ${httpStatus}`);
        } else if (matchedMarker) {
            result = { healthy: false, reason: 'verification_page', detail: `Matched "${matchedMarker}"`, httpStatus, title };
        } else if (!titleLower.includes(HEALTHY_TITLE_HINT) && bodyText.length < 500) {
            result = { healthy: false, reason: 'unexpected_page', detail: `Title "${title}", body length ${bodyText.length}`, httpStatus, title };
        } else {
            result = { healthy: true, reason: 'ok', detail: 'Store page loaded normally', httpStatus, title };
        }
    },

    // Fired only after all retries are exhausted — a genuine, persistent failure.
    async failedRequestHandler({ request }) {
        const lastError = request.errorMessages?.slice(-1)[0] || 'unknown error';
        const isHttp = /HTTP \d{3}/.exec(lastError);
        result = {
            healthy: false,
            reason: isHttp ? 'http_error' : 'load_failed',
            detail: `${lastError} (after ${request.retryCount} retries)`,
            httpStatus: isHttp ? Number(isHttp[0].slice(5)) : null,
            title: '',
        };
    },
});

// uniqueKey with a timestamp so repeated runs are never de-duplicated.
await crawler.run([{ url: targetUrl, uniqueKey: `check-${Date.now()}` }]);

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
