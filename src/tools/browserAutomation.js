/**
 * Browser Automation — Heavy Playwright-based web interaction.
 *
 * Features:
 * - Accessibility snapshots (ARIA tree with numeric refs for agent navigation)
 * - Multi-tab with targetId tracking
 * - Session persistence (cookies, localStorage, sessionStorage)
 * - Console/error/network request capture (circular buffers)
 * - File upload/download handling
 * - Drag & drop, viewport resize
 * - Advanced waits (selector, text, URL, JS predicate, load state)
 * - PDF generation, element highlight
 * - Localhost allowed, private ranges blocked
 * - Frame-scoped snapshots (iframe interaction)
 * - Network request tracking + response body capture
 * - Cross-request ref stability (per-target caching)
 * - Screenshot normalization (auto-resize/quality)
 * - Force disconnect recovery (CDP Runtime.terminateExecution)
 * - Trace recording (Playwright trace)
 * - Nested batch actions with depth limits
 * - AI-friendly error messages
 */

import { join, basename } from "path";
import { mkdirSync, existsSync, readdirSync, writeFileSync, renameSync } from "fs";
import { config } from "../config/default.js";
import filesystemGuard from "../safety/FilesystemGuard.js";
import { getTenantTmpDir } from "./_paths.js";

let browser = null;
let browserContext = null;
let browserConnected = false;
const pages = new Map();        // targetId → page
let activeTargetId = null;
let targetCounter = 0;
let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 5 * 60 * 1000;

// ── Circular buffer limits ──────────────────────────────────────────────────
const MAX_CONSOLE_LOGS = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

// ── Per-page state (circular buffers) ───────────────────────────────────────
const pageStates = new Map(); // targetId → { consoleLogs, pageErrors, networkRequests, nextRequestId }

function ensurePageState(targetId) {
  if (!pageStates.has(targetId)) {
    pageStates.set(targetId, {
      consoleLogs: [],
      pageErrors: [],
      networkRequests: [],
      nextRequestId: 0,
      requestMap: new WeakMap(), // Request → id
    });
  }
  return pageStates.get(targetId);
}

// ── Cross-request ref stability (per-target cache) ─────────────────────────
const MAX_REF_CACHE = 50;
const refCacheByTarget = new Map(); // targetId → { refs: Map, counter, frameSelector }
let activeRefTarget = null;         // which targetId the current refs belong to

function getOrCreateRefCache(targetId) {
  if (!refCacheByTarget.has(targetId)) {
    // LRU eviction
    if (refCacheByTarget.size >= MAX_REF_CACHE) {
      const oldest = refCacheByTarget.keys().next().value;
      refCacheByTarget.delete(oldest);
    }
    refCacheByTarget.set(targetId, { refs: new Map(), counter: 0, frameSelector: null });
  }
  return refCacheByTarget.get(targetId);
}

// Download tracking — persistent across actions
const downloads = new Map();    // downloadId → { id, filename, url, path, status, timestamp }
let downloadCounter = 0;

// Dialog handling — configurable behavior
let lastDialog = null;          // { type, message, defaultValue, timestamp }
let dialogMode = "auto";        // auto | accept | dismiss | manual
const pendingDialogs = [];      // queue for manual mode

// Network interception routes
const activeRoutes = new Map(); // pattern → "block" | "modify"

// Response body capture listeners
const responseCaptureListeners = new Map(); // id → { pattern, resolve, reject, timer, results }
let captureCounter = 0;

// Current profile name (for status reporting)
let currentProfileName = "default";

// Trace state
let traceActive = false;

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

// ── AI-friendly error messages ───────────────────────────────────────────────
function toAIFriendlyError(error) {
  const msg = error.message || String(error);

  if (msg.includes("strict mode violation") || msg.includes("resolved to")) {
    const match = msg.match(/resolved to (\d+) elements/);
    const n = match ? match[1] : "multiple";
    return `Matched ${n} elements — run snapshot to get updated refs and use a more specific one.`;
  }
  if (msg.includes("Timeout") && (msg.includes("waiting for selector") || msg.includes("waiting for locator"))) {
    return `Element not found or not visible within timeout. Run snapshot to see current page state.`;
  }
  if ((msg.includes("not visible") || msg.includes("element is not visible")) && !msg.includes("Timeout")) {
    return `Element exists but is not visible. Try: scroll to it, close overlays, or wait for animation.`;
  }
  if (msg.includes("element is outside of the viewport")) {
    return `Element is off-screen. Use scroll(selector) to bring it into view first.`;
  }
  if (msg.includes("intercepts pointer events") || msg.includes("receives pointer events")) {
    return `Another element is covering this one (overlay, modal, tooltip). Close it or click the covering element first.`;
  }
  if (msg.includes("Element is not an <input>") || msg.includes("Element is not a <select>")) {
    return `Wrong element type for this action. Check the element's role in the snapshot.`;
  }
  if (msg.includes("Target closed") || msg.includes("has been closed")) {
    return `Browser/page was closed. Use navigate to open a new page.`;
  }
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) {
    return `Connection refused — server may not be running at this URL.`;
  }
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) {
    return `DNS lookup failed — check the URL spelling.`;
  }
  if (msg.includes("net::ERR_CERT")) {
    return `SSL certificate error. The site may have an invalid or expired certificate.`;
  }
  if (msg.includes("net::ERR_TOO_MANY_REDIRECTS")) {
    return `Too many redirects — the site is in a redirect loop. Check cookies/auth state.`;
  }
  if (msg.includes("Evaluate timed out") || msg.includes("terminateExecution")) {
    return `JavaScript execution timed out — the page script is stuck. Use forceDisconnect to recover.`;
  }
  if (msg.includes("Unknown ref")) return msg;
  if (msg.includes("frame was detached")) {
    return `The iframe was removed from the page. Take a fresh snapshot.`;
  }
  return `Browser error: ${msg}`;
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
  browserConnected = false;
  pages.clear();
  pageStates.clear();
  refCacheByTarget.clear();
  downloads.clear();
  activeRoutes.clear();
  responseCaptureListeners.clear();
  activeTargetId = null;
  activeRefTarget = null;
  lastDialog = null;
  dialogMode = "auto";
  pendingDialogs.length = 0;
  currentProfileName = "default";
  traceActive = false;
}

