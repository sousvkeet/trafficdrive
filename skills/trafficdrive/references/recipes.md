# TrafficDrive recipes

Step-by-step playbooks. Each fenced block is one tool call: the tool name follows `json` on the opening line and the arguments are the JSON body. Values are examples, so replace them with the user's. Ids (`proc_3`, `rec_…`, `camp_…`, `sched_…`) are made up here. Use the ones the tools actually return. Read `SKILL.md` first for the ground rules.

Contents: 1 Smoke test · 2 Load test with proxies and privacy · 3 Organic search check · 4 Referral check · 5 Scheduling · 6 Record and replay · 7 Saved campaigns · 8 Browsers, user agents, resolutions · 9 Diagnose a failing campaign

---

## 1. Smoke test a page (the default first step)

Goal: prove a URL loads and the app works before anything bigger. Use a visible window so the user can watch.

```json get_status
{}
```

```json start_direct_traffic
{"url": "https://staging.example.com", "sessions": 2, "threads": 1, "headless": false, "visitTimeMs": 15000, "useLoadedProxies": false}
```

```json wait_for_campaign
{"id": "proc_1", "timeoutSeconds": 120}
```

Report `summary.completed` / `summary.failed`. If anything failed, go to recipe 9. Note the explicit `useLoadedProxies: false`: a smoke test should isolate the site from proxy problems.

For a mobile check, add `"device": "mobile"`. For specific screen sizes, pick one with `list_resolutions` and pass its width and height as `viewportWidth` / `viewportHeight` (desktop only), or set `"autoRotateResolutions": true`.

## 2. Load test with proxies and privacy

Only after recipe 1 succeeded and the user approved the numbers.

```json add_proxies
{"proxies": ["203.0.113.10:8080", "socks5://user:pass@203.0.113.11:1080"]}
```

```json preview_privacy_config
{"privacyProfile": "balanced"}
```

```json verify_privacy
{"privacyProfile": "balanced", "device": "desktop"}
```

```json start_direct_traffic
{"url": "https://staging.example.com", "sessions": 200, "threads": 5, "visitTimeMs": 20000, "delayMinSeconds": 1, "delayMaxSeconds": 4, "scrollDirection": "random", "internalLinkNavigation": true, "internalLinkCount": 3, "privacyProfile": "balanced"}
```

- Campaigns verify their proxies on the target address by themselves before starting, so this step is optional. To clean the list up front for one site: `validate_proxies` with `{"testUrl": "https://www.example.com/", "stopAfterWorking": 50}` keeps only proxies that can open that page.
- Need working free proxies quickly? Scrape, then stop checking as soon as there are enough: `scrape_free_proxies`, then `validate_proxies` with `{"stopAfterWorking": 30}`. Both calls take well under a minute.

- Keep `threads` modest at first (3–5). Each thread is a full browser.
- `delayMinSeconds` / `delayMaxSeconds` pace each thread. They are **seconds**.
- With proxies loaded and `useLoadedProxies` left at its default of `true`, sessions rotate through the proxies round-robin.
- Follow with `wait_for_campaign` calls (each up to a few minutes). Between them, read `get_campaign_logs` with `level: "error"` and the `since` cursor to catch problems early. If failures pile up, `pause_campaign`, tell the user, and let them decide whether to resume or stop.

## 3. Organic search check

```json start_organic_search_traffic
{"url": "https://www.example.com", "keywords": ["example widgets", "buy example widgets"], "engine": "google", "maxPages": 3, "sessions": 3, "threads": 1, "headless": false, "visitTimeMs": 20000}
```

- Each session picks one keyword at random and looks through `maxPages` result pages for the site. If it isn't found, the log says so. That is information about visibility, not a bug in the tool.
- Use `"headless": false` for small runs: search engines may show a CAPTCHA, and only a visible window lets the user solve it.
- For an engine that isn't built in: `"customEngine": {"name": "Brave", "searchUrl": "https://search.brave.com/search?q={query}"}`. It overrides `engine`.
- Reading articles on the target site: `articlesToRead` (0–20) and `internalLinkVisitTimeMs` (milliseconds).

## 4. Referral check

```json start_referral_traffic
{"url": "https://www.example.com/landing", "platform": "reddit", "socialStayTimeSeconds": 8, "socialRedirectDelaySeconds": 2, "sessions": 3, "headless": false}
```

`platform: "random"` varies it per session. The `social*` options are seconds.

## 5. Scheduling

Confirm timezone and settings with the user, then create the schedule. The campaign body uses the same option names as the start tools, plus `mode`.

Once, 30 minutes from now:

