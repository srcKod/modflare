#!/usr/bin/env node
/**
 * One-time utility to register the Telegram webhook.
 *
 * Usage:
 *   node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL> [SECRET_TOKEN] [--reactions]
 *
 * Examples:
 *   node scripts/set-webhook.mjs 123456:ABC https://telegram-mod-bot.workers.dev
 *   node scripts/set-webhook.mjs 123456:ABC https://... mySecret
 *   node scripts/set-webhook.mjs 123456:ABC https://... mySecret --reactions
 *
 * --reactions opts in to message_reaction + message_reaction_count updates
 * (needed by ENABLE_POST_ANALYTICS). Note: passing allowed_updates REPLACES
 * the default update set, so the explicit list also includes the two update
 * types the moderation pipeline consumes.
 *
 * To remove the webhook later:
 *   curl -F "url=" https://api.telegram.org/bot<BOT_TOKEN>/setWebhook
 */
const [, , token, url, secret, flag] = process.argv;

if (!token || !url) {
  console.error(
    'Usage: node scripts/set-webhook.mjs <BOT_TOKEN> <WORKER_URL> [SECRET_TOKEN] [--reactions]',
  );
  process.exit(1);
}

const params = { url };
if (secret && secret !== '--reactions') params.secret_token = secret;
if (flag === '--reactions' || secret === '--reactions') {
  params.allowed_updates = [
    'message',
    'edited_message',
    'message_reaction',
    'message_reaction_count',
  ];
}

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