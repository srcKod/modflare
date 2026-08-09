#!/usr/bin/env node
/**
 * One-time utility to register the Telegram webhook.
 *
 * Usage:
 *   node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL> [SECRET_TOKEN]
 *
 * Examples:
 *   node scripts/set-webhook.mjs 123456:ABC https://telegram-mod-bot.workers.dev
 *   node scripts/set-webhook.mjs 123456:ABC https://... mySecret
 *
 * To remove the webhook later:
 *   curl -F "url=" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
 */
const [, , token, url, secret] = process.argv;

if (!token || !url) {
  console.error('Usage: node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL> [SECRET_TOKEN]');
  process.exit(1);
}

const params = { url };
if (secret) params.secret_token = secret;

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(params),
});

const json = await res.json();
console.log(JSON.stringify(json, null, 2));

if (!json.ok) {
  console.error('\nWebhook registration FAILED. Check the token and URL.');
  process.exit(1);
}