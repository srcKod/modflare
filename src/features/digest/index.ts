/**
 * News digest feature manifest: hourly gate cron, reaction capture (pre-empts
 * moderation with a lower update priority), and the Digest tab API routes.
 * Pipeline lives in ./pipeline, presets in ./config, review console in
 * ./admin.
 */

import type { FeatureManifest } from '../../core/router';
import { runDigestGate, captureReactionUpdate } from './pipeline';
import { digestAdminRoutes } from './admin';

export const digestFeature: FeatureManifest = {
  name: 'digest',
  crons: [
    // Hourly gate: resolves the content type (daily/weekly/monthly) for the
    // current local hour; no-ops unless ENABLE_NEWS_DIGEST=true and the slot
    // is due. Must match [triggers] in wrangler.toml.
    { expr: '0 * * * *', handler: (env) => runDigestGate(env) },
  ],
  updates: [
    {
      // Reaction analytics: short-circuit BEFORE moderation (priority 10 < 100)
      // — reaction updates are not moderation input.
      kinds: ['message_reaction', 'message_reaction_count'],
      priority: 10,
      handler: async (env, update, logger) => {
        await captureReactionUpdate(env, update, logger);
        return true;
      },
    },
  ],
  adminRoutes: digestAdminRoutes,
};
