/**
 * Browser Automation — Heavy Playwright-based web interaction.
 *
 * Features:
 * - Accessibility snapshots (ARIA tree with numeric refs for agent navigation)
 * - Multi-tab with targetId tracking
 * - Session persistence (cookies, localStorage, sessionStorage)
 * - Console/error capture
 * - File upload/download handling
 * - Drag & drop, viewport resize
 * - Advanced waits (selector, text, URL, JS predicate, load state)
 * - PDF generation, element highlight
 * - Localhost allowed, private ranges blocked
 */

import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { config } from "../config/default.js";

let browser = null;
let browserContext = null;
const pages = new Map();        // targetId → page
let activeTargetId = null;
let targetCounter = 0;
let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 5 * 60 * 1000;

// Console log buffer — per page, max 100 entries
const consoleLogs = new Map();  // targetId → [{type, text, timestamp}]
const MAX_CONSOLE_LOGS = 100;

// Snapshot ref cache — maps ref numbers to element handles
let snapshotRefs = new Map();   // "e1" → { selector, role, name }
let snapshotCounter = 0;

// ── Navigation guard ─────────────────────────────────────────────────────────
const NAV_BLOCKLIST = [
  /^file:\/\//i,
  /^(https?:\/\/)(10\.\d+\.\d+\.\d+)/,
  /^(https?:\/\/)(172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+)/,
  /^(https?:\/\/)(192\.168\.\d+\.\d+)/,
  /^(https?:\/\/)(169\.254\.\d+\.\d+)/,
];

function isBlockedUrl(url) {
  return NAV_BLOCKLIST.some((p) => p.test(url));
}

// ── Inactivity timer ─────────────────────────────────────────────────────────
function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(async () => {
    if (browser) {
      console.log("[browser] Closing browser due to inactivity (5 min)");
      await browser.close().catch(() => {});
      cleanup();
    }
  }, INACTIVITY_TIMEOUT);
}

function cleanup() {
  browser = null;
  browserContext = null;
  pages.clear();
  consoleLogs.clear();
  snapshotRefs.clear();
  activeTargetId = null;
}

// ── Browser lifecycle ────────────────────────────────────────────────────────
function genTargetId() {
  return `t${++targetCounter}`;
}

function attachConsoleLogs(targetId, page) {
  const logs = [];
  consoleLogs.set(targetId, logs);
  page.on("console", (msg) => {
    logs.push({ type: msg.type(), text: msg.text(), ts: Date.now() });
    if (logs.length > MAX_CONSOLE_LOGS) logs.shift();
  });
  page.on("pageerror", (err) => {
    logs.push({ type: "error", text: err.message, ts: Date.now() });
    if (logs.length > MAX_CONSOLE_LOGS) logs.shift();
  });
}

async function ensureBrowser(profileName = "default") {
  resetInactivityTimer();

  if (browser && browser.isConnected()) {
    if (!activeTargetId || !pages.has(activeTargetId) || pages.get(activeTargetId).isClosed()) {
      const page = await browserContext.newPage();
      page.setDefaultTimeout(15000);
      const tid = genTargetId();
      pages.set(tid, page);
      attachConsoleLogs(tid, page);
      activeTargetId = tid;
    }
    return pages.get(activeTargetId);
  }

  try {
    const { chromium } = await import("playwright");
    const userDataDir = join(config.dataDir, "browser", profileName);
    mkdirSync(userDataDir, { recursive: true });

    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    browserContext = browser;

    browserContext.on("dialog", async (dialog) => {
      console.log(`[browser] Auto-dismissed dialog: ${dialog.type()} - "${dialog.message().slice(0, 80)}"`);
      await dialog.dismiss();
    });

    const existingPages = browserContext.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await browserContext.newPage();
    page.setDefaultTimeout(15000);
    const tid = genTargetId();
    pages.set(tid, page);
    attachConsoleLogs(tid, page);
    activeTargetId = tid;
    return page;
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.message?.includes("playwright")) {
      throw new Error("Playwright not installed. Run: pnpm add playwright && npx playwright install chromium");
    }
    throw error;
  }
}

function currentPage() {
  if (!activeTargetId || !pages.has(activeTargetId)) {
    throw new Error("No browser open. Use navigate first.");
  }
  const p = pages.get(activeTargetId);
  if (p.isClosed()) throw new Error("Current page is closed. Navigate to a URL first.");
  resetInactivityTimer();
  return p;
}