```json create_schedule
{"name": "Staging check in 30 min", "when": {"type": "delay", "hours": 0, "minutes": 30, "seconds": 0}, "campaign": {"mode": "direct", "url": "https://staging.example.com", "sessions": 5, "threads": 2}}
```

Once, at a specific moment (always include the offset):

```json create_schedule
{"name": "Morning run", "when": {"type": "datetime", "at": "2026-12-01T09:30:00+05:00"}, "campaign": {"mode": "direct", "url": "https://staging.example.com", "sessions": 10, "threads": 2}}
```

Every Monday and Thursday at 18:00 (backend machine's local time):

```json create_schedule
{"name": "Twice weekly", "when": {"type": "recurring", "days": [1, 4], "time": "18:00"}, "campaign": {"mode": "organic", "url": "https://www.example.com", "keywords": ["example widgets"], "sessions": 5, "threads": 1}}
```

Then confirm it:

```json list_schedules
{}
```

Tell the user the `nextRunAt`, and remind them the app must be running then (and that in `embedded` mode the backend ends with this session). To test a schedule without waiting, use `run_schedule_now`. To pause it, use `set_schedule_enabled` with `enabled: false`.

## 6. Record and replay a browser session

Recording needs a person at the screen.

```json rpa_start_recording
{"url": "https://www.example.com", "headless": false}
```

Tell the user: "A browser window is open. Do the clicks, typing and scrolling you want recorded, then tell me when you're done." Don't call `rpa_stop_recording` until they say so. `rpa_get_status` shows the action count if they ask whether it's capturing.

```json rpa_stop_recording
{"save": true, "name": "Checkout walkthrough"}
```

Replay once and wait:

```json rpa_play_recording
{"recordingId": "rec_m3k9x2ab12", "speed": 1, "headless": true}
```

Replay as a campaign you can pause, stop or loop (and follow with `wait_for_campaign`):

```json rpa_play_recording
{"recordingId": "rec_m3k9x2ab12", "speed": 1, "headless": true, "background": true}
```

Schedule it with `"campaign": {"mode": "rpa", "recordingId": "rec_m3k9x2ab12", "speed": 1}`. Take the recording id (looks like `rec_m3k9x2ab12`) from `rpa_stop_recording` or `rpa_list_recordings`.

## 7. Saved campaigns

Saved campaigns appear on the dashboard's Campaigns page.

```json save_campaign
{"name": "Landing page smoke test", "mode": "direct", "url": "https://staging.example.com", "sessions": 3, "options": {"threads": 1, "headless": true, "visitTimeMs": 15000}}
```

Run it later with a small override (the stored default is 1000 sessions when none is given):

```json run_saved_campaign
{"id": "camp_m3k9x2ab12", "overrides": {"sessions": 2, "headless": false}}
```

Updating: pass the `id` to `save_campaign` and only the fields you give change. But `options`, if given, **replaces** the stored options entirely. Read the saved campaign first and send the full set.

## 8. Browsers, user agents, resolutions

- `list_browsers` shows usable browsers. Only these paths are accepted for `customBrowserPath`.
- Register an existing Chromium-based browser with `add_custom_browser` (`name`, absolute `path`).
- `list_browser_catalog` is the app's Browser Library. `install_browser` (by catalog id) only works on Windows builds. On Linux or macOS, tell the user to install the browser normally and then register it with `add_custom_browser`.
- `launch_browser` opens a browser window on the user's desktop for them to look at. Campaigns open their own.
- `list_user_agents` (filter by `category`, `browser`, `os`, `search`) gives real User-Agent strings. Pass chosen ones as `userAgents`, with `"uaMode": "rotate"` to vary per session or `"first"` to always use the first.

```json start_direct_traffic
{"url": "https://staging.example.com", "sessions": 3, "device": "mobile", "userAgents": ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"], "uaMode": "first"}
```

## 9. Diagnose a failing campaign

1. `get_campaign` gives the status, per-session counts, settings and recent logs.
2. `get_campaign_logs` with `"level": "error"`, then `"warn"`, to find the repeating pattern.
3. Match the pattern against `troubleshooting.md`.
4. Check proxies with `list_proxies` (it shows how many are working, dead and not checked yet); offer `validate_proxies` (it removes dead ones by default, so ask).
5. If it looks fingerprint-related, offer `verify_privacy` with the same settings.
6. Report the most likely cause with the log lines as evidence, and give specific changes to try. Don't stop or restart the campaign unless the user asks.

```json get_campaign_logs
{"id": "proc_1", "level": "error", "limit": 50}
```
