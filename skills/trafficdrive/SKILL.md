---
name: trafficdrive
description: Operate the TrafficDrive desktop app through its MCP server — start, monitor, pause, stop, schedule and diagnose browser-traffic campaigns (direct, organic search, social referral, Google Maps, record-and-replay), and manage proxies, browsers, user agents and privacy/fingerprint protections. Use whenever the user mentions TrafficDrive, the trafficdrive MCP or any of its tools (start_direct_traffic, start_organic_search_traffic, list_campaigns, wait_for_campaign, add_proxies, verify_privacy, create_schedule, rpa_start_recording …), or asks to load-test or smoke-test a site with real browsers, send test visits, schedule visits, rotate proxies or run a saved campaign — even if they never say "MCP".
---

# TrafficDrive

TrafficDrive drives real browsers (Playwright) to visit pages. The MCP server gives you the same controls as the desktop dashboard: 52 tools, 15 resources (`trafficdrive://…`) and 5 prompts. The tool schemas reach you through MCP, so this skill does not repeat them. It covers what the schemas cannot tell you: the order to work in, the traps, and what to ask the user first.

## Ground rules

These exist because a campaign opens real browsers against real websites. Mistakes cost the user time and sometimes money, and they are hard to undo.

1. **Check the target is the user's to test.** Run campaigns against sites the user owns, operates or has permission to test. If the target looks like someone else's site, a competitor, an ad, or a Maps listing the user doesn't manage, ask before starting. Don't use TrafficDrive to inflate ad clicks, game rankings or fake engagement on properties the user doesn't control.
2. **Prefer `direct` mode for testing.** `organic` and `gmaps` modes interact with third-party services (a search engine, Google Maps) whose terms the user is responsible for. Mention this once when the user picks one of them. Don't lecture.
3. **Start small.** Run 1–3 sessions first. Scale up only after the small run completed cleanly and the user agreed to the larger numbers. A mistake in a 3-session run costs seconds. In a 5,000-session run it costs hours.
4. **Ask before anything destructive or irreversible:** `stop_all_campaigns`, `clear_proxies`, `remove_proxies`, `validate_proxies` with no `proxies` argument (by default it **deletes** the dead proxies from the list; `removeDead: false` only marks them), and all `delete_*` tools. Name the consequence in your question.
5. **Keep secrets out of your replies.** Proxies can carry `user:pass`. Tools mask credentials when reading back. Don't repeat the ones the user gave you, and don't paste them into saved campaigns, notes or logs you write.
6. **Never invent paths or URLs for the app to fetch.** `customBrowserPath` only accepts paths from `list_browsers`. `install_browser` takes an id from `list_browser_catalog`, never a download URL. If a call is refused for this reason, use the proper tool rather than trying to get around it.
7. **Don't try to beat CAPTCHAs.** The app only *pauses* when it detects one, so a person can solve it in a visible window. See `references/troubleshooting.md`.

## The workflow

1. **`get_status`** first. It shows the connection mode, the version, running campaigns and loaded proxies.
   - `connect` means attached to the running desktop app. Campaigns you start appear in its dashboard, labelled "AI assistant".
   - `embedded` means a private backend that lives only as long as this MCP session. Campaigns and schedules end with it. Say so before promising "run it tonight".
2. **Choose the mode** (table below). Call `get_catalog` if you need valid engines, platforms, devices or limits.
3. **Optional setup:** proxies (`add_proxies`) and privacy (`preview_privacy_config`, then `verify_privacy`).
4. **Propose concrete settings** (sessions, threads, visit time, device, headless, privacy) and wait for a yes unless the user already gave exact numbers.
5. **Start** with the matching `start_*` tool. It returns a campaign id such as `proc_3`.
6. **Follow it.** Use `wait_for_campaign` (progress streams while it waits; call it again after a timeout). To read what happened, use `get_campaign_logs` and pass the returned `nextSince` back as `since` so you only fetch new lines. Don't poll `get_campaign` in a tight loop.
7. **Report the outcome:** completed vs failed vs stopped sessions (from `summary`), any repeating error, and what you'd change. Quote the log lines that back it up.
8. **Clean up what you started.** `loop: true` campaigns never finish on their own. Tell the user and offer `stop_campaign`. Finished campaigns are removed after 10 minutes and then return "not found", so read the results before then.

