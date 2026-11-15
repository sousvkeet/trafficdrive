// mcp/prompts.js — ready-made workflows the user can pick from their client.
const { z } = require('zod');

const msg = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

function registerPrompts(server) {
  server.registerPrompt('plan_campaign', {
    title: 'Plan and launch a traffic campaign',
    description: 'Walk through choosing a mode and settings, checking proxies and privacy, then starting and monitoring a campaign.',
    argsSchema: {
      goal: z.string().describe('What you want to achieve, e.g. "load-test my staging site with 50 visits" or "check my new landing page loads from mobile".'),
      url: z.string().optional().describe('Target URL, if you already know it.'),
    },
  }, ({ goal, url }) => msg(
`Help me plan and run a TrafficDrive campaign.

Goal: ${goal}
${url ? `Target: ${url}\n` : ''}
Please work through these steps, asking me only if something important is unclear:
1. Call get_status to confirm the backend is connected and note the safety limits.
2. Call get_catalog, then pick the campaign mode that fits the goal (direct, organic, referral or gmaps) and explain why.
3. Call list_proxies. If I want proxies and none are loaded, suggest add_proxies (my own) rather than free scraped ones unless I agree.
4. Suggest a privacy setup with preview_privacy_config (and offer verify_privacy to prove it works).
5. Propose concrete settings (sessions, threads, visit time, device, headless) and wait for my OK before starting. Start small first.
6. Start the campaign, follow it with wait_for_campaign, then report the outcome from get_campaign (completed vs failed sessions) and anything notable in the logs.`));

  server.registerPrompt('diagnose_campaign', {
    title: 'Diagnose a campaign',
    description: 'Find out why a campaign is failing, slow or stuck and suggest fixes.',
    argsSchema: { campaignId: z.string().describe('Campaign id, e.g. proc_3') },
  }, ({ campaignId }) => msg(
`Diagnose TrafficDrive campaign ${campaignId}.

1. Call get_campaign for its state, progress and settings.
2. Call get_campaign_logs with level "error", then "warn", to find the pattern (navigation timeouts, proxy errors, CAPTCHA pauses, browser launch failures, "not found in results").
3. If proxies are involved, check list_proxies and offer validate_proxies.
4. If it looks fingerprint-related, offer verify_privacy for the same privacy settings.
5. Give me the most likely cause, the evidence (quote the log lines) and specific changes to try. Do not stop or restart the campaign unless I ask.`));

  server.registerPrompt('choose_privacy_profile', {
    title: 'Choose a privacy profile',
    description: 'Pick between none / balanced / stealth (or a custom feature list) for a use case, and verify it.',
    argsSchema: { useCase: z.string().describe('What the browsers will be used for.') },
  }, ({ useCase }) => msg(
`Recommend TrafficDrive privacy settings for: ${useCase}

1. Call list_privacy_features and explain, briefly, what the three categories protect.
2. Recommend "none", "balanced" or "stealth" — or a custom privacyFeatures list — and why. Mention trade-offs (e.g. webrtc-leak blocks peer-to-peer calls, cookie-sanitize blocks analytics cookies, etag-clear disables the HTTP cache).
3. Call preview_privacy_config for your recommendation, then verify_privacy and report any failed checks.`));

  server.registerPrompt('proxy_health_check', {
    title: 'Proxy health check',
    description: 'Test every loaded proxy and report how many work.',
  }, () => msg(
`Check the health of my loaded proxies.

1. Call list_proxies to see how many there are and their protocols.
2. Warn me that validate_proxies REMOVES dead proxies from the loaded list, and ask before running it if the list is large.
3. Run validate_proxies, then summarise: how many worked, how many were removed, how many remain, and whether that is enough for the campaigns I plan.`));

  server.registerPrompt('schedule_campaign', {
    title: 'Schedule a campaign',
    description: 'Turn "run X at Y" into a server-side schedule.',
    argsSchema: {
      what: z.string().describe('The campaign to run, e.g. "direct traffic to https://example.com, 20 sessions, 2 threads, mobile".'),
      when: z.string().describe('When, e.g. "in 30 minutes", "tomorrow 9am Karachi time", "every Monday and Thursday at 18:00".'),
    },
  }, ({ what, when }) => msg(
`Schedule a TrafficDrive campaign.

What: ${what}
When: ${when}

Convert "when" into a schedule type (delay, datetime with a UTC offset, or recurring weekly days + HH:MM in the backend machine's local time — say which timezone you assumed), then call create_schedule. Confirm the settings with me first if anything is ambiguous. Afterwards call list_schedules and tell me the next run time. Remind me the app must be running at that time.`));
}

module.exports = { registerPrompts };
