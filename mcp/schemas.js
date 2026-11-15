// mcp/schemas.js — zod input schemas shared by the MCP tools.
const { z } = require('zod');
const PrivacyCatalog = require('../PrivacyCatalog.js');

const ENGINES = ['google', 'bing', 'yahoo', 'duckduckgo', 'yandex', 'ask'];
const PLATFORMS = ['random', 'facebook', 'youtube', 'tiktok', 'instagram', 'twitter', 'reddit', 'linkedin', 'pinterest'];
const MODES = ['direct', 'organic', 'referral', 'gmaps', 'rpa'];

const url = (what) => z.string().min(3).max(2048).describe(what);

// Privacy: a named profile, or an explicit list (the list wins).
const privacyShape = {
  privacyProfile: z.enum(['none', 'balanced', 'stealth']).optional()
    .describe('Preset set of privacy protections: balanced (17 core fingerprint/header protections) or stealth (all 34). See list_privacy_features.'),
  privacyFeatures: z.array(z.enum(PrivacyCatalog.ALL_IDS)).max(34).optional()
    .describe('Explicit privacy feature IDs to enable (overrides privacyProfile). See list_privacy_features for the IDs.'),
};

// Options every traffic mode shares.
const commonShape = {
  sessions: z.number().int().min(1).max(100000).default(1).describe('How many browser sessions (visits) to run in total.'),
  threads: z.number().int().min(1).max(50).default(1).describe('How many browsers run at the same time.'),
  headless: z.boolean().default(true).describe('Run browsers without a visible window (default true; set false to watch them).'),
  device: z.enum(['desktop', 'mobile', 'tablet']).default('desktop').describe('Device type to emulate (affects User-Agent, viewport and touch).'),
  visitTimeMs: z.number().int().min(1000).max(3600000).default(20000).describe('How long each session stays on the target page, in milliseconds.'),
  delayMinSeconds: z.number().min(0).max(3600).optional().describe('Minimum random pause between sessions on each thread, in seconds.'),
  delayMaxSeconds: z.number().min(0).max(3600).optional().describe('Maximum random pause between sessions on each thread, in seconds.'),
  userAgents: z.array(z.string().min(10).max(500)).max(200).optional().describe('Custom User-Agent strings to use instead of the built-in pool.'),
  uaMode: z.enum(['first', 'rotate']).optional().describe('With userAgents: "first" always uses the first, "rotate" picks randomly per session.'),
  autoRotateResolutions: z.boolean().optional().describe('Use a different desktop screen resolution for each session.'),
  viewportWidth: z.number().int().min(200).max(7680).optional().describe('Viewport width in pixels (desktop).'),
  viewportHeight: z.number().int().min(200).max(4320).optional().describe('Viewport height in pixels (desktop).'),
  scrollDirection: z.enum(['down', 'both', 'random']).optional().describe('Scrolling pattern on pages: "down" only scrolls down, "both" scrolls down then back up, "random" varies naturally (default).'),
  scrollDownWaitMs: z.number().int().min(0).max(60000).optional().describe('Pause after scrolling down, in milliseconds.'),
  scrollUpWaitMs: z.number().int().min(0).max(60000).optional().describe('Pause after scrolling up, in milliseconds.'),
  scrollLinkSystem: z.boolean().optional().describe('The dashboard\'s "Scroll & link system": scroll naturally and open the site\'s internal links (same effect as internalLinkNavigation).'),
  internalLinkNavigation: z.boolean().optional().describe('After the main page, also open some of the site\'s internal links.'),
  internalLinkCount: z.number().int().min(1).max(50).optional().describe('How many internal links to open (with internalLinkNavigation).'),
  internalLinkReadTimeMs: z.number().int().min(500).max(600000).optional().describe('Time spent on each internal page, in milliseconds.'),
  useLoadedProxies: z.boolean().default(true).describe('Route sessions through the proxies loaded with add_proxies / scrape_free_proxies (one per session, round-robin). Has no effect when none are loaded. Before the campaign starts, the proxies are tried on the campaign\'s own address and only those that can open it are used; if none can, the campaign does not start (it never silently runs without proxies). Takes a few seconds, up to a minute.'),
  customBrowserPath: z.string().max(1024).optional().describe('Path of a browser to use. Must be one of the browsers listed by list_browsers.'),
  loop: z.boolean().default(false).describe('When the campaign completes, start it again automatically until stopped.'),
  loopDelaySeconds: z.number().int().min(1).max(86400).optional().describe('Pause between loop iterations in seconds (default 5).'),
  ...privacyShape,
};

const directShape = {
  url: url('The page to visit, e.g. https://example.com'),
  ...commonShape,
};

const organicShape = {
  url: url('The website to find in the search results and visit, e.g. https://example.com'),
  keywords: z.array(z.string().min(1).max(200)).min(1).max(100).describe('Search phrases; each session picks one at random.'),
  engine: z.enum(ENGINES).default('google').describe('Search engine to use.'),
  maxPages: z.number().int().min(1).max(10).default(1).describe('How many result pages to look through for the website.'),
  customEngine: z.object({
    name: z.string().max(60).optional().describe('Display name'),
    searchUrl: z.string().min(4).max(2048).describe('Search URL with {query} where the keywords go, e.g. https://search.brave.com/search?q={query}. A bare site URL also works (/search?q= is assumed).'),
  }).optional().describe('Use your own search engine instead of the built-in list (overrides "engine").'),
  internalLinkVisitTimeMs: z.number().int().min(500).max(600000).optional().describe('Time on each internal page when reading articles (organic mode), milliseconds.'),
  articlesToRead: z.number().int().min(0).max(20).optional().describe('How many articles to read on the target site (organic mode).'),
  ...commonShape,
};