## Choosing a mode

| The user wants to… | Tool | Notes |
|---|---|---|
| load-test or smoke-test a page, check it on mobile | `start_direct_traffic` | Default choice: simplest, fewest outside dependencies. |
| exercise the search → result → site path | `start_organic_search_traffic` | Needs `keywords`. `engine` is google (default), bing, yahoo, duckduckgo, yandex or ask. `customEngine.searchUrl` takes `{query}`. `maxPages` 1–10. Search engines may show CAPTCHAs. |
| see how a page behaves for visitors from a social site | `start_referral_traffic` | `platform` is random (default), facebook, youtube, tiktok, instagram, twitter, reddit, linkedin or pinterest. |
| exercise a Google Maps listing flow | `start_google_maps_traffic` | `businessName` is required. `website` is optional. |
| repeat a recorded click path | `rpa_play_recording`, or mode `rpa` in schedules and saved campaigns | See `references/recipes.md`. |

## Defaults and traps

- **Defaults:** `sessions=1`, `threads=1`, `headless=true`, `device=desktop`, `visitTimeMs=20000`, `loop=false`. No privacy protections are applied unless you pass `privacyProfile` or `privacyFeatures`.
- **Units differ by option.** `visitTimeMs`, `scrollDownWaitMs` and the `gmaps` waits are **milliseconds**. `delayMinSeconds`, `delayMaxSeconds`, `socialStayTimeSeconds`, `loopDelaySeconds` and `timeoutSeconds` are **seconds**. A visit time of `20` means 20 ms, which the tool rejects (minimum 1000). Check each value you type.
- **`useLoadedProxies` defaults to `true`.** If proxies are loaded, every campaign uses them, one per session in round-robin. When the user wants a direct connection, pass `false`, or check `list_proxies` first and mention it.
- **Proxies are checked on the campaign's own address before it starts.** Only the ones that can open that page are used (`proxyCheck` in the result says how many of how many). The check takes a few seconds, up to a minute. If none can open it the call fails with "None of the N proxies could open …". Tell the user and let them choose: load better proxies, or run without proxies. Do **not** quietly retry with `useLoadedProxies: false`: that sends their own IP address to the site.
- **Saved campaigns default to 1000 sessions** when `sessions` is omitted in `save_campaign`. When running one with `run_saved_campaign`, pass `overrides: {"sessions": 3}` for a first run.
- **`threads` is concurrency**, not volume. Browsers are heavy. Raise threads gradually, and respect the `limits` that `get_catalog` reports (defaults: 50 threads, 100000 sessions).
- **`headless: false`** opens visible windows. Use it for 1–3 session debugging runs, and whenever a person may need to solve a CAPTCHA.

## Privacy in one minute

- `privacyProfile`: `none`, `balanced` (17 core fingerprint and header protections) or `stealth` (all 34). `privacyFeatures` is an explicit ID list and **overrides** the profile.
- The 34 protections fall into three groups: Browser Fingerprint (20, such as `webgl-spoof`, `canvas-noise`, `timezone-spoof`), Network Privacy (7, such as `webrtc-leak`, `cookie-sanitize`, `etag-clear`) and Sensor Privacy (7, such as `battery-spoof`, `usb-spoof`). Call `list_privacy_features` for what each one does.
- Trade-offs worth telling the user: `webrtc-leak` blocks peer-to-peer calls, `cookie-sanitize` blocks analytics cookies, `etag-clear` disables the HTTP cache. A target that relies on any of these can behave differently.
- `preview_privacy_config` shows exactly what would be enabled and starts nothing. `verify_privacy` launches a ~5 s headless browser against a **local** test page and reports what a website could observe. It errors if you give it neither a profile nor features. Offer it whenever the user cares that the protections work.

## Proxies

