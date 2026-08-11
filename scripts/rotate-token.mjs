#!/usr/bin/env node
/**
 * One-command bot-token rotation for production.
 *
 * Reads the NEW BOT_TOKEN (+ optional WEBHOOK_SECRET_TOKEN / WORKER_URL) from
 * `.dev.vars`, pushes it to the Cloudflare secret (stdin-piped, never echoed),
 * re-registers the Telegram webhook with the new token, and verifies.
 *
 * Usage:
 *   node scripts/rotate-token.mjs [WORKER_URL]
 *
 * WORKER_URL defaults to the WORKER_URL line in .dev.vars, then to
 * https://telegram-mod-bot.livenet123.workers.dev (your deployed worker).
 *
 * Why this exists:
 *   `wrangler deploy` does NOT upload `.dev.vars` — BOT_TOKEN lives as a
 *   Cloudflare *secret*. After rotating via @BotFather you must re-run
 *   `wrangler secret put BOT_TOKEN` or the worker keeps calling the Telegram
 *   API with the old (revoked) token: moderation still runs and gets logged,
 *   but deleteMessage/sendMessage silently fail with 401.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , cliUrl] = process.argv;
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const DEFAULT_URL = 'https://telegram-mod-bot.livenet123.workers.dev';

// --- Load .dev.vars (keys only printed; values never). -----------------------
const envPath = join(process.cwd(), '.dev.vars');
function devVar(key) {
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through */
  }
  return null;
}

const token = devVar('BOT_TOKEN');
const secretToken = devVar('WEBHOOK_SECRET_TOKEN');
const url = cliUrl || devVar('WORKER_URL') || DEFAULT_URL;

// --- Validate without printing the token. ------------------------------------
if (!token) {
  console.error('✖ BOT_TOKEN not found in .dev.vars — put the NEW token there first.');
  process.exit(1);
}
if (!TOKEN_RE.test(token)) {
  console.error('✖ BOT_TOKEN in .dev.vars does not look like a Telegram token (format: 123456:ABC-...).');
  process.exit(1);
}
console.log(`✔ BOT_TOKEN read from .dev.vars (length ${token.length}, value hidden)`);
console.log(`✔ Webhook URL: ${url}${secretToken ? ' (with secret token)' : ''}`);

// --- 1. Push the new token to the Cloudflare secret (stdin pipe, no echo). ---
console.log('\n→ Updating Cloudflare secret BOT_TOKEN…');
const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'BOT_TOKEN'], {
  cwd: process.cwd(),
  input: token + '\n',
  encoding: 'utf8',
  shell: process.platform === 'win32', // npx resolves via .cmd on Windows
});
if (put.status !== 0) {
  console.error('✖ wrangler secret put failed:', put.stderr?.trim() || put.stdout?.trim() || put.error);
  process.exit(1);
}
console.log(put.stdout.trim());

// --- 2. Re-register the webhook with the NEW token. --------------------------
console.log('\n→ Registering webhook with the new token…');
const params = { url };
if (secretToken) params.secret_token = secretToken;
const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(params),
});
const setJson = await setRes.json();
if (!setJson.ok) {
  console.error('✖ setWebhook FAILED:', JSON.stringify(setJson));
  process.exit(1);
}
console.log(`✔ setWebhook ok (${setJson.result?.description ?? 'ok'})`);

// --- 3. Verify what Telegram actually sees. ----------------------------------
const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
  method: 'GET',
});
const infoJson = await infoRes.json();
if (infoJson.ok && infoJson.result?.url) {
  console.log(`✔ Webhook confirmed: ${infoJson.result.url}`);
  console.log(`  pending_update_count: ${infoJson.result.pending_update_count ?? 0}`);
  console.log(`  last_error: ${infoJson.result.last_error_message ?? 'none'}`);
} else {
  console.warn('⚠ Could not verify webhook info:', JSON.stringify(infoJson).slice(0, 300));
}

console.log('\n✅ Token rotation complete.');
console.log('   The deployed worker now authenticates with the NEW token —');
console.log('   deleteMessage and fun responses will work again.');
console.log('\n   Reminder: the OLD token is burned if it ever leaked. Consider');
console.log('   /revoke (not /token) at @BotFather when that happens.');
