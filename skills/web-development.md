---
name: web-development
description: Frontend/UI development with visual verification, dev server testing, browser automation
triggers: frontend, ui, web, react, next, html, css, dashboard, landing page, component, dev server, browser, visual, responsive, layout, vite, webpack
---

# Web Development & UI Testing

## UI Testing Loop (MANDATORY for frontend tasks)
1. Start dev server in background: `executeCommand("npm run dev", {"background":true,"cwd":"/project"})`
2. Navigate: `browserAction("navigate", "http://localhost:3000")`
3. Screenshot: `browserAction("screenshot", "/tmp/ui-check.png")`
4. Analyze: `imageAnalysis("/tmp/ui-check.png", "Check layout, spacing, responsiveness, broken elements, visual bugs.")`
5. If issues found → fix code → screenshot → analyze again. Loop until clean.
6. Test interactions: click buttons, fill forms, check navigation with browserAction.
7. Only finish after visual verification passes.

## Dev Server Workflow
- Start with `background:true` to keep server running while you test.
- Capture the PID from the response.
- Navigate with `browserAction("navigate", url)` to test.
- When done: `executeCommand("kill <pid>")`.

## Testing Workflow
- After meaningful code changes → write tests → run them → fix failures → repeat until green.
- For bug fixes: write a test that PROVES the bug is fixed before finishing.
- Never tell the user to run tests manually. Run them yourself.

## Build Verification
- After any code change → run build command (`npm run build` or equivalent).
- If build fails → read error → diagnose root cause → fix → rebuild. Repeat until clean.
- NEVER finish while a build error exists.