// ── Accessibility snapshot ───────────────────────────────────────────────────
// Builds an ARIA tree with numeric refs (e1, e2, ...) for agent navigation.
// Agent can then use click("e5") instead of CSS selectors.

async function buildAccessibilitySnapshot(page, opts = {}) {
  const { selector, interactive, compact, maxChars = 50000 } = opts;

  snapshotRefs.clear();
  snapshotCounter = 0;

  const tree = await page.accessibility.snapshot({ interestingOnly: interactive !== false });
  if (!tree) return { text: "(empty page — no accessible content)", refs: {} };

  const lines = [];
  const refs = {};

  function walk(node, depth = 0) {
    if (!node) return;
    const indent = "  ".repeat(depth);
    const ref = `e${++snapshotCounter}`;

    // Skip non-interactive in interactive-only mode
    const isInteractive = ["button", "link", "textbox", "checkbox", "radio", "combobox",
      "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "option"].includes(node.role);

    if (interactive && !isInteractive && !node.children?.length) return;

    const parts = [`${indent}[${ref}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`value="${node.value}"`);
    if (node.checked !== undefined) parts.push(node.checked ? "checked" : "unchecked");
    if (node.selected) parts.push("selected");
    if (node.disabled) parts.push("disabled");
    if (node.expanded !== undefined) parts.push(node.expanded ? "expanded" : "collapsed");
    if (node.level) parts.push(`level=${node.level}`);

    // Store ref mapping
    refs[ref] = { role: node.role, name: node.name || "", selector: null };
    snapshotRefs.set(ref, { role: node.role, name: node.name || "" });

    if (!compact || isInteractive || depth <= 1) {
      lines.push(parts.join(" "));
    }

    if (node.children) {
      for (const child of node.children) walk(child, depth + 1);
    }
  }

  walk(tree);
  let text = lines.join("\n");
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`;
  }

  return { text, refs, count: snapshotCounter };
}

// Resolve ref (e5) to a Playwright locator
async function resolveRef(page, ref) {
  const info = snapshotRefs.get(ref);
  if (!info) throw new Error(`Unknown ref "${ref}". Take a fresh snapshot first.`);

  // Try role + name first (most reliable)
  const { role, name } = info;
  if (name) {
    const locator = page.getByRole(role, { name, exact: false });
    const count = await locator.count();
    if (count === 1) return locator;
    if (count > 1) return locator.first();
  }

  // Fallback to role only
  const locator = page.getByRole(role);
  const count = await locator.count();
  if (count === 1) return locator;
  if (count > 0) return locator.first();

  throw new Error(`Could not locate element for ref "${ref}" (role=${role}, name="${name}"). Page may have changed — take a fresh snapshot.`);
}

// Check if param is a ref (e.g., "e5") or a CSS selector
function isRef(param) {
  return /^e\d+$/.test(param);
}

// Get a locator from either ref or CSS selector
async function getLocator(page, selectorOrRef) {
  if (isRef(selectorOrRef)) return resolveRef(page, selectorOrRef);
  return page.locator(selectorOrRef);
}

// ── Error wrapping ───────────────────────────────────────────────────────────
function wrapError(error) {
  const msg = error.message;
  if (msg.includes("Timeout") && msg.includes("waiting for selector")) {
    return `Element not found within timeout. Check the selector or take a fresh snapshot. Error: ${msg}`;
  }
  if (msg.includes("Target closed") || msg.includes("has been closed")) {
    return `Browser/page was closed. Use navigate to open a new page. Error: ${msg}`;
  }
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) {
    return `Connection refused. Is the server running? Error: ${msg}`;
  }
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) {
    return `DNS resolution failed. Check the URL. Error: ${msg}`;
  }
  if (msg.includes("strict mode violation")) {
    return `Multiple elements match. Use a more specific selector or take a snapshot and use refs. Error: ${msg}`;
  }
  if (msg.includes("not visible")) {
    return `Element not visible. Try scrolling to it first: scroll("selector") or scroll("down"). Error: ${msg}`;
  }
  if (msg.includes("Unknown ref")) return msg;
  return `Browser error: ${msg}`;
}