- Accepted formats: `host:port`, `host:port:user:pass`, `user:pass@host:port`, `scheme://[user:pass@]host:port` (http, https, socks4, socks5). Duplicates are ignored.
- **Automatic proxies** (`proxy_automation`, on by default in the desktop app): working proxies are saved and reloaded at every start and re-checked in the background. New ones are fetched from the sources **every hour** (`fetchEveryMinutes`, default 60; 0 = only when fewer than the target are ready) and whenever fewer than the target are ready; each fetch is checked against the last campaign's address and only working proxies are kept. A failed fetch is retried after 10 minutes. While proxies are loaded, campaigns use them, so if the user does not want proxies, pass `useLoadedProxies: false` or switch automation off (ask first).
- Logins are used exactly as given. For rotating providers that need a different session per browser, put `{session}` in the user name (for example `user-session-{session}`); Bright Data's `brd-customer-…-zone-…` names get a session automatically. Chrome cannot use SOCKS proxies that need a password, so those are always reported dead (reason `socks-login`): suggest the provider's HTTP port with the same login instead.
- Prefer the user's own proxies. `scrape_free_proxies` downloads the public lists that are switched on (`list_proxy_sources` shows them; `set_proxy_source_enabled` switches one; `sourceIds` limits one run) in about 15 seconds. Those proxies are slow, short-lived and untrusted: offer it only if the user agrees, and say not to send sensitive traffic through them. Only the user can add a new source, in the app, so don't try.
- `validate_proxies` tests many proxies at once, so thousands take about a minute, not an hour. A proxy only counts as working if the real test server answers through it. With no `proxies` argument it checks the loaded list and, by default, **removes the dead ones**, so ask first (`removeDead: false` keeps them marked instead). `stopAfterWorking: 50` ends the run as soon as 50 work, and `onlyUnchecked: true` skips proxies already checked. Typically only about one free proxy in five works.
- Pass `testUrl` (the campaign's address) to `validate_proxies` to keep only proxies that can open that exact page, HTTPS included. Many free proxies pass the quick test yet cannot open an HTTPS site, so for a real campaign `testUrl` is the check that matters. Only public web addresses are accepted.
- Giving `proxies` to `validate_proxies` tests only those entries and removes nothing.

## Scheduling, saved campaigns, recordings

- **Schedules** (`create_schedule`) run inside the backend even with no dashboard open, but the app must be running at fire time. A one-time run more than 5 minutes late is skipped. `when` is `delay` (hours, minutes, seconds), `datetime` (ISO 8601 — include a UTC offset) or `recurring` (days 0=Sunday…6=Saturday plus `HH:MM` in the backend machine's local time). State which timezone you assumed. Afterwards call `list_schedules` and give the user the `nextRunAt`.
- **Saved campaigns** are shared with the dashboard's Campaigns page. Anything you save appears there, and the user's dashboard edits are visible to you.
- **Recordings** (`rpa_start_recording`) need a *person* to perform the clicks in the opened window. You can't do it for them. Tell them to go ahead, then call `rpa_stop_recording` when they say they're done. `rpa_list_recordings` only lists recordings made through the backend/MCP, not ones kept in the dashboard page.

## Other things you can read

Resources give cheap read-only views and can be subscribed to for change notifications: `trafficdrive://status`, `catalog`, `campaigns`, `campaigns/{id}`, `campaigns/{id}/logs`, `proxies`, `browsers`, `schedules`, `privacy/features`, `privacy/profiles`, `rpa/recordings`, `saved-campaigns`, `catalog/user-agents`, `catalog/resolutions`, `catalog/browsers`.

Prompts (`plan_campaign`, `diagnose_campaign`, `choose_privacy_profile`, `proxy_health_check`, `schedule_campaign`) are ready-made versions of the workflows here. If the user invoked one, follow it.

## More detail

- `references/recipes.md` has step-by-step playbooks with example tool arguments: smoke test, load test with proxies and privacy, organic check, scheduling, record and replay, saved campaigns, browsers.
- `references/troubleshooting.md` covers symptoms and their usual causes: connection problems, failing or stuck campaigns, CAPTCHAs, proxy and browser problems, schedules that didn't fire.