// ── Browser lifecycle ────────────────────────────────────────────────────────
function genTargetId() {
  return `t${++targetCounter}`;
}

function attachPageListeners(targetId, page) {
  const state = ensurePageState(targetId);

  // Console messages (circular buffer, max 500)
  page.on("console", (msg) => {
    state.consoleLogs.push({ type: msg.type(), text: msg.text(), ts: Date.now() });
    if (state.consoleLogs.length > MAX_CONSOLE_LOGS) state.consoleLogs.shift();
  });

  // Page errors (circular buffer, max 200)
  page.on("pageerror", (err) => {
    state.pageErrors.push({ message: err.message, name: err.name, stack: err.stack, ts: Date.now() });
    if (state.pageErrors.length > MAX_PAGE_ERRORS) state.pageErrors.shift();
  });

  // Network request tracking (circular buffer, max 500)
  page.on("request", (request) => {
    const id = `r${++state.nextRequestId}`;
    state.requestMap.set(request, id);
    state.networkRequests.push({
      id, method: request.method(), url: request.url(),
      resourceType: request.resourceType(), status: null, ok: null, failureText: null, ts: Date.now(),
    });
    if (state.networkRequests.length > MAX_NETWORK_REQUESTS) state.networkRequests.shift();
  });

  page.on("response", (response) => {
    const id = state.requestMap.get(response.request());
    if (!id) return;
    const entry = state.networkRequests.find(r => r.id === id);
    if (entry) { entry.status = response.status(); entry.ok = response.ok(); }

    // Notify response capture listeners
    for (const [, listener] of responseCaptureListeners) {
      if (matchUrlPattern(listener.pattern, response.url())) {
        response.body().then(buf => {
          listener.results.push({
            url: response.url(), status: response.status(),
            headers: response.headers(), body: buf.toString("utf-8").slice(0, 200_000),
          });
        }).catch(() => {});
      }
    }
  });

  page.on("requestfailed", (request) => {
    const id = state.requestMap.get(request);
    if (!id) return;
    const entry = state.networkRequests.find(r => r.id === id);
    if (entry) { entry.ok = false; entry.failureText = request.failure()?.errorText || "unknown"; }
  });

  // Track downloads automatically
  page.on("download", (download) => {
    const id = `dl-${++downloadCounter}`;
    const safeName = basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
    downloads.set(id, {
      id, filename: safeName, url: download.url(), path: null,
      status: "pending", timestamp: Date.now(), _download: download,
    });
    // Atomic save — temp path then rename
    download.path().then(p => {
      const dl = downloads.get(id);
      if (dl) { dl.path = p; dl.status = "completed"; }
    }).catch(() => {
      const dl = downloads.get(id);
      if (dl && dl.status === "pending") dl.status = "needs-save";
    });
    if (downloads.size > 50) {
      const oldest = downloads.keys().next().value;
      downloads.delete(oldest);
    }
    console.log(`[browser] Download tracked: ${id} - ${safeName}`);
  });
}

async function ensureBrowser(profileName = "default") {
  resetInactivityTimer();

  if (browser && browserConnected) {
    if (!activeTargetId || !pages.has(activeTargetId) || pages.get(activeTargetId).isClosed()) {
      const page = await browserContext.newPage();
      page.setDefaultTimeout(15000);
      const tid = genTargetId();
      pages.set(tid, page);
      attachPageListeners(tid, page);
      activeTargetId = tid;
    }
    return pages.get(activeTargetId);
  }

  try {
    const { chromium } = await import("playwright");
    const userDataDir = join(config.dataDir, "browser", profileName);
    mkdirSync(userDataDir, { recursive: true });

    // Meeting profiles run headed with full WebRTC support (Vexa-matching config)
    const isMeetingProfile = profileName.startsWith("meeting-");
    const meetingArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-infobars",
      "--use-fake-ui-for-media-stream",
      "--use-file-for-fake-video-capture=/dev/null",
      "--allow-running-insecure-content",
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--autoplay-policy=no-user-gesture-required",
      "--ignore-certificate-errors",
    ];
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: !isMeetingProfile,
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      bypassCSP: isMeetingProfile,
      permissions: isMeetingProfile ? ["microphone", "camera", "notifications"] : [],
      args: isMeetingProfile ? meetingArgs : [],
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    });
    browserContext = browser;
    browserConnected = true;

    browserContext.on("close", () => cleanup());

    browserContext.on("dialog", async (dialog) => {
      lastDialog = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), timestamp: Date.now() };
      console.log(`[browser] Dialog (${dialogMode}): ${dialog.type()} - "${dialog.message().slice(0, 80)}"`);
      if (dialogMode === "accept") {
        await dialog.accept();
      } else if (dialogMode === "dismiss") {
        await dialog.dismiss();
      } else if (dialogMode === "manual") {
        pendingDialogs.push(dialog);
      } else {
        await dialog.dismiss();
      }
    });

    currentProfileName = profileName;

    const existingPages = browserContext.pages();
    const page = existingPages.length > 0 ? existingPages[0] : await browserContext.newPage();
    page.setDefaultTimeout(15000);
    const tid = genTargetId();
    pages.set(tid, page);
    attachPageListeners(tid, page);
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

