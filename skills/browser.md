---
name: browser
description: Web browsing, scraping, form filling, login flows, scraping, downloads, and uploads via Playwright MCP (`browser_*` tools). Use when the task needs a real browser.
triggers: browser, browse, scrape, web page, click, fill form, login, automate, screenshot, navigate, website, open page, test site, post tweet, upload file
---

## Quick model
The `browser_*` tools come from the Playwright MCP server. The browser is real Chromium, with a persistent profile dir at `<dataDir>/browser/default/`. Anything the user logged into via the `daemora browser` CLI is automatically inherited — they don't have to re-auth.

Every action returns a fresh accessibility snapshot in its result. Element refs (`e1`, `e2`, ...) come from that snapshot — stable inside one snapshot, regenerated each action. **You don't need to call `browser_snapshot` after every action; the result already includes one.**

## Standard flow
1. `browser_navigate(url)` — go to the URL. Read the snapshot in the result.
2. `browser_click({target: "e5", element: "Sign in button"})` — click using a ref. The `element` field is human-readable, used for safety/permission narration.
3. `browser_type({target: "e7", text: "...", submit?: true})` — type into a field. `submit:true` presses Enter after.
4. `browser_fill_form({fields: [{target, value}, ...]})` — multi-field fill in one call. Faster than several `browser_type`s.
5. After a state-changing action, look at the new snapshot for confirmation: success toast, URL change, list update. If absent → action probably failed silently → check `browser_console_messages({level: "error"})`.

## Login flow
- Try the action assuming the user is already logged in (the persistent profile remembers).
- If you hit a login wall, ask: "Want me to fill creds, or run `daemora browser` once and log in there?" The CLI is usually faster — one-time login per profile.
- For 2FA: get to the prompt, then `reply_to_user("I'm at the 2FA step — enter the code in the visible window, then say 'go'")` and pause. Don't try to brute through.

## File uploads — important
**Use `browser_file_upload({paths: [...]})` BEFORE clicking the file picker button.** Playwright MCP attaches files to the next file chooser that opens, so you don't need a selector for the hidden `<input type=file>`. This is how X/Facebook/LinkedIn uploads work cleanly — sites with multiple hidden file inputs no longer trip you up.

## Waits
- `browser_wait_for({text: "..."})` — wait for text to appear.
- `browser_wait_for({textGone: "..."})` — wait for text to disappear.
- `browser_wait_for({time: 2})` — fixed 2s sleep (last resort).
- **Never** use `networkidle`-style waits on live sites (X, Discord, Slack, Gmail) — persistent connections mean the network never goes idle.

## Tabs
- `browser_tabs({action: "new", url: "..."})` — open a new tab.
- `browser_tabs({action: "select", index: 1})` — switch.
- `browser_tabs({action: "close", index: 1})` — close.
- `browser_tabs({action: "list"})` — list open tabs.

## When DOM-event clicks fail (canvas, anti-bot widgets)
- `browser_take_screenshot()` — get the visual state.
- Identify pixel coordinates of what you want to click from the screenshot.
- `browser_mouse_click_xy({x, y})` — click at that pixel. Bypasses DOM-event listeners that some anti-bot scripts watch.

## Storage (cookies / localStorage / sessionStorage)
- `browser_cookie_list({domain?})`, `browser_cookie_get({name})`, `browser_cookie_set({...})`, `browser_cookie_delete({name})`, `browser_cookie_clear()`.
- `browser_localstorage_list()`, `browser_localstorage_get/set/delete/clear`.
- Same shape for sessionStorage.
- `browser_storage_state({filename?})` — save full auth state (cookies + localStorage) to a file for later reuse.
- `browser_set_storage_state({filename})` — restore a saved auth state.

## Network
- `browser_network_requests({filter?: "regex"})` — list all requests since page load.
- `browser_network_request({index})` — full headers/body of a specific request (for API debugging).
- `browser_route({pattern, status, body})` — mock network responses (great for skipping slow APIs).

## Output discipline
- After any action, look at the snapshot it returned. If the page changed unexpectedly (modal, redirect, error banner), pivot — don't blindly repeat.
- Be terse. `"Posted. Tweet ID 1234567"` beats narrating each click.
- Always `browser_close()` at end of task so the profile flushes.

## Don't
- Don't call `browser_snapshot` after every action — actions already return one.
- Don't write CSS selectors when refs are available — refs are derived from the same snapshot you're reading.
- Don't claim a click "worked" without checking the next snapshot.
- Don't use `networkidle` waits.
- Don't paste credentials, tokens, or session strings into your reply.