// ── Main action handler ──────────────────────────────────────────────────────
export async function browserAction(action, param1, param2) {
  console.log(`      [browser] ${action}: ${param1 || ""}`);

  try {
    switch (action) {

      // ── Navigation ──────────────────────────────────────────────────────
      case "navigate":
      case "openPage": {
        if (!param1) return "Error: URL is required.";
        if (isBlockedUrl(param1)) return `Error: Navigation to "${param1}" is blocked (private network range). Localhost is allowed.`;
        const p = await ensureBrowser();
        await p.goto(param1, { waitUntil: "domcontentloaded" });
        const title = await p.title();
        return `Navigated to: ${param1}\nTitle: ${title}\nTab: ${activeTargetId}`;
      }

      case "reload": {
        await currentPage().reload({ waitUntil: "domcontentloaded" });
        const title = await currentPage().title();
        return `Reloaded. Title: ${title}`;
      }

      case "goBack": {
        await currentPage().goBack({ waitUntil: "domcontentloaded" });
        return `Back → ${currentPage().url()}`;
      }

      case "goForward": {
        await currentPage().goForward({ waitUntil: "domcontentloaded" });
        return `Forward → ${currentPage().url()}`;
      }

      // ── Snapshots (ARIA tree) ───────────────────────────────────────────
      case "snapshot": {
        const p = await ensureBrowser();
        const opts = {};
        if (param1) {
          try { Object.assign(opts, JSON.parse(param1)); } catch {
            opts.interactive = param1 === "interactive";
            opts.compact = param1 === "compact";
          }
        }
        const { text, refs, count } = await buildAccessibilitySnapshot(p, opts);
        return `Accessibility snapshot (${count} elements):\n\n${text}\n\nUse refs like "e1", "e5" in click/fill/type actions instead of CSS selectors.`;
      }

      // ── Interaction ─────────────────────────────────────────────────────
      case "click": {
        if (!param1) return "Error: selector or ref (e.g., e5) is required.";
        const page = currentPage();
        const locator = await getLocator(page, param1);
        const opts = {};
        if (param2) {
          try { Object.assign(opts, JSON.parse(param2)); } catch {
            if (param2 === "double") opts.clickCount = 2;
            if (param2 === "right") opts.button = "right";
            if (param2 === "middle") opts.button = "middle";
          }
        }
        await locator.click(opts);
        return `Clicked: ${param1}${opts.clickCount === 2 ? " (double-click)" : ""}${opts.button ? ` (${opts.button} button)` : ""}`;
      }

      case "fill": {
        if (!param1 || param2 === undefined) return "Error: selector/ref and value required.";
        const locator = await getLocator(currentPage(), param1);
        await locator.fill(param2);
        return `Filled "${param1}" with "${param2}"`;
      }

      case "type": {
        if (!param1 || param2 === undefined) return "Error: selector/ref and text required.";
        const locator = await getLocator(currentPage(), param1);
        await locator.click();
        await currentPage().keyboard.type(param2, { delay: 50 });
        return `Typed "${param2}" into "${param1}"`;
      }

      case "hover": {
        if (!param1) return "Error: selector/ref required.";
        const locator = await getLocator(currentPage(), param1);
        await locator.hover();
        return `Hovered: ${param1}`;
      }

      case "selectOption": {
        if (!param1 || param2 === undefined) return "Error: selector/ref and value required.";
        const locator = await getLocator(currentPage(), param1);
        await locator.selectOption(param2);
        return `Selected "${param2}" in "${param1}"`;
      }

      case "pressKey": {
        if (!param1) return "Error: key required (Enter, Tab, Escape, ArrowDown, etc.)";
        await currentPage().keyboard.press(param1);
        return `Pressed: ${param1}`;
      }

      case "scroll": {
        const page = currentPage();
        const direction = param1 || "down";
        const amount = parseInt(param2 || "500");
        if (direction === "up") {
          await page.evaluate((px) => window.scrollBy(0, -px), amount);
        } else if (direction === "down") {
          await page.evaluate((px) => window.scrollBy(0, px), amount);
        } else if (direction === "left") {
          await page.evaluate((px) => window.scrollBy(-px, 0), amount);
        } else if (direction === "right") {
          await page.evaluate((px) => window.scrollBy(px, 0), amount);
        } else {
          // Scroll to element (selector or ref)
          if (isRef(direction)) {
            const loc = await resolveRef(page, direction);
            await loc.scrollIntoViewIfNeeded();
          } else {
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }, direction);
          }
        }
        return `Scrolled ${direction}${["up", "down", "left", "right"].includes(direction) ? ` ${amount}px` : ""}`;
      }

      case "drag": {
        if (!param1 || !param2) return "Error: source and target selector/ref required.";
        const page = currentPage();
        const source = await getLocator(page, param1);
        const target = await getLocator(page, param2);
        await source.dragTo(target);
        return `Dragged "${param1}" → "${param2}"`;
      }

      // ── Content extraction ──────────────────────────────────────────────
      case "getText": {
        const sel = param1 || "body";
        const locator = await getLocator(currentPage(), sel);
        const text = await locator.textContent();
        return (text || "").trim().slice(0, 10000) || "(empty)";
      }

      case "getContent": {
        const sel = param1 || "body";
        const html = await currentPage().evaluate((s) => {
          const el = s === "body" ? document.body : document.querySelector(s);
          return el ? el.innerHTML : null;
        }, sel);
        if (!html) return `No element found: ${sel}`;
        return html.slice(0, 20000);
      }

      // ── Screenshots & PDF ──────────────────────────────────────────────
      case "screenshot": {
        const p = await ensureBrowser();
        const opts = { fullPage: false };
        let path = `/tmp/screenshot-${Date.now()}.png`;

        if (param1 && param1.startsWith("/")) {
          path = param1;
        } else if (param1) {
          // param1 might be a selector/ref for element screenshot
          try {
            const locator = await getLocator(p, param1);
            path = param2 || path;
            await locator.screenshot({ path });
            return `Element screenshot saved: ${path}`;
          } catch {
            // Not a valid selector, treat as path
            path = param1;
          }
        }
        if (param2 === "full") opts.fullPage = true;
        await p.screenshot({ path, ...opts });
        return `Screenshot saved: ${path}`;
      }

      case "pdf": {
        const path = param1 || `/tmp/page-${Date.now()}.pdf`;
        await currentPage().pdf({ path, format: "A4", printBackground: true });
        return `PDF saved: ${path}`;
      }

      // ── JavaScript evaluation ───────────────────────────────────────────
      case "evaluate": {
        if (!param1) return "Error: JavaScript expression required.";
        const result = await currentPage().evaluate(param1);
        return JSON.stringify(result, null, 2);
      }

      case "getLinks": {
        const links = await currentPage().evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .slice(0, 50)
            .map((a) => ({ text: a.textContent.trim().slice(0, 80), href: a.href }))
        );
        return links.map((l) => `${l.text} → ${l.href}`).join("\n") || "(no links)";
      }

      // ── Console & errors ────────────────────────────────────────────────
      case "console": {
        const logs = consoleLogs.get(activeTargetId) || [];
        const filter = param1 || "all"; // "all", "error", "warn", "log", "info"
        const limit = parseInt(param2 || "30");
        const filtered = filter === "all" ? logs : logs.filter(l => l.type === filter);
        if (filtered.length === 0) return `No${filter !== "all" ? ` ${filter}` : ""} console messages.`;
        return filtered.slice(-limit).map(l => {
          const time = new Date(l.ts).toISOString().slice(11, 19);
          return `[${time}] ${l.type.toUpperCase()}: ${l.text}`;
        }).join("\n");
      }

      // ── Waiting ─────────────────────────────────────────────────────────
      case "waitFor": {
        if (!param1) return "Error: condition required.";
        const page = currentPage();
        const timeout = parseInt(param2 || "10000");

        // Detect wait type
        if (param1.startsWith("url:")) {
          // Wait for URL to contain/match
          const urlPattern = param1.slice(4);
          await page.waitForURL(`**${urlPattern}**`, { timeout });
          return `URL matched: ${page.url()}`;
        }
        if (param1.startsWith("text:")) {
          // Wait for text to appear on page
          const text = param1.slice(5);
          await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
          return `Text "${text}" found on page.`;
        }
        if (param1.startsWith("js:")) {
          // Wait for JS predicate
          const predicate = param1.slice(3);
          await page.waitForFunction(predicate, null, { timeout });
          return `JS predicate satisfied.`;
        }
        if (param1 === "load" || param1 === "networkidle") {
          await page.waitForLoadState(param1 === "load" ? "load" : "networkidle", { timeout });
          return `Page reached ${param1} state.`;
        }
        // Default: CSS selector
        await page.waitForSelector(param1, { timeout });
        return `Element "${param1}" found.`;
      }

      case "waitForNavigation": {
        const timeout = param1 ? parseInt(param1) : 30000;
        await currentPage().waitForNavigation({ timeout });
        return `Navigation complete → ${currentPage().url()}`;
      }

      // ── Tab management ──────────────────────────────────────────────────
      case "newTab": {
        if (param1 && isBlockedUrl(param1)) return `Error: URL "${param1}" is blocked.`;
        if (!browserContext) await ensureBrowser();
        const page = await browserContext.newPage();
        page.setDefaultTimeout(15000);
        const tid = genTargetId();
        pages.set(tid, page);
        attachConsoleLogs(tid, page);
        activeTargetId = tid;
        if (param1) {
          await page.goto(param1, { waitUntil: "domcontentloaded" });
          return `Opened tab ${tid} at: ${param1}`;
        }
        return `Opened blank tab: ${tid}`;
      }

      case "switchTab": {
        if (!param1) return `Error: targetId required. Use listTabs to see open tabs.`;
        if (!pages.has(param1)) return `Error: Tab "${param1}" not found. Use listTabs.`;
        activeTargetId = param1;
        const page = pages.get(param1);
        const title = await page.title().catch(() => "?");
        return `Switched to ${param1}: ${title} - ${page.url()}`;
      }

      case "listTabs": {
        if (pages.size === 0) return "No open tabs.";
        const entries = [];
        for (const [tid, page] of pages) {
          if (page.isClosed()) { entries.push(`  ${tid}: [closed]`); continue; }
          const title = await page.title().catch(() => "?");
          const marker = tid === activeTargetId ? " (active)" : "";
          entries.push(`  ${tid}${marker}: ${title} - ${page.url()}`);
        }
        return `Open tabs (${pages.size}):\n${entries.join("\n")}`;
      }

      case "closeTab": {
        const tid = param1 || activeTargetId;
        if (!pages.has(tid)) return `Error: Tab "${tid}" not found.`;
        await pages.get(tid).close();
        pages.delete(tid);
        consoleLogs.delete(tid);
        if (activeTargetId === tid) {
          activeTargetId = pages.size > 0 ? pages.keys().next().value : null;
        }
        return `Closed tab ${tid}. Remaining: ${pages.size}`;
      }

      // ── Cookies ─────────────────────────────────────────────────────────
      case "getCookies": {
        if (!browserContext) return "No browser open.";
        const cookies = await browserContext.cookies();
        const filtered = param1 ? cookies.filter((c) => c.domain.includes(param1)) : cookies;
        return JSON.stringify(filtered.slice(0, 30), null, 2);
      }

      case "setCookie": {
        if (!param1) return 'Error: cookie JSON required ({"name":"x","value":"y","domain":"example.com"}).';
        if (!browserContext) await ensureBrowser();
        const cookie = JSON.parse(param1);
        await browserContext.addCookies([cookie]);
        return `Cookie "${cookie.name}" set.`;
      }

      case "clearCookies": {
        if (!browserContext) return "No browser open.";
        await browserContext.clearCookies();
        return "All cookies cleared.";
      }

      // ── Local/Session Storage ───────────────────────────────────────────
      case "getStorage": {
        // param1: "local" or "session", param2: key (optional)
        const kind = param1 || "local";
        const key = param2;
        const storageObj = kind === "session" ? "sessionStorage" : "localStorage";
        const result = await currentPage().evaluate(([obj, k]) => {
          const s = window[obj];
          if (k) return { [k]: s.getItem(k) };
          const all = {};
          for (let i = 0; i < s.length; i++) { const key = s.key(i); all[key] = s.getItem(key); }
          return all;
        }, [storageObj, key]);
        return JSON.stringify(result, null, 2);
      }

      case "setStorage": {
        // param1: JSON {"kind":"local","key":"x","value":"y"}
        if (!param1) return 'Error: JSON required {"kind":"local|session","key":"...","value":"..."}';
        const { kind = "local", key, value } = JSON.parse(param1);
        const storageObj = kind === "session" ? "sessionStorage" : "localStorage";
        await currentPage().evaluate(([obj, k, v]) => window[obj].setItem(k, v), [storageObj, key, value]);
        return `Set ${kind}Storage["${key}"]`;
      }

      case "clearStorage": {
        const kind = param1 || "local";
        const storageObj = kind === "session" ? "sessionStorage" : "localStorage";
        await currentPage().evaluate((obj) => window[obj].clear(), storageObj);
        return `${kind}Storage cleared.`;
      }

      // ── File upload ─────────────────────────────────────────────────────
      case "upload": {
        if (!param1 || !param2) return "Error: selector/ref and filePath required.";
        const locator = await getLocator(currentPage(), param1);
        await locator.setInputFiles(param2.includes(",") ? param2.split(",").map(f => f.trim()) : param2);
        return `Uploaded file(s) to "${param1}": ${param2}`;
      }

      // ── Download ────────────────────────────────────────────────────────
      case "download": {
        // Click something that triggers download, wait for it
        if (!param1) return "Error: selector/ref to click for download required.";
        const page = currentPage();
        const downloadDir = join(config.dataDir, "browser", "downloads");
        mkdirSync(downloadDir, { recursive: true });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          (await getLocator(page, param1)).click(),
        ]);
        const path = join(downloadDir, download.suggestedFilename());
        await download.saveAs(path);
        return `Downloaded: ${path} (${download.suggestedFilename()})`;
      }

      // ── Viewport ────────────────────────────────────────────────────────
      case "resize": {
        if (!param1) return 'Error: size required. e.g., "1920x1080" or JSON {"width":1920,"height":1080}';
        let width, height;
        if (param1.includes("x")) {
          [width, height] = param1.split("x").map(Number);
        } else {
          const parsed = JSON.parse(param1);
          width = parsed.width;
          height = parsed.height;
        }
        await currentPage().setViewportSize({ width, height });
        return `Viewport resized to ${width}x${height}`;
      }

      // ── Highlight ───────────────────────────────────────────────────────
      case "highlight": {
        if (!param1) return "Error: selector/ref required.";
        const page = currentPage();
        if (isRef(param1)) {
          const loc = await resolveRef(page, param1);
          await loc.evaluate((el) => {
            el.style.outline = "3px solid red";
            el.style.outlineOffset = "2px";
            setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 3000);
          });
        } else {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              el.style.outline = "3px solid red";
              el.style.outlineOffset = "2px";
              setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 3000);
            }
          }, param1);
        }
        return `Highlighted "${param1}" for 3 seconds.`;
      }

      // ── Dialog handling ─────────────────────────────────────────────────
      case "handleDialog": {
        const dialogAction = param1 || "accept";
        const text = param2 || "";
        currentPage().once("dialog", async (dialog) => {
          if (dialogAction === "accept") await dialog.accept(text);
          else await dialog.dismiss();
        });
        return `Next dialog will be ${dialogAction}ed${text ? ` with: "${text}"` : ""}.`;
      }

      // ── Session management ──────────────────────────────────────────────
      case "newSession": {
        if (browser) {
          await browser.close().catch(() => {});
          cleanup();
        }
        const profile = param1 || "default";
        await ensureBrowser(profile);
        return `New session started (profile: ${profile}). Auth/cookies from this profile are preserved.`;
      }

      case "status": {
        const connected = browser && browser.isConnected();
        const tabCount = pages.size;
        const profile = "default"; // TODO: track current profile
        if (!connected) return "Browser: not running";
        return `Browser: running | Tabs: ${tabCount} | Active: ${activeTargetId} | URL: ${currentPage().url()}`;
      }

      case "close": {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (browser) {
          await browser.close();
          cleanup();
        }
        return "Browser closed.";
      }

      default:
        return `Unknown action: "${action}". Available: navigate, snapshot, click, fill, type, hover, selectOption, pressKey, scroll, drag, getText, getContent, screenshot, pdf, evaluate, getLinks, console, waitFor, waitForNavigation, reload, goBack, goForward, newTab, switchTab, listTabs, closeTab, getCookies, setCookie, clearCookies, getStorage, setStorage, clearStorage, upload, download, resize, highlight, handleDialog, newSession, status, close`;
    }
  } catch (error) {
    console.log(`      [browser] Error: ${error.message}`);
    return wrapError(error);
  }
}

export const browserActionDescription =
  'browserAction(action, param1?, param2?) - Heavy Playwright browser automation. Actions: navigate(url), snapshot(opts?), click(selector|ref,opts?), fill(selector|ref,value), type(selector|ref,text), hover(selector|ref), selectOption(selector|ref,value), pressKey(key), scroll(direction|selector|ref,amount?), drag(source,target), getText(selector|ref?), getContent(selector?), screenshot(path|selector?,full?), pdf(path?), evaluate(js), getLinks, console(filter?,limit?), waitFor(condition,timeout?) — conditions: selector, "text:...", "url:...", "js:...", "load", "networkidle", waitForNavigation(timeout?), reload, goBack, goForward, newTab(url?), switchTab(targetId), listTabs, closeTab(targetId?), getCookies(domain?), setCookie(json), clearCookies, getStorage(local|session,key?), setStorage(json), clearStorage(local|session), upload(selector|ref,filePath), download(selector|ref), resize(WxH), highlight(selector|ref), handleDialog(accept|dismiss,text?), newSession(profile?), status, close. Supports ref-based interaction: take snapshot first, then use refs (e1, e5) instead of CSS selectors.';
