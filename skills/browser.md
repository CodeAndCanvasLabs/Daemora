---
name: browser
description: Web browsing, scraping, form filling, testing, automation with accessibility snapshots
triggers: browser, browse, scrape, web page, click, fill form, login, automate, screenshot, navigate, website, open page, test site, check page
---

## Snapshot-First Workflow (MANDATORY)

1. **Navigate** → `browserAction("navigate", "https://example.com")`
2. **Snapshot** → `browserAction("snapshot")` — get ARIA tree with refs (e1, e2, ...)
3. **Act using refs** → `browserAction("click", "e5")`, `browserAction("fill", "e3", "hello")`
4. **Verify** → snapshot again or screenshot to confirm result
5. **Repeat** until task is done

## Why Refs > CSS Selectors
- Refs (e1, e5) come from accessibility tree — stable, semantic
- CSS selectors break on class name changes, dynamic IDs
- Always take a fresh snapshot after navigation or major page changes

## Key Actions

### Navigation
- `navigate(url)` — go to URL (localhost allowed)
- `reload`, `goBack`, `goForward`

### Inspection
- `snapshot()` — ARIA tree with refs. Use `snapshot("interactive")` for only clickable/fillable elements
- `screenshot(path?)` — pixel capture. Use `screenshot(selector)` for element screenshot
- `getText(selector|ref?)` — text content
- `getContent(selector?)` — innerHTML
- `getLinks` — all links on page
- `console(filter?,limit?)` — browser console logs. filter: "all", "error", "warn", "log"

### Interaction
- `click(ref|selector, opts?)` — click. opts: "double", "right", "middle"
- `fill(ref|selector, value)` — clear + fill input
- `type(ref|selector, text)` — keystroke-by-keystroke typing
- `hover(ref|selector)` — mouse hover
- `selectOption(ref|selector, value)` — dropdown selection
- `pressKey(key)` — Enter, Tab, Escape, ArrowDown, etc.
- `scroll(direction|ref|selector, amount?)` — up/down/left/right or scroll to element
- `drag(source, target)` — drag and drop

### Waiting
- `waitFor(selector)` — wait for element
- `waitFor("text:Loading complete")` — wait for text on page
- `waitFor("url:/dashboard")` — wait for URL change
- `waitFor("js:document.readyState==='complete'")` — JS predicate
- `waitFor("networkidle")` — wait for network idle
- `waitForNavigation(timeout?)` — wait for page navigation

### State
- `getCookies(domain?)`, `setCookie(json)`, `clearCookies`
- `getStorage(local|session, key?)`, `setStorage(json)`, `clearStorage(local|session)`

### Files
- `upload(ref|selector, filePath)` — file input upload
- `download(ref|selector)` — click + capture download
- `pdf(path?)` — save page as PDF

### Tabs
- `newTab(url?)`, `switchTab(targetId)`, `listTabs`, `closeTab(targetId?)`

### Other
- `resize("1920x1080")` — change viewport
- `highlight(ref|selector)` — visual highlight for 3s
- `evaluate(js)` — run JavaScript
- `handleDialog(accept|dismiss, text?)`
- `newSession(profile?)` — fresh session (preserves cookies per profile)
- `status` — browser state
- `close` — shutdown

## Don't
- Don't use CSS selectors when you have refs from a snapshot
- Don't skip snapshot — blind clicking fails on dynamic pages
- Don't forget to take a fresh snapshot after navigation changes the page
- Don't assume element positions — always verify with snapshot or screenshot