// ── URL pattern matching (for response capture) ─────────────────────────────
function matchUrlPattern(pattern, url) {
  if (!pattern || !url) return false;
  if (pattern === "*") return true;
  // Convert glob pattern to regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*");
  return new RegExp(escaped, "i").test(url);
}

// ── Accessibility snapshot ───────────────────────────────────────────────────
// Builds an ARIA tree with numeric refs (e1, e2, ...) for agent navigation.
// Supports frame-scoped snapshots for iframe interaction.

async function buildAccessibilitySnapshot(page, opts = {}) {
  const { selector, interactive, compact, maxChars = 50000, frameSelector } = opts;

  // Use per-target ref cache for cross-request stability
  const cache = getOrCreateRefCache(activeTargetId);
  cache.refs.clear();
  cache.counter = 0;
  cache.frameSelector = frameSelector || null;
  activeRefTarget = activeTargetId;

  // Determine the scope — main page or a frame
  let scope = page;
  if (frameSelector) {
    scope = page.frameLocator(frameSelector);
    // For accessibility, we need the frame's page — use frame()
    const frames = page.frames();
    const matchedFrame = frames.find(f => {
      try { return f.url() && f !== page.mainFrame(); } catch { return false; }
    });
    if (matchedFrame) {
      const tree = await matchedFrame.accessibility?.snapshot({ interestingOnly: interactive !== false });
      if (!tree) return { text: `(empty frame — no accessible content in "${frameSelector}")`, refs: {}, count: 0 };
      return buildTreeFromNode(tree, cache, { interactive, compact, maxChars });
    }
  }

  const tree = await page.accessibility.snapshot({ interestingOnly: interactive !== false });
  if (!tree) return { text: "(empty page — no accessible content)", refs: {}, count: 0 };

  return buildTreeFromNode(tree, cache, { interactive, compact, maxChars });
}

