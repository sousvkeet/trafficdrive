# TrafficDrive troubleshooting

Symptom → usual cause → what to do. Read the evidence first (`get_campaign`, then `get_campaign_logs` with `level: "error"` and `"warn"`). Quote the log lines when you explain a cause to the user. Don't restart or stop a campaign to "see if it helps" unless the user asked.

Contents: Connection · Campaign won't start · Failing or slow sessions · CAPTCHAs · Proxies · Browsers · Privacy checks · Schedules

---

## Connection

| Symptom | Cause and fix |
|---|---|
| `get_status` shows `embedded`, but the user expected their desktop app | The app wasn't running when the MCP server started, or its **AI access** switch is off (AI Assistant page). In either case the app doesn't publish its connection file, so the server fell back to a private backend. Ask the user to start the app and switch AI access on, then restart the MCP server. Campaigns you ran meanwhile are not in the dashboard. |
| Tool error mentioning the token being rejected (HTTP 401) | The app was restarted and issued a new token. Restart the MCP server so it re-reads the connection file. |
| Connection refused, or `connect` mode can't find the app | The app isn't running, or AI access is off. The server was started with `--mode connect`, so it never starts its own backend. Ask the user to start the app, or restart the server in `auto` or `embedded` mode. |
| "not found" (404) for a campaign id | Finished campaigns are dropped after 10 minutes, or the id is wrong. Use `list_campaigns`. |
| "…not in a state that allows this action" (409) | For example resuming a campaign that isn't paused. Check its status with `get_campaign`. |

If the tools don't appear at all, the MCP client wasn't configured, or the server failed to start. That's outside this skill. Point the user at the AI Assistant page in the app, which shows the exact setup command for their assistant.

## A campaign won't start

- **A `customBrowserPath` error:** the path isn't a known browser. Use `list_browsers`, or register it with `add_custom_browser`.
- **A validation error on an option:** the tool names the field. The common slip is units. `visitTimeMs` is milliseconds with a minimum of 1000, and the `…Seconds` options are seconds.
- **Limits:** `threads` is capped at 50 and `sessions` at 100000 by default. `get_catalog` shows the real limits.
- **Organic mode with no keywords, Maps without `businessName`, `rpa` without `recordingId`:** these modes require them.

## A campaign will not start: "None of the N proxies could open …"

The campaign's proxies were each tried on the campaign's own address and none could open it, so the campaign was refused instead of running without proxies. Common reasons: the proxies are free ones that cannot tunnel HTTPS, the site blocks proxy traffic, or the proxies have all died since they were loaded. Tell the user and offer: load better proxies (their own, or `scrape_free_proxies` then `validate_proxies` with `testUrl` set to the campaign's address), or run without proxies (`useLoadedProxies: false`) only if they say so. Results are remembered for about 20 minutes, so retrying at once will not change the answer.

If the log says the general test was used instead, the address would not open even without a proxy (some sites turn away anything that is not a real browser), so the proxies were only checked in general.

## Failing or slow sessions

| Log pattern | Likely cause | What to try |
|---|---|---|
| Navigation timeout | The site is slow or blocking, or a proxy is dead or slow. | Retest with `useLoadedProxies: false` and 1 session. If that works, it's the proxies. Raise `visitTimeMs` only if the page itself is slow. |
| Proxy connection errors | Dead, wrong-protocol or credential-less proxies. | `list_proxies`, then offer `validate_proxies` (it removes dead ones, so ask first). Check that the scheme matches (socks5 vs http). |
| Browser launch failure | No usable browser. | `list_browsers`. In a source checkout, `npm run install-browsers` downloads Chromium. Otherwise add a browser with `add_custom_browser`. |
| "not found in results" (organic) | The site didn't appear in the first `maxPages` result pages for that keyword. | This is a visibility finding, not a fault. Raise `maxPages` (max 10), try other keywords, or confirm the `url` matches the site's real domain. |
| Sessions stall, then continue | A CAPTCHA pause (next section), or the campaign is paused. | Check `status` in `get_campaign`, and `resume_campaign` if paused. |

High failure rate in a big run: `pause_campaign`, report the pattern to the user, and let them choose between fixing and continuing. Reduce `threads` first: every thread is a full browser, and too many can overload the machine and cause timeouts of their own. `get_campaign` → `config` shows the settings the run actually used.

## CAPTCHAs

The app only **detects** a CAPTCHA and **pauses** that session so a person can solve it by hand in a visible window. It doesn't solve them. So:

- In `headless: true` runs nobody can solve it. The session waits. Tell the user, and suggest re-running a small batch with `headless: false`, fewer threads, longer `delayMinSeconds` / `delayMaxSeconds`, or different (non-free) proxies.
- Don't look for ways to automate around CAPTCHAs or encourage the user to. If a site or search engine is challenging the traffic, that's the signal to stop or slow down.

## Proxies

- Free scraped proxies (`scrape_free_proxies`) are slow, short-lived and untrusted. A high failure rate with them is expected. Suggest the user's own proxies.
- `validate_proxies` with no `proxies` argument checks the loaded list and removes the dead ones unless `removeDead` is `false`. With a `proxies` list it tests only those and removes nothing.
- "Cannot reach the test server" means the computer itself cannot reach the internet (or a firewall blocks the test server). Nothing was marked dead or removed. Fix the connection and run it again.
- A low share of working proxies is normal for free lists (typically around one in five). A source that fails shows its reason in `scrape_free_proxies` (for example `HTTP 502` when the provider is down); try again later or switch it off with `set_proxy_source_enabled`.
- If sessions seem to ignore your proxy settings, check that proxies are loaded at all (`list_proxies`) and that `useLoadedProxies` wasn't set to `false`.
- Credentials are masked by every tool. You can't read them back. If the user needs to correct one, remove and re-add the proxy.

## Browsers

- `install_browser` works on Windows builds only. Elsewhere, install normally and use `add_custom_browser`.
- `get_browser_install_status` shows downloads in progress (percent, extracting, complete or error).
- `launch_browser` opens a window on the user's desktop to look at. A failure there says nothing about campaigns.

## Privacy checks

- `verify_privacy` errors when neither `privacyProfile` nor `privacyFeatures` is given.
- The result has `passed`, `failed` and a `failedChecks` list naming each protection that didn't hold. Report which ones and what a site could observe. Don't claim the profile "works" if `failed` is above zero.
- If a target site misbehaves with protections on, `webrtc-leak`, `cookie-sanitize` and `etag-clear` are the likeliest culprits. They block peer-to-peer calls, analytics cookies and HTTP caching. Retry the small run with `privacyFeatures` that leaves them out.

## Schedules

| Symptom | Cause |
|---|---|
| The schedule didn't fire | The app (or the embedded MCP session) wasn't running at the time, or it was more than 5 minutes late (one-time runs that late are skipped). `list_schedules` shows `lastError`, `lastRunAt` and `runCount`. |
| It fired at the wrong hour | A `datetime` without a UTC offset is read in the backend machine's local time, and `recurring` times are always local time. Recreate it with an explicit offset, or restate the timezone you assumed. |
| A one-time schedule won't re-enable | Re-enabling restarts its timer. A `datetime` in the past is rejected. Create a new schedule instead. |
| The schedule isn't in the dashboard | Schedules made with `create_schedule` run in the backend (`runner: "server"`). They are listed by `list_schedules`, and the dashboard's own schedules are separate. |