const referralShape = {
  url: url('The page to visit after the social platform, e.g. https://example.com'),
  platform: z.enum(PLATFORMS).default('random').describe('Social platform the visit appears to come from ("random" picks one per session).'),
  socialStayTimeSeconds: z.number().min(1).max(600).default(5).describe('Seconds to spend on the social platform before continuing.'),
  socialRedirectDelaySeconds: z.number().min(0).max(600).default(2).describe('Seconds to wait before moving on to the target page.'),
  socialLaunchBehavior: z.enum(['platform_then_target', 'link_then_target', 'platform_then_link_then_target']).optional().describe('Order of visits (default platform_then_target).'),
  ...commonShape,
};

const gmapsShape = {
  businessName: z.string().min(1).max(200).describe('Business or place name to search for on Google Maps.'),
  keyword: z.string().max(200).optional().describe('Search text (defaults to the business name).'),
  website: z.string().max(2048).optional().describe('The business website to open from the Maps listing (optional).'),
  mapsLoadWaitMs: z.number().int().min(500).max(120000).optional().describe('Wait for Maps to load, milliseconds.'),
  searchResultWaitMs: z.number().int().min(500).max(120000).optional().describe('Wait for search results, milliseconds.'),
  websiteLoadWaitMs: z.number().int().min(500).max(120000).optional().describe('Wait for the website to load, milliseconds.'),
  typingDelayMs: z.number().int().min(10).max(2000).optional().describe('Delay between typed characters, milliseconds.'),
  stepRetryAttempts: z.number().int().min(1).max(20).optional().describe('Retries for each step.'),
  stepRetryDelayMs: z.number().int().min(500).max(60000).optional().describe('Pause between step retries, milliseconds.'),
  ...commonShape,
};

// A whole campaign definition (used by schedules).
const campaignSchema = z.object({
  mode: z.enum(MODES).describe('direct | organic | referral | gmaps | rpa (replay a saved recording)'),
  url: z.string().max(2048).optional(),
  keywords: organicShape.keywords.optional(),
  engine: organicShape.engine.optional(),
  maxPages: organicShape.maxPages.optional(),
  customEngine: organicShape.customEngine,
  internalLinkVisitTimeMs: organicShape.internalLinkVisitTimeMs,
  articlesToRead: organicShape.articlesToRead,
  recordingId: z.string().max(100).optional().describe('rpa mode: id of the saved recording to replay (see rpa_list_recordings).'),
  speed: z.number().min(0.25).max(10).optional().describe('rpa mode: playback speed multiplier.'),
  platform: referralShape.platform.optional(),
  socialStayTimeSeconds: referralShape.socialStayTimeSeconds.optional(),
  socialRedirectDelaySeconds: referralShape.socialRedirectDelaySeconds.optional(),
  socialLaunchBehavior: referralShape.socialLaunchBehavior,
  businessName: gmapsShape.businessName.optional(),
  keyword: gmapsShape.keyword,
  website: gmapsShape.website,
  mapsLoadWaitMs: gmapsShape.mapsLoadWaitMs, searchResultWaitMs: gmapsShape.searchResultWaitMs,
  websiteLoadWaitMs: gmapsShape.websiteLoadWaitMs, typingDelayMs: gmapsShape.typingDelayMs,
  stepRetryAttempts: gmapsShape.stepRetryAttempts, stepRetryDelayMs: gmapsShape.stepRetryDelayMs,
  ...commonShape,
}).describe('The campaign to run. Same options as the matching start_* tool; "mode" selects which fields apply.');

const whenSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delay'),
    hours: z.number().int().min(0).max(8760).default(0),
    minutes: z.number().int().min(0).max(59).default(0),
    seconds: z.number().int().min(0).max(59).default(0),
  }).describe('Run once, this long from now.'),
  z.object({
    type: z.literal('datetime'),
    at: z.string().min(8).describe('When to run once. ISO 8601 — include a UTC offset (2026-12-01T09:30:00+05:00 or ...Z). Without one it is read in the backend machine\'s local time.'),
  }).describe('Run once at a specific date and time.'),
  z.object({
    type: z.literal('recurring'),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('Days of the week: 0=Sunday … 6=Saturday.'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).describe('Time of day "HH:MM" (24h, backend machine local time).'),
  }).describe('Run every week on the chosen days.'),
]);

const actionSchema = z.object({
  type: z.enum(['click', 'input', 'key', 'scroll', 'navigate']),
  selector: z.string().max(2000).optional(),
  value: z.string().max(2000).optional(),
  key: z.string().max(100).optional(),
  url: z.string().max(2048).optional(),
  x: z.number().optional(), y: z.number().optional(), ts: z.number().optional(),
});

// ── map tool arguments → the backend's start request ───────────────────────────
const RENAMES = {
  delayMinSeconds: 'delayMin', delayMaxSeconds: 'delayMax',
  internalLinkReadTimeMs: 'internalLinkReadTime',
  socialStayTimeSeconds: 'socialStayTime', socialRedirectDelaySeconds: 'socialRedirectDelay',
};
function toRequestBody(mode, args) {
  const body = { mode };
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || k === 'mode') continue;
    body[RENAMES[k] || k] = v;
  }
  return body;
}

module.exports = {
  z, ENGINES, PLATFORMS, MODES,
  privacyShape, commonShape, directShape, organicShape, referralShape, gmapsShape,
  campaignSchema, whenSchema, actionSchema, toRequestBody,
};