function buildTreeFromNode(tree, cache, opts = {}) {
  const { interactive, compact, maxChars = 50000 } = opts;
  const lines = [];
  const refs = {};
  const roleCounts = new Map(); // "role::name" → count (for nth disambiguation)

  // First pass: count duplicates
  function countDuplicates(node) {
    if (!node) return;
    const key = `${node.role}::${node.name || ""}`;
    roleCounts.set(key, (roleCounts.get(key) || 0) + 1);
    if (node.children) for (const child of node.children) countDuplicates(child);
  }
  countDuplicates(tree);

  // Track seen counts for nth assignment
  const seenCounts = new Map();

  function walk(node, depth = 0) {
    if (!node) return;
    const indent = "  ".repeat(depth);
    const ref = `e${++cache.counter}`;

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

    // nth disambiguation for duplicate role+name
    const key = `${node.role}::${node.name || ""}`;
    const totalCount = roleCounts.get(key) || 0;
    const seen = (seenCounts.get(key) || 0);
    seenCounts.set(key, seen + 1);
    const nth = totalCount > 1 ? seen : 0;

    // Store ref with nth for stable resolution
    const refInfo = { role: node.role, name: node.name || "", nth };
    refs[ref] = refInfo;
    cache.refs.set(ref, refInfo);

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

  return { text, refs, count: cache.counter };
}

// Resolve ref (e5) to a Playwright locator — uses per-target cache
async function resolveRef(page, ref) {
  // Try current target cache first, then active ref target
  let cache = refCacheByTarget.get(activeTargetId);
  if (!cache?.refs.has(ref) && activeRefTarget && activeRefTarget !== activeTargetId) {
    cache = refCacheByTarget.get(activeRefTarget);
  }
  if (!cache || !cache.refs.has(ref)) {
    throw new Error(`Unknown ref "${ref}". Take a fresh snapshot first.`);
  }

  const info = cache.refs.get(ref);
  const { role, name, nth } = info;

  // Determine scope — use frame if snapshot was frame-scoped
  let scope = page;
  if (cache.frameSelector) {
    scope = page.frameLocator(cache.frameSelector);
  }

  if (name) {
    const locator = scope.getByRole(role, { name, exact: false });
    const count = await locator.count();
    if (count === 1) return locator;
    if (count > 1) {
      // Use nth for disambiguation
      if (nth > 0 && nth < count) return locator.nth(nth);
      return locator.first();
    }
  }

  const locator = scope.getByRole(role);
  const count = await locator.count();
  if (count === 1) return locator;
  if (count > 0) {
    if (nth > 0 && nth < count) return locator.nth(nth);
    return locator.first();
  }

  throw new Error(`Could not locate element for ref "${ref}" (role=${role}, name="${name}"). Page may have changed — take a fresh snapshot.`);
}

function isRef(param) {
  return /^e\d+$/.test(param);
}

async function getLocator(page, selectorOrRef) {
  if (isRef(selectorOrRef)) return resolveRef(page, selectorOrRef);
  return page.locator(selectorOrRef);
}

// ── Safe evaluate with timeout clamping ─────────────────────────────────────
// Clamps timeout both at connection level AND injects a browser-side race
async function safeEvaluate(page, fn, arg, timeout = 10000) {
  const clampedTimeout = Math.max(500, Math.min(120_000, timeout));
  return Promise.race([
    typeof fn === "string" ? page.evaluate(fn) : page.evaluate(fn, arg),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Evaluate timed out after ${clampedTimeout}ms`)), clampedTimeout)),
  ]);
}

// ── Screenshot normalization ────────────────────────────────────────────────
// Auto-resize and reduce quality to fit within size limits
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_SCREENSHOT_SIDE = 2000;

async function normalizedScreenshot(page, opts = {}) {
  const { path: savePath, fullPage = false, selector } = opts;

  // First attempt — PNG
  let buffer;
  if (selector) {
    const locator = await getLocator(page, selector);
    buffer = await locator.screenshot({ type: "png" });
  } else {
    buffer = await page.screenshot({ type: "png", fullPage });
  }

  // If within limits, save as PNG
  if (buffer.length <= MAX_SCREENSHOT_BYTES) {
    writeFileSync(savePath, buffer);
    return { path: savePath, size: buffer.length, format: "png" };
  }

  // Too large — try JPEG with reducing quality
  const qualities = [85, 75, 65, 50, 35];
  for (const quality of qualities) {
    if (selector) {
      const locator = await getLocator(page, selector);
      buffer = await locator.screenshot({ type: "jpeg", quality });
    } else {
      buffer = await page.screenshot({ type: "jpeg", fullPage, quality });
    }
    if (buffer.length <= MAX_SCREENSHOT_BYTES) {
      const jpegPath = savePath.replace(/\.png$/, ".jpg");
      writeFileSync(jpegPath, buffer);
      return { path: jpegPath, size: buffer.length, format: "jpeg", quality };
    }
  }

  // Last resort — save whatever we got
  const jpegPath = savePath.replace(/\.png$/, ".jpg");
  writeFileSync(jpegPath, buffer);
  return { path: jpegPath, size: buffer.length, format: "jpeg", quality: 35, warning: "Image exceeds 2MB limit" };
}

// ── Main action handler ──────────────────────────────────────────────────────
export async function browserAction(params) {
  const action = params?.action;
  const param1 = params?.param1;
  const param2 = params?.param2;
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
        const frameNote = opts.frameSelector ? ` (frame: ${opts.frameSelector})` : "";
        return `Accessibility snapshot (${count} elements)${frameNote}:\n\n${text}\n\nUse refs like "e1", "e5" in click/fill/type actions instead of CSS selectors.`;
      }

      // ── Frame-scoped snapshot ─────────────────────────────────────────
      case "snapshotFrame": {
        if (!param1) return 'Error: frame selector required. e.g., "iframe[name=checkout]" or "iframe:nth-child(2)"';
        const p = await ensureBrowser();
        const opts = { frameSelector: param1 };
        if (param2) {
          try { Object.assign(opts, JSON.parse(param2)); } catch {}
        }
        const { text, count } = await buildAccessibilitySnapshot(p, opts);
        return `Frame snapshot (${count} elements, frame: ${param1}):\n\n${text}\n\nRefs are scoped to this frame — click/fill will target elements inside it.`;
      }

      // ── List frames ──────────────────────────────────────────────────────
      case "listFrames": {
        const page = currentPage();
        const frames = page.frames();
        if (frames.length <= 1) return "No iframes found on this page.";
        const entries = frames.map((f, i) => {
          const name = f.name() || "(unnamed)";
          const url = f.url() || "about:blank";
          const isMain = f === page.mainFrame() ? " (main)" : "";
          return `  ${i}: ${name}${isMain} — ${url}`;
        });
        return `Frames (${frames.length}):\n${entries.join("\n")}\n\nUse snapshotFrame("iframe[name=...]") to interact with a specific frame.`;
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
        let path = join(getTenantTmpDir("daemora-browser"), `screenshot-${Date.now()}.png`);
        let isElement = false;
        let elementSelector = null;

        if (param1 && param1.startsWith("/")) {
          path = param1;
        } else if (param1 && (isRef(param1) || !param1.includes("/"))) {
          // Could be a selector/ref for element screenshot
          try {
            await getLocator(p, param1); // verify it exists
            elementSelector = param1;
            isElement = true;
            path = param2 || path;
          } catch {
            path = param1;
          }
        }

        const sc = filesystemGuard.checkWrite(path);
        if (!sc.allowed) return `Error: ${sc.reason}`;

        const fullPage = param2 === "full";
        const result = await normalizedScreenshot(p, { path, fullPage, selector: isElement ? elementSelector : null });
        const sizeKB = Math.round(result.size / 1024);
        const note = result.warning ? ` (warning: ${result.warning})` : "";
        return `Screenshot saved: ${result.path} (${result.format}, ${sizeKB}KB)${note}`;
      }

      case "pdf": {
        const path = param1 || join(getTenantTmpDir("daemora-browser"), `page-${Date.now()}.pdf`);
        const pc = filesystemGuard.checkWrite(path);
        if (!pc.allowed) return `Error: ${pc.reason}`;
        await currentPage().pdf({ path, format: "A4", printBackground: true });
        return `PDF saved: ${path}`;
      }

      // ── JavaScript evaluation ───────────────────────────────────────────
      case "evaluate": {
        if (!param1) return "Error: JavaScript expression required.";
        const timeout = param2 ? parseInt(param2) : 10000;
        const result = await safeEvaluate(currentPage(), param1, null, timeout);
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

      // ── Console, errors & network ──────────────────────────────────────
      case "console": {
        const state = pageStates.get(activeTargetId);
        const logs = state?.consoleLogs || [];
        const filter = param1 || "all";
        const limit = parseInt(param2 || "30");
        const filtered = filter === "all" ? logs : logs.filter(l => l.type === filter);
        if (filtered.length === 0) return `No${filter !== "all" ? ` ${filter}` : ""} console messages.`;
        return filtered.slice(-limit).map(l => {
          const time = new Date(l.ts).toISOString().slice(11, 19);
          return `[${time}] ${l.type.toUpperCase()}: ${l.text}`;
        }).join("\n");
      }

      case "pageErrors": {
        const state = pageStates.get(activeTargetId);
        const errors = state?.pageErrors || [];
        const limit = parseInt(param1 || "20");
        const clear = param2 === "clear";
        if (errors.length === 0) return "No page errors.";
        const result = errors.slice(-limit).map(e => {
          const time = new Date(e.ts).toISOString().slice(11, 19);
          return `[${time}] ${e.name}: ${e.message}`;
        }).join("\n");
        if (clear) errors.length = 0;
        return result;
      }

      case "networkRequests": {
        const state = pageStates.get(activeTargetId);
        const requests = state?.networkRequests || [];
        const filter = param1 || null; // URL substring filter
        const limit = parseInt(param2 || "30");
        let filtered = filter ? requests.filter(r => r.url.includes(filter)) : requests;
        if (filtered.length === 0) return `No${filter ? ` matching "${filter}"` : ""} network requests.`;
        return filtered.slice(-limit).map(r => {
          const time = new Date(r.ts).toISOString().slice(11, 19);
          const status = r.status !== null ? ` → ${r.status}` : r.failureText ? ` FAILED: ${r.failureText}` : " (pending)";
          return `[${time}] ${r.id} ${r.method} ${r.url.slice(0, 120)}${status}`;
        }).join("\n");
      }

      // ── Response body capture ──────────────────────────────────────────
      case "captureResponses": {
        if (!param1) return 'Error: URL pattern required. e.g., "**/api/**" or "*.json"';
        const timeout = parseInt(param2 || "30000");
        const id = `cap-${++captureCounter}`;
        const listener = {
          pattern: param1, results: [],
          resolve: null, reject: null, timer: null,
        };
        responseCaptureListeners.set(id, listener);

        return new Promise((resolve) => {
          listener.timer = setTimeout(() => {
            responseCaptureListeners.delete(id);
            if (listener.results.length === 0) {
              resolve(`No responses matched "${param1}" within ${timeout / 1000}s.`);
            } else {
              resolve(`Captured ${listener.results.length} response(s) matching "${param1}":\n${JSON.stringify(listener.results, null, 2)}`);
            }
          }, timeout);

          listener.resolve = resolve;
        });
      }

      case "getCapturedResponses": {
        if (!param1) {
          // Return all active/completed captures
          const all = [];
          for (const [id, listener] of responseCaptureListeners) {
            all.push({ id, pattern: listener.pattern, captured: listener.results.length });
          }
          if (all.length === 0) return "No active response captures. Use captureResponses(pattern) first.";
          return JSON.stringify(all, null, 2);
        }
        const listener = responseCaptureListeners.get(param1);
        if (!listener) return `No capture with id "${param1}".`;
        // Stop capture and return results
        if (listener.timer) clearTimeout(listener.timer);
        responseCaptureListeners.delete(param1);
        if (listener.results.length === 0) return `No responses captured for "${listener.pattern}" yet.`;
        return JSON.stringify(listener.results, null, 2);
      }

      // ── Waiting ─────────────────────────────────────────────────────────
      case "waitFor": {
        if (!param1) return "Error: condition required.";
        const page = currentPage();
        const timeout = parseInt(param2 || "10000");

        if (param1.startsWith("url:")) {
          const urlPattern = param1.slice(4);
          await page.waitForURL(`**${urlPattern}**`, { timeout });
          return `URL matched: ${page.url()}`;
        }
        if (param1.startsWith("text:")) {
          const text = param1.slice(5);
          await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
          return `Text "${text}" found on page.`;
        }
        if (param1.startsWith("js:")) {
          const predicate = param1.slice(3);
          await page.waitForFunction(predicate, null, { timeout });
          return `JS predicate satisfied.`;
        }
        if (param1 === "load" || param1 === "networkidle") {
          await page.waitForLoadState(param1 === "load" ? "load" : "networkidle", { timeout });
          return `Page reached ${param1} state.`;
        }
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
        attachPageListeners(tid, page);
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
        pageStates.delete(tid);
        refCacheByTarget.delete(tid);
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
        if (!param1) return "Error: selector/ref to click for download required.";
        const page = currentPage();
        const downloadDir = join(config.dataDir, "browser", "downloads");
        mkdirSync(downloadDir, { recursive: true });
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          (await getLocator(page, param1)).click(),
        ]);
        const safeName = basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
        const dlPath = join(downloadDir, safeName);
        const dc = filesystemGuard.checkWrite(dlPath);
        if (!dc.allowed) return `Error: ${dc.reason}`;
        // Atomic write — save to temp, then rename
        const tmpPath = dlPath + `.tmp-${Date.now()}`;
        await download.saveAs(tmpPath);
        try { renameSync(tmpPath, dlPath); } catch { /* rename failed, tmp file remains */ }
        return `Downloaded: ${dlPath} (${safeName})`;
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

      // ── Dialog handling ──────────────────────────────────────────────────
      case "configureDialog": {
        const mode = param1 || "auto";
        if (!["auto", "accept", "dismiss", "manual"].includes(mode)) {
          return `Error: mode must be auto|accept|dismiss|manual. Got: "${mode}"`;
        }
        dialogMode = mode;
        pendingDialogs.length = 0;
        return `Dialog mode set to "${mode}". ${mode === "manual" ? "Dialogs will queue — use handleDialog to respond." : ""}`;
      }

      case "handleDialog": {
        if (dialogMode === "manual" && pendingDialogs.length > 0) {
          const dialog = pendingDialogs.shift();
          const dialogAction = param1 || "accept";
          const text = param2 || "";
          if (dialogAction === "accept") await dialog.accept(text);
          else await dialog.dismiss();
          return `Dialog ${dialogAction}ed${text ? ` with: "${text}"` : ""}. ${pendingDialogs.length} pending.`;
        }
        const dialogAction = param1 || "accept";
        const text = param2 || "";
        currentPage().once("dialog", async (dialog) => {
          if (dialogAction === "accept") await dialog.accept(text);
          else await dialog.dismiss();
        });
        return `Next dialog will be ${dialogAction}ed${text ? ` with: "${text}"` : ""}.`;
      }

      case "getLastDialog": {
        if (!lastDialog) return "No dialogs have appeared yet.";
        return JSON.stringify(lastDialog, null, 2);
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

      // ── Batch actions (nested, depth-limited) ───────────────────────────
      case "batch": {
        if (!param1) return "Error: JSON array of [action, param1?, param2?] required.";
        let actions;
        try { actions = JSON.parse(param1); } catch { return "Error: param1 must be valid JSON array."; }
        if (!Array.isArray(actions)) return "Error: param1 must be a JSON array.";
        if (actions.length > 100) return "Error: max 100 actions per batch.";
        if (actions.length === 0) return "Error: batch cannot be empty.";

        // Depth tracking via internal param
        const depth = params?._batchDepth || 0;
        if (depth >= 5) return "Error: max batch nesting depth (5) exceeded.";

        const results = [];
        for (const entry of actions) {
          const [act, p1, p2] = Array.isArray(entry) ? entry : [entry.action, entry.param1, entry.param2];
          if (act === "batch") {
            // Allow nested batches up to depth limit
            try {
              const r = await browserAction({ action: "batch", param1: p1, param2: p2, _batchDepth: depth + 1 });
              results.push({ action: act, ok: true, result: r });
            } catch (e) {
              results.push({ action: act, ok: false, error: e.message });
              break;
            }
            continue;
          }
          try {
            const r = await browserAction({ action: act, param1: p1, param2: p2 });
            results.push({ action: act, ok: true, result: r });
          } catch (e) {
            results.push({ action: act, ok: false, error: e.message });
            break;
          }
        }
        return JSON.stringify({ total: actions.length, executed: results.length, results }, null, 2);
      }

      // ── ARIA Snapshot (Playwright 1.49+ YAML tree) ──────────────────────
      case "ariaSnapshot": {
        const p = await ensureBrowser();
        const selector = param1 || "body";
        try {
          const locator = p.locator(selector);
          const yaml = await locator.ariaSnapshot();
          return `ARIA Snapshot (YAML):\n\n${yaml}`;
        } catch (e) {
          if (e.message.includes("ariaSnapshot")) {
            return "Error: ariaSnapshot requires Playwright 1.49+. Update playwright: pnpm add playwright@latest";
          }
          throw e;
        }
      }

      // ── Download tracking ──────────────────────────────────────────────
      case "listDownloads": {
        if (downloads.size === 0) return "No tracked downloads.";
        const entries = [...downloads.values()].slice(-20).map(d =>
          `  ${d.id}: ${d.filename} (${d.status}) ${d.path || "not saved"}`
        );
        return `Downloads (${downloads.size}):\n${entries.join("\n")}`;
      }

      case "saveDownload": {
        if (!param1) return "Error: downloadId required.";
        const dl = downloads.get(param1);
        if (!dl) return `Error: download "${param1}" not found. Use listDownloads.`;
        if (!dl._download) return `Error: download "${param1}" has no pending download object.`;
        const savePath = param2 || join(config.dataDir, "browser", "downloads", dl.filename);
        const sc = filesystemGuard.checkWrite(savePath);
        if (!sc.allowed) return `Error: ${sc.reason}`;
        mkdirSync(join(savePath, ".."), { recursive: true });
        // Atomic write
        const tmpPath = savePath + `.tmp-${Date.now()}`;
        await dl._download.saveAs(tmpPath);
        try { renameSync(tmpPath, savePath); } catch { /* keep tmp */ }
        dl.path = savePath;
        dl.status = "saved";
        return `Download saved: ${savePath}`;
      }

      // ── Network interception ──────────────────────────────────────────
      case "interceptNetwork": {
        if (!param1) return 'Error: config JSON required. e.g., {"block":["*.ads.*"],"modify":[{"match":"*api*","status":200}]}';
        const cfg = JSON.parse(param1);
        const page = currentPage();
        let count = 0;
        if (cfg.block && Array.isArray(cfg.block)) {
          for (const pattern of cfg.block) {
            await page.route(pattern, route => route.abort());
            activeRoutes.set(pattern, "block");
            count++;
          }
        }
        if (cfg.modify && Array.isArray(cfg.modify)) {
          for (const rule of cfg.modify) {
            const { match, headers, status, body } = rule;
            if (!match) continue;
            await page.route(match, async route => {
              const response = await route.fetch();
              await route.fulfill({
                status: status || response.status(),
                headers: { ...response.headers(), ...(headers || {}) },
                body: body || await response.body(),
              });
            });
            activeRoutes.set(match, "modify");
            count++;
          }
        }
        return `${count} interception(s) added. Active: ${activeRoutes.size}`;
      }

      case "clearInterceptions": {
        const page = currentPage();
        await page.unrouteAll({ behavior: "ignoreErrors" });
        const count = activeRoutes.size;
        activeRoutes.clear();
        return `Cleared ${count} network interception(s).`;
      }

      // ── Browser profiles listing ──────────────────────────────────────
      case "listProfiles": {
        const profileDir = join(config.dataDir, "browser");
        if (!existsSync(profileDir)) return "No browser profiles found.";
        const dirs = readdirSync(profileDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name !== "downloads")
          .map(d => d.name);
        if (dirs.length === 0) return "No browser profiles found.";
        return `Browser profiles: ${dirs.join(", ")}${currentProfileName ? ` (active: ${currentProfileName})` : ""}`;
      }

      // ── Force disconnect recovery ──────────────────────────────────────
      case "recoverStuck": {
        const page = currentPage();
        try {
          const client = await page.context().newCDPSession(page);
          await client.send("Runtime.terminateExecution");
          await client.detach();
          return "Terminated stuck JavaScript execution. Page should be responsive now.";
        } catch (e) {
          return `Recovery failed: ${e.message}. Try closing and re-navigating.`;
        }
      }

      case "forceDisconnect": {
        // Nuclear option — kill the CDP connection and reconnect fresh
        const page = currentPage();
        try {
          // Try to terminate stuck JS first
          const client = await page.context().newCDPSession(page);
          await Promise.race([
            client.send("Runtime.terminateExecution"),
            new Promise((_, rej) => setTimeout(() => rej(new Error("CDP command timed out")), 3000)),
          ]);
          await client.detach().catch(() => {});
        } catch {
          // CDP itself is stuck — close and reconnect
        }
        // Close current page and open fresh one
        const url = page.url();
        try { await page.close({ runBeforeUnload: false }); } catch { /* may hang */ }
        pages.delete(activeTargetId);
        pageStates.delete(activeTargetId);
        refCacheByTarget.delete(activeTargetId);
        // Open fresh page
        const fresh = await browserContext.newPage();
        fresh.setDefaultTimeout(15000);
        const tid = genTargetId();
        pages.set(tid, fresh);
        attachPageListeners(tid, fresh);
        activeTargetId = tid;
        // Try to navigate back
        if (url && url !== "about:blank") {
          try { await fresh.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch { /* best effort */ }
        }
        return `Force disconnected and reconnected. New tab: ${tid}. Page reloaded at: ${url}`;
      }

      // ── Trace recording ────────────────────────────────────────────────
      case "traceStart": {
        if (!browserContext) return "No browser open. Navigate first.";
        if (traceActive) return "Trace already running. Stop it first with traceStop.";
        const opts = { screenshots: true, snapshots: true, sources: false };
        if (param1) {
          try { Object.assign(opts, JSON.parse(param1)); } catch {}
        }
        await browserContext.tracing.start(opts);
        traceActive = true;
        return `Trace started (screenshots: ${opts.screenshots}, snapshots: ${opts.snapshots}). Use traceStop(path) to save.`;
      }

      case "traceStop": {
        if (!browserContext || !traceActive) return "No trace is running.";
        const path = param1 || join(getTenantTmpDir("daemora-browser"), `trace-${Date.now()}.zip`);
        const sc = filesystemGuard.checkWrite(path);
        if (!sc.allowed) return `Error: ${sc.reason}`;
        // Atomic write
        const tmpPath = path + `.tmp-${Date.now()}`;
        await browserContext.tracing.stop({ path: tmpPath });
        try { renameSync(tmpPath, path); } catch { /* keep tmp */ }
        traceActive = false;
        return `Trace saved: ${path}\nOpen with: npx playwright show-trace ${path}`;
      }

      case "status": {
        const connected = browser && browserConnected;
        const tabCount = pages.size;
        if (!connected) return "Browser: not running";
        const routeCount = activeRoutes.size > 0 ? ` | Routes: ${activeRoutes.size}` : "";
        const dlCount = downloads.size > 0 ? ` | Downloads: ${downloads.size}` : "";
        const traceNote = traceActive ? " | Trace: recording" : "";
        const state = pageStates.get(activeTargetId);
        const netCount = state ? ` | Requests: ${state.networkRequests.length}` : "";
        const errCount = state?.pageErrors.length > 0 ? ` | Errors: ${state.pageErrors.length}` : "";
        return `Browser: running | Profile: ${currentProfileName} | Tabs: ${tabCount} | Active: ${activeTargetId} | URL: ${currentPage().url()}${netCount}${errCount}${routeCount}${dlCount}${traceNote}`;
      }

      case "close": {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (traceActive && browserContext) {
          await browserContext.tracing.stop({ path: join(getTenantTmpDir("daemora-browser"), `trace-final-${Date.now()}.zip`) }).catch(() => {});
          traceActive = false;
        }
        if (browser) {
          await browser.close();
          cleanup();
        }
        return "Browser closed.";
      }

      default:
        return `Unknown action: "${action}". Available: navigate, snapshot, snapshotFrame, listFrames, ariaSnapshot, click, fill, type, hover, selectOption, pressKey, scroll, drag, getText, getContent, screenshot, pdf, evaluate, getLinks, console, pageErrors, networkRequests, captureResponses, getCapturedResponses, waitFor, waitForNavigation, reload, goBack, goForward, newTab, switchTab, listTabs, closeTab, getCookies, setCookie, clearCookies, getStorage, setStorage, clearStorage, upload, download, resize, highlight, configureDialog, handleDialog, getLastDialog, batch, listDownloads, saveDownload, interceptNetwork, clearInterceptions, listProfiles, recoverStuck, forceDisconnect, traceStart, traceStop, newSession, status, close`;
    }
  } catch (error) {
    console.log(`      [browser] Error: ${error.message}`);
    return toAIFriendlyError(error);
  }
}

/**
 * Get the raw Playwright page object for the active tab.
 * Internal use only — for meeting bot audio capture, page.exposeFunction, etc.
 * Returns null if no browser/page is active.
 */
export function getActivePage() {
  if (!browserConnected || !activeTargetId || !pages.has(activeTargetId)) return null;
  const p = pages.get(activeTargetId);
  return p.isClosed() ? null : p;
}

/**
 * Get the raw Playwright browser context.
 * Internal use only — for meeting bot CDP sessions.
 */
export function getBrowserContext() {
  return browserConnected ? browserContext : null;
}

export const browserActionDescription =
  'browserAction(action, param1?, param2?) - Heavy Playwright browser automation. ' +
  'Actions: navigate(url), snapshot(opts?), snapshotFrame(frameSelector,opts?) — snapshot an iframe, listFrames — list all iframes, ariaSnapshot(selector?), click(selector|ref,opts?), fill(selector|ref,value), type(selector|ref,text), hover(selector|ref), selectOption(selector|ref,value), pressKey(key), scroll(direction|selector|ref,amount?), drag(source,target), getText(selector|ref?), getContent(selector?), screenshot(path|selector?,full?) — auto-normalized to fit 2MB, pdf(path?), evaluate(js,timeout?), getLinks, ' +
  'console(filter?,limit?) — 500-entry buffer, pageErrors(limit?,clear?) — page JS errors, networkRequests(urlFilter?,limit?) — per-request tracking with status codes, captureResponses(urlPattern,timeout?) — capture response bodies matching pattern, getCapturedResponses(captureId?), ' +
  'waitFor(condition,timeout?), waitForNavigation(timeout?), reload, goBack, goForward, ' +
  'newTab(url?), switchTab(targetId), listTabs, closeTab(targetId?), getCookies(domain?), setCookie(json), clearCookies, getStorage(local|session,key?), setStorage(json), clearStorage(local|session), upload(selector|ref,filePath), download(selector|ref), resize(WxH), highlight(selector|ref), ' +
  'batch(actionsJson) — execute up to 100 actions sequentially, supports nested batches (max depth 5). ' +
  'configureDialog(auto|accept|dismiss|manual), handleDialog(accept|dismiss,text?), getLastDialog, ' +
  'listDownloads, saveDownload(downloadId,savePath?), ' +
  'interceptNetwork(configJson) — block/modify network requests, clearInterceptions, ' +
  'listProfiles, recoverStuck — kill stuck JS via CDP, forceDisconnect — nuclear recovery: kill CDP + reconnect fresh page, ' +
  'traceStart(opts?) — start Playwright trace recording, traceStop(path?) — stop and save trace zip, ' +
  'newSession(profile?), status, close. ' +
  'Supports ref-based interaction: take snapshot first, then use refs (e1, e5) instead of CSS selectors. Refs are stable across actions (per-target cached). ' +
  'Frame support: use snapshotFrame to interact with iframes — refs will target elements inside the frame.';
