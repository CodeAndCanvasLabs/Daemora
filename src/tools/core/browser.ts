/// <reference lib="dom" />
/**
 * browser — heavy Playwright-based web control. Single discriminated tool
 * exposing ~60 actions so the agent can drive a real browser end-to-end
 * (login flows, multi-tab, downloads, iframes, network intercept, PDFs,
 * video-rec via trace, ARIA-tree refs for stable element targeting).
 *
 * Three engine modes the agent picks per-task via `start({ mode })`:
 *
 *   • persistent — Chromium with a persistent profile dir at
 *     `<dataDir>/browser/<profile>/`. Logins, cookies, localStorage all
 *     survive between runs. This is the default and handles most real
 *     account-control tasks.
 *
 *   • attach — connect over CDP to a Chrome the user is already running
 *     (`chrome --remote-debugging-port=9222`). Inherits the user's real
 *     fingerprint, extensions, and live session. The strongest stealth
 *     because it IS a real Chrome.
 *
 *   • ephemeral — launch in incognito with no profile dir. Throwaway.
 *
 * Stealth path: when `profile.startsWith("meeting-")` or `stealth: true`,
 * we route launch through `playwright-extra` + `puppeteer-extra-plugin-
 * stealth` (patches navigator.webdriver, plugins, fonts, WebGL). This
 * catches ~95% of basic bot detection.
 *
 * Captcha policy (no paid solvers): stealth + warm profile + vision-click
 * fallback. The `clickVision` action takes a screenshot, asks Claude
 * Opus 4.7 for the pixel coords of an instruction (e.g. "click the
 * 'I am not a robot' checkbox"), and runs `clickCoords`. If a captcha
 * STILL fires, the tool returns `{ captchaDetected: true }` and the
 * agent can fall back to `reply_to_user` to ask for human help.
 *
 * Source-of-truth port from `agents/daemora-js/src/tools/browserAutomation.js`.
 */

import { mkdirSync, existsSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { z } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import type { EventBus } from "../../events/eventBus.js";
import type { FilesystemGuard } from "../../safety/FilesystemGuard.js";
import type { ToolDef } from "../types.js";

// Type-only imports — playwright is loaded dynamically so the rest of
// the agent works even if the package isn't installed yet.
type PWBrowser = import("playwright").Browser;
type PWBrowserContext = import("playwright").BrowserContext;
type PWPage = import("playwright").Page;
type PWLocator = import("playwright").Locator;
type PWDownload = import("playwright").Download;

// ─── Module-scoped state ────────────────────────────────────────────────────
// The tool keeps a single browser session so action calls share context
// (cookies, tabs, ref cache). All mutable state below is reset by cleanup().

let browser: PWBrowser | PWBrowserContext | null = null;
let browserContext: PWBrowserContext | null = null;
let browserConnected = false;
const pages = new Map<string, PWPage>();
let activeTargetId: string | null = null;
let targetCounter = 0;
let inactivityTimer: NodeJS.Timeout | null = null;
const INACTIVITY_TIMEOUT = 5 * 60 * 1000;

const MAX_CONSOLE_LOGS = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
const MAX_REF_CACHE = 50;

interface ConsoleEntry { type: string; text: string; ts: number }
interface PageErrorEntry { name: string; message: string; stack?: string; ts: number }
interface NetEntry { id: string; method: string; url: string; resourceType: string; status: number | null; ok: boolean | null; failureText: string | null; ts: number }
interface PageState {
  consoleLogs: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  networkRequests: NetEntry[];
  nextRequestId: number;
  requestMap: WeakMap<object, string>;
}
const pageStates = new Map<string, PageState>();

interface RefInfo { role: string; name: string; nth: number }
interface RefCache { refs: Map<string, RefInfo>; counter: number; frameSelector: string | null }
const refCacheByTarget = new Map<string, RefCache>();
let activeRefTarget: string | null = null;

interface DownloadEntry {
  id: string;
  filename: string;
  url: string;
  path: string | null;
  status: "pending" | "completed" | "saved" | "needs-save";
  timestamp: number;
  _download?: PWDownload;
}
const downloads = new Map<string, DownloadEntry>();
let downloadCounter = 0;

interface DialogEntry { type: string; message: string; defaultValue: string; timestamp: number }
let lastDialog: DialogEntry | null = null;
type DialogMode = "auto" | "accept" | "dismiss" | "manual";
let dialogMode: DialogMode = "auto";
const pendingDialogs: import("playwright").Dialog[] = [];

const activeRoutes = new Map<string, "block" | "modify">();

interface ResponseCaptured { url: string; status: number; headers: Record<string, string>; body: string }
interface ResponseListener {
  pattern: string;
  results: ResponseCaptured[];
  resolve: ((v: string) => void) | null;
  timer: NodeJS.Timeout | null;
}
const responseCaptureListeners = new Map<string, ResponseListener>();
let captureCounter = 0;

let currentProfileName = "default";
let currentMode: "persistent" | "attach" | "ephemeral" = "persistent";
let traceActive = false;

// ─── Navigation guard — block private network ranges ───────────────────────
const NAV_BLOCKLIST: readonly RegExp[] = [
  /^file:\/\//i,
  /^(https?:\/\/)(10\.\d+\.\d+\.\d+)/,
  /^(https?:\/\/)(172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+)/,
  /^(https?:\/\/)(192\.168\.\d+\.\d+)/,
  /^(https?:\/\/)(169\.254\.\d+\.\d+)/,
];
const isBlockedUrl = (u: string): boolean => NAV_BLOCKLIST.some((p) => p.test(u));

// ─── AI-friendly error messages ────────────────────────────────────────────
function toAIFriendlyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("strict mode violation") || msg.includes("resolved to")) {
    const match = msg.match(/resolved to (\d+) elements/);
    const n = match ? match[1] : "multiple";
    return `Matched ${n} elements - run snapshot to get updated refs and use a more specific one.`;
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
    return `Browser/page was closed. Use start or navigate to open a new page.`;
  }
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) return `Connection refused - server may not be running at this URL.`;
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) return `DNS lookup failed - check the URL spelling.`;
  if (msg.includes("net::ERR_CERT")) return `SSL certificate error. The site may have an invalid or expired certificate.`;
  if (msg.includes("net::ERR_TOO_MANY_REDIRECTS")) return `Too many redirects - the site is in a redirect loop. Check cookies/auth state.`;
  if (msg.includes("Evaluate timed out") || msg.includes("terminateExecution")) {
    return `JavaScript execution timed out - the page script is stuck. Use forceDisconnect to recover.`;
  }
  if (msg.includes("Unknown ref")) return msg;
  if (msg.includes("frame was detached")) return `The iframe was removed from the page. Take a fresh snapshot.`;
  return `Browser error: ${msg}`;
}

// ─── Lifecycle helpers ──────────────────────────────────────────────────────
function resetInactivityTimer(): void {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(async () => {
    if (browser) {
      try { await (browser as PWBrowserContext).close(); } catch { /* ignore */ }
      cleanup();
    }
  }, INACTIVITY_TIMEOUT);
}

function cleanup(): void {
  browser = null;
  browserContext = null;
  browserConnected = false;
  pages.clear();
  pageStates.clear();
  refCacheByTarget.clear();
  downloads.clear();
  activeRoutes.clear();
  for (const l of responseCaptureListeners.values()) if (l.timer) clearTimeout(l.timer);
  responseCaptureListeners.clear();
  activeTargetId = null;
  activeRefTarget = null;
  lastDialog = null;
  dialogMode = "auto";
  pendingDialogs.length = 0;
  currentProfileName = "default";
  currentMode = "persistent";
  traceActive = false;
}

function genTargetId(): string { return `t${++targetCounter}`; }

function ensurePageState(targetId: string): PageState {
  let s = pageStates.get(targetId);
  if (!s) {
    s = { consoleLogs: [], pageErrors: [], networkRequests: [], nextRequestId: 0, requestMap: new WeakMap() };
    pageStates.set(targetId, s);
  }
  return s;
}

function getOrCreateRefCache(targetId: string): RefCache {
  let c = refCacheByTarget.get(targetId);
  if (!c) {
    if (refCacheByTarget.size >= MAX_REF_CACHE) {
      const oldest = refCacheByTarget.keys().next().value;
      if (oldest) refCacheByTarget.delete(oldest);
    }
    c = { refs: new Map(), counter: 0, frameSelector: null };
    refCacheByTarget.set(targetId, c);
  }
  return c;
}

function attachPageListeners(targetId: string, page: PWPage): void {
  const state = ensurePageState(targetId);

  page.on("console", (msg) => {
    state.consoleLogs.push({ type: msg.type(), text: msg.text(), ts: Date.now() });
    if (state.consoleLogs.length > MAX_CONSOLE_LOGS) state.consoleLogs.shift();
  });

  page.on("pageerror", (err) => {
    const entry: PageErrorEntry = { name: err.name, message: err.message, ts: Date.now() };
    if (err.stack) entry.stack = err.stack;
    state.pageErrors.push(entry);
    if (state.pageErrors.length > MAX_PAGE_ERRORS) state.pageErrors.shift();
  });

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
    const entry = state.networkRequests.find((r) => r.id === id);
    if (entry) { entry.status = response.status(); entry.ok = response.ok(); }
    for (const listener of responseCaptureListeners.values()) {
      if (matchUrlPattern(listener.pattern, response.url())) {
        response.body().then((buf) => {
          listener.results.push({
            url: response.url(),
            status: response.status(),
            headers: response.headers(),
            body: buf.toString("utf-8").slice(0, 200_000),
          });
        }).catch(() => { /* ignore */ });
      }
    }
  });

  page.on("requestfailed", (request) => {
    const id = state.requestMap.get(request);
    if (!id) return;
    const entry = state.networkRequests.find((r) => r.id === id);
    if (entry) { entry.ok = false; entry.failureText = request.failure()?.errorText ?? "unknown"; }
  });

  page.on("download", (download) => {
    const id = `dl-${++downloadCounter}`;
    const safeName = basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
    const entry: DownloadEntry = {
      id, filename: safeName, url: download.url(), path: null,
      status: "pending", timestamp: Date.now(), _download: download,
    };
    downloads.set(id, entry);
    download.path().then((p) => { entry.path = p; entry.status = "completed"; })
      .catch(() => { if (entry.status === "pending") entry.status = "needs-save"; });
    if (downloads.size > 50) {
      const oldest = downloads.keys().next().value;
      if (oldest) downloads.delete(oldest);
    }
  });
}

// ─── Engine launch — three modes ───────────────────────────────────────────
interface EngineOpts {
  mode?: "persistent" | "attach" | "ephemeral";
  profile?: string;
  headless?: boolean;
  cdpUrl?: string;
  stealth?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

async function ensureBrowser(cfg: ConfigManager, opts: EngineOpts = {}): Promise<PWPage> {
  resetInactivityTimer();

  if (browser && browserConnected) {
    if (!activeTargetId || !pages.has(activeTargetId) || pages.get(activeTargetId)!.isClosed()) {
      const page = await browserContext!.newPage();
      page.setDefaultTimeout(15_000);
      const tid = genTargetId();
      pages.set(tid, page);
      attachPageListeners(tid, page);
      activeTargetId = tid;
    }
    return pages.get(activeTargetId!)!;
  }

  const mode = opts.mode ?? "persistent";
  const profileName = opts.profile ?? "default";
  const stealth = opts.stealth ?? profileName.startsWith("meeting-");
  const viewport = opts.viewport ?? { width: 1280, height: 720 };
  const userAgent = opts.userAgent
    ?? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

  // Stealth path: use playwright-extra with the puppeteer stealth plugin.
  // The plugin patches navigator.webdriver, plugins, languages, the WebGL
  // fingerprint, etc. — defeats most basic bot checks.
  const loadChromium = async () => {
    if (stealth) {
      try {
        const { chromium: stealthChromium } = await import("playwright-extra");
        const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
        const plugin = StealthPlugin();
        plugin.enabledEvasions.delete("iframe.contentWindow");
        plugin.enabledEvasions.delete("media.codecs");
        stealthChromium.use(plugin);
        return stealthChromium as unknown as typeof import("playwright").chromium;
      } catch {
        // playwright-extra/stealth not installed — fall through to vanilla
      }
    }
    const { chromium } = await import("playwright");
    return chromium;
  };

  try {
    if (mode === "attach") {
      const cdpUrl = opts.cdpUrl ?? "http://localhost:9222";
      const { chromium } = await import("playwright");
      const connected = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 });
      // connectOverCDP returns a Browser; we adopt its first context
      const contexts = connected.contexts();
      browserContext = contexts[0] ?? (await connected.newContext({ viewport }));
      browser = connected;
      browserConnected = true;
      currentMode = "attach";
      currentProfileName = `attach@${cdpUrl}`;

      browserContext.on("close", () => cleanup());
      attachContextDialog(browserContext);

      const existing = browserContext.pages();
      const page = existing.length > 0 ? existing[0]! : await browserContext.newPage();
      page.setDefaultTimeout(15_000);
      const tid = genTargetId();
      pages.set(tid, page);
      attachPageListeners(tid, page);
      activeTargetId = tid;
      return page;
    }

    const launcher = await loadChromium();

    const launchArgs: string[] = stealth
      ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--allow-running-insecure-content",
          "--ignore-certificate-errors",
        ]
      : ["--disable-blink-features=AutomationControlled"];

    if (mode === "ephemeral") {
      const launched = await launcher.launch({
        headless: opts.headless ?? false,
        args: launchArgs,
      });
      browserContext = await launched.newContext({
        viewport,
        userAgent,
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
      });
      browser = launched;
      currentMode = "ephemeral";
      currentProfileName = `ephemeral@${Date.now()}`;
    } else {
      // persistent
      const userDataDir = join(cfg.env.dataDir, "browser", profileName);
      mkdirSync(userDataDir, { recursive: true });
      const ctx = await launcher.launchPersistentContext(userDataDir, {
        headless: opts.headless ?? false,
        viewport,
        userAgent,
        acceptDownloads: true,
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        args: launchArgs,
      });
      browser = ctx;
      browserContext = ctx;
      currentMode = "persistent";
      currentProfileName = profileName;
    }

    browserConnected = true;
    browserContext.on("close", () => cleanup());
    attachContextDialog(browserContext);

    const existingPages = browserContext.pages();
    const page = existingPages.length > 0 ? existingPages[0]! : await browserContext.newPage();
    page.setDefaultTimeout(15_000);
    const tid = genTargetId();
    pages.set(tid, page);
    attachPageListeners(tid, page);
    activeTargetId = tid;
    return page;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Cannot find package") || msg.includes("ERR_MODULE_NOT_FOUND") || msg.includes("playwright")) {
      throw new Error("Playwright not installed. Run: npm i playwright playwright-extra puppeteer-extra-plugin-stealth && npx playwright install chromium");
    }
    throw error;
  }
}

function attachContextDialog(ctx: PWBrowserContext): void {
  ctx.on("dialog", async (dialog) => {
    lastDialog = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), timestamp: Date.now() };
    if (dialogMode === "accept") await dialog.accept();
    else if (dialogMode === "dismiss") await dialog.dismiss();
    else if (dialogMode === "manual") pendingDialogs.push(dialog);
    else await dialog.dismiss();
  });
}

function currentPage(): PWPage {
  if (!activeTargetId || !pages.has(activeTargetId)) {
    throw new Error("No browser open. Use start or navigate first.");
  }
  const p = pages.get(activeTargetId)!;
  if (p.isClosed()) throw new Error("Current page is closed. Navigate to a URL first.");
  resetInactivityTimer();
  return p;
}

// ─── URL pattern matching for response capture / route ─────────────────────
function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*");
  return new RegExp(escaped, "i").test(url);
}

// ─── Accessibility snapshot — ARIA tree with stable refs ───────────────────
interface AxNode {
  role: string;
  name?: string;
  value?: string;
  checked?: boolean | "mixed";
  selected?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  level?: number;
  children?: AxNode[];
}
interface SnapshotOpts {
  selector?: string;
  interactive?: boolean;
  compact?: boolean;
  maxChars?: number;
  frameSelector?: string;
}

async function buildAccessibilitySnapshot(page: PWPage, opts: SnapshotOpts = {}): Promise<{ text: string; refs: Record<string, RefInfo>; count: number }> {
  const { interactive, compact, maxChars = 50_000, frameSelector } = opts;
  const cache = getOrCreateRefCache(activeTargetId!);
  cache.refs.clear();
  cache.counter = 0;
  cache.frameSelector = frameSelector ?? null;
  activeRefTarget = activeTargetId;

  // Newer Playwright (1.49+) replaced Page.accessibility.snapshot with
  // locator.ariaSnapshot which returns a YAML string we walk into a tree.
  // We use the page's body as the root for the main page, or the matching
  // frame's body when a frameSelector was given.
  let yaml: string;
  if (frameSelector) {
    try {
      yaml = await page.frameLocator(frameSelector).locator("body").ariaSnapshot();
    } catch {
      const matched = page.frames().find((f) => f !== page.mainFrame() && f.url());
      if (!matched) return { text: `(empty frame - no accessible content in "${frameSelector}")`, refs: {}, count: 0 };
      yaml = await matched.locator("body").ariaSnapshot();
    }
  } else {
    yaml = await page.locator("body").ariaSnapshot();
  }

  const tree = parseAriaSnapshotYaml(yaml);
  if (!tree) return { text: "(empty page - no accessible content)", refs: {}, count: 0 };
  return buildTreeFromNode(tree, cache, { ...(interactive !== undefined ? { interactive } : {}), ...(compact !== undefined ? { compact } : {}), maxChars });
}

// ariaSnapshot returns YAML like:
//   - banner:
//       - heading "Welcome" [level=1]
//       - link "Home" [active]
// We don't need a full YAML parser — a line-based pass is enough for the
// tree shape we use. Each line: `<indent>- <role>[ "name"][ /url][ [attr=val]...]`.
function parseAriaSnapshotYaml(yaml: string): AxNode | null {
  if (!yaml || !yaml.trim()) return null;
  const lines = yaml.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  type Item = { node: AxNode; indent: number };
  const root: AxNode = { role: "root", children: [] };
  const stack: Item[] = [{ node: root, indent: -1 }];

  for (const raw of lines) {
    const indentMatch = raw.match(/^( *)-\s*(.*)$/);
    if (!indentMatch) continue;
    const indent = indentMatch[1]!.length;
    const rest = indentMatch[2]!.trim();
    const node = parseAriaLine(rest);
    if (!node) continue;
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    parent.children = parent.children ?? [];
    parent.children.push(node);
    stack.push({ node, indent });
  }

  if (root.children && root.children.length === 1) return root.children[0]!;
  return root;
}

function parseAriaLine(line: string): AxNode | null {
  // Strip trailing ":" used as section markers
  const cleaned = line.replace(/:\s*$/, "").trim();
  if (!cleaned) return null;
  // role + optional "name" + optional /url (links) + optional [attr] flags
  const m = cleaned.match(/^([a-zA-Z][\w-]*)\s*(?:"([^"]*)")?\s*(?:\/([^\s\[]*))?\s*(.*)$/);
  if (!m) return { role: cleaned };
  const role = m[1] ?? cleaned;
  const node: AxNode = { role };
  if (m[2]) node.name = m[2];
  // attribute flags inside square brackets
  const attrs = m[4] ?? "";
  for (const attr of attrs.matchAll(/\[([^\]]+)\]/g)) {
    const a = attr[1]!;
    if (a === "checked") node.checked = true;
    else if (a === "unchecked") node.checked = false;
    else if (a === "disabled") node.disabled = true;
    else if (a === "selected") node.selected = true;
    else if (a === "expanded") node.expanded = true;
    else if (a === "collapsed") node.expanded = false;
    else if (a.startsWith("level=")) node.level = parseInt(a.slice(6), 10) || 0;
    else if (a.startsWith("value=")) node.value = a.slice(6).replace(/^"|"$/g, "");
  }
  return node;
}

function buildTreeFromNode(tree: AxNode, cache: RefCache, opts: { interactive?: boolean; compact?: boolean; maxChars?: number }): { text: string; refs: Record<string, RefInfo>; count: number } {
  const { interactive, compact, maxChars = 50_000 } = opts;
  const lines: string[] = [];
  const refs: Record<string, RefInfo> = {};
  const roleCounts = new Map<string, number>();

  const countDuplicates = (node: AxNode | undefined): void => {
    if (!node) return;
    const key = `${node.role}::${node.name ?? ""}`;
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
    if (node.children) for (const c of node.children) countDuplicates(c);
  };
  countDuplicates(tree);

  const seenCounts = new Map<string, number>();

  const walk = (node: AxNode | undefined, depth = 0): void => {
    if (!node) return;
    const indent = "  ".repeat(depth);
    const ref = `e${++cache.counter}`;
    const isInteractive = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox", "option"].includes(node.role);
    if (interactive && !isInteractive && !node.children?.length) return;

    const parts = [`${indent}[${ref}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`value="${node.value}"`);
    if (node.checked !== undefined) parts.push(node.checked ? "checked" : "unchecked");
    if (node.selected) parts.push("selected");
    if (node.disabled) parts.push("disabled");
    if (node.expanded !== undefined) parts.push(node.expanded ? "expanded" : "collapsed");
    if (node.level) parts.push(`level=${node.level}`);

    const key = `${node.role}::${node.name ?? ""}`;
    const totalCount = roleCounts.get(key) ?? 0;
    const seen = seenCounts.get(key) ?? 0;
    seenCounts.set(key, seen + 1);
    const nth = totalCount > 1 ? seen : 0;

    const refInfo: RefInfo = { role: node.role, name: node.name ?? "", nth };
    refs[ref] = refInfo;
    cache.refs.set(ref, refInfo);

    if (!compact || isInteractive || depth <= 1) lines.push(parts.join(" "));
    if (node.children) for (const c of node.children) walk(c, depth + 1);
  };

  walk(tree);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n... (truncated at ${maxChars} chars)`;
  return { text, refs, count: cache.counter };
}

async function resolveRef(page: PWPage, ref: string): Promise<PWLocator> {
  let cache = refCacheByTarget.get(activeTargetId!);
  if ((!cache || !cache.refs.has(ref)) && activeRefTarget && activeRefTarget !== activeTargetId) {
    cache = refCacheByTarget.get(activeRefTarget);
  }
  if (!cache || !cache.refs.has(ref)) throw new Error(`Unknown ref "${ref}". Take a fresh snapshot first.`);

  const info = cache.refs.get(ref)!;
  const { role, name, nth } = info;

  let scope: PWPage | ReturnType<PWPage["frameLocator"]> = page;
  if (cache.frameSelector) scope = page.frameLocator(cache.frameSelector);

  if (name) {
    const locator = (scope as PWPage).getByRole(role as Parameters<PWPage["getByRole"]>[0], { name, exact: false });
    const count = await locator.count();
    if (count === 1) return locator;
    if (count > 1) {
      if (nth > 0 && nth < count) return locator.nth(nth);
      return locator.first();
    }
  }
  const locator = (scope as PWPage).getByRole(role as Parameters<PWPage["getByRole"]>[0]);
  const count = await locator.count();
  if (count === 1) return locator;
  if (count > 0) {
    if (nth > 0 && nth < count) return locator.nth(nth);
    return locator.first();
  }
  throw new Error(`Could not locate element for ref "${ref}" (role=${role}, name="${name}"). Page may have changed - take a fresh snapshot.`);
}

const isRef = (v: string): boolean => /^e\d+$/.test(v);

async function getLocator(page: PWPage, selectorOrRef: string): Promise<PWLocator> {
  if (isRef(selectorOrRef)) return resolveRef(page, selectorOrRef);
  return page.locator(selectorOrRef);
}

// ─── Safe evaluate with bounded timeout ────────────────────────────────────
async function safeEvaluate(page: PWPage, code: string, timeout = 10_000): Promise<unknown> {
  const clamped = Math.max(500, Math.min(120_000, timeout));
  return Promise.race([
    page.evaluate(code) as Promise<unknown>,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Evaluate timed out after ${clamped}ms`)), clamped)),
  ]);
}

// ─── Screenshot normalization (auto-resize/quality) ────────────────────────
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

async function normalizedScreenshot(page: PWPage, opts: { path: string; fullPage?: boolean; selector?: string | null }): Promise<{ path: string; size: number; format: "png" | "jpeg"; quality?: number; warning?: string }> {
  const { path: savePath, fullPage = false, selector } = opts;
  let buffer: Buffer;
  if (selector) {
    const loc = await getLocator(page, selector);
    buffer = await loc.screenshot({ type: "png" });
  } else {
    buffer = await page.screenshot({ type: "png", fullPage });
  }
  if (buffer.length <= MAX_SCREENSHOT_BYTES) {
    writeFileSync(savePath, buffer);
    return { path: savePath, size: buffer.length, format: "png" };
  }
  const qualities = [85, 75, 65, 50, 35];
  const jpegPath = savePath.replace(/\.png$/i, ".jpg");
  for (const quality of qualities) {
    if (selector) {
      const loc = await getLocator(page, selector);
      buffer = await loc.screenshot({ type: "jpeg", quality });
    } else {
      buffer = await page.screenshot({ type: "jpeg", fullPage, quality });
    }
    if (buffer.length <= MAX_SCREENSHOT_BYTES) {
      writeFileSync(jpegPath, buffer);
      return { path: jpegPath, size: buffer.length, format: "jpeg", quality };
    }
  }
  writeFileSync(jpegPath, buffer);
  return { path: jpegPath, size: buffer.length, format: "jpeg", quality: 35, warning: "Image exceeds 2MB limit" };
}

// ─── Vision-click — screenshot → LLM → clickCoords ─────────────────────────
// Defeats anti-bot detectors that scrutinize DOM-click event paths and is the
// fallback for canvas apps / iframes / shadow-DOM clicks where ARIA refs fail.
// Uses Anthropic vision (Claude Opus 4.7) when ANTHROPIC_API_KEY is set,
// falling back to OpenAI gpt-4o when only OPENAI_API_KEY is set.
async function visionLocateClick(cfg: ConfigManager, page: PWPage, instruction: string): Promise<{ x: number; y: number; reasoning: string }> {
  const tmpPath = join(tmpdir(), `daemora-vision-${Date.now()}.png`);
  const result = await normalizedScreenshot(page, { path: tmpPath, fullPage: false });
  const img = await readFile(result.path);
  const base64 = img.toString("base64");
  const mimeType = result.format === "png" ? "image/png" : "image/jpeg";
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };

  const prompt = `You are looking at a screenshot of a web page (viewport: ${viewport.width}x${viewport.height}px).
The user asked: "${instruction}"

Identify the EXACT pixel coordinates of the element to click. Respond with ONLY a single line of JSON:
{"x": <integer>, "y": <integer>, "why": "<short reason>"}

Coordinates are zero-indexed from the top-left. If the element is not visible, respond with {"x": -1, "y": -1, "why": "<reason not found>"}.`;

  const anthKey = cfg.vault.get("ANTHROPIC_API_KEY")?.reveal();
  const oaiKey = cfg.vault.get("OPENAI_API_KEY")?.reveal();

  let raw = "";
  if (anthKey) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-7",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Vision API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: { text: string }[] };
    raw = data.content[0]?.text ?? "";
  } else if (oaiKey) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${oaiKey}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        }],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Vision API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    raw = data.choices[0]?.message?.content ?? "";
  } else {
    throw new Error("Vision-click needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the vault.");
  }

  const m = raw.match(/\{[^}]*"x"\s*:\s*(-?\d+)[^}]*"y"\s*:\s*(-?\d+)[^}]*\}/);
  if (!m) throw new Error(`Vision model returned unparseable coords: ${raw.slice(0, 200)}`);
  const x = parseInt(m[1]!, 10);
  const y = parseInt(m[2]!, 10);
  if (x < 0 || y < 0) throw new Error(`Vision could not locate "${instruction}". Model said: ${raw.slice(0, 200)}`);
  return { x, y, reasoning: raw.slice(0, 200) };
}

// ─── Captcha detection — DOM-side heuristic, no paid solver ────────────────
async function detectCaptchaOnPage(page: PWPage): Promise<{ detected: boolean; kind?: string; selector?: string }> {
  return page.evaluate(() => {
    const checks: { kind: string; sel: string }[] = [
      { kind: "recaptcha-v2", sel: "iframe[src*='recaptcha/api2/anchor']" },
      { kind: "recaptcha-v3", sel: "script[src*='recaptcha/api.js']" },
      { kind: "hcaptcha", sel: "iframe[src*='hcaptcha.com']" },
      { kind: "cf-turnstile", sel: "iframe[src*='challenges.cloudflare.com']" },
      { kind: "cf-challenge", sel: "div#challenge-running, div.cf-browser-verification" },
      { kind: "datadome", sel: "iframe[src*='datadome.co']" },
      { kind: "arkose", sel: "iframe[src*='arkoselabs.com']" },
    ];
    for (const c of checks) {
      const el = document.querySelector(c.sel);
      if (el) return { detected: true, kind: c.kind, selector: c.sel };
    }
    return { detected: false };
  });
}

// ─── Action input schema ───────────────────────────────────────────────────
// One discriminated tool with an `action` enum + optional fields. Each
// action ignores fields it doesn't need; required fields are validated
// inside runAction so we can give per-action error messages.
const ACTIONS = [
  // session
  "start", "attach", "newSession", "status", "close", "listProfiles",
  // navigation
  "navigate", "reload", "back", "forward",
  // snapshot
  "snapshot", "snapshotFrame", "listFrames", "ariaSnapshot", "screenshot", "pdf",
  // interact
  "click", "clickCoords", "clickVision", "fill", "type", "hover", "selectOption", "pressKey", "scroll", "drag",
  // content
  "getText", "getContent", "getLinks",
  // diagnostics
  "console", "pageErrors", "networkRequests",
  // network capture / intercept
  "captureResponses", "getCapturedResponses", "interceptNetwork", "clearInterceptions",
  // wait
  "waitFor", "waitForNavigation",
  // tabs
  "newTab", "switchTab", "listTabs", "closeTab",
  // cookies / storage
  "getCookies", "setCookie", "clearCookies", "getStorage", "setStorage", "clearStorage",
  // files
  "upload", "download", "listDownloads", "saveDownload",
  // viewport / dialog / highlight
  "resize", "highlight", "configureDialog", "handleDialog", "getLastDialog",
  // captcha
  "detectCaptcha",
  // misc
  "evaluate", "batch", "recoverStuck", "forceDisconnect", "traceStart", "traceStop",
] as const;

const inputSchema = z.object({
  action: z.enum(ACTIONS).describe("Browser action to run. See tool description for the catalogue."),
  url: z.string().optional().describe("URL for navigate / newTab / openPage."),
  selector: z.string().optional().describe("CSS selector OR a ref like 'e5' from a snapshot."),
  selector2: z.string().optional().describe("Second selector for drag (target)."),
  value: z.string().optional().describe("Text to fill/type or option value to select."),
  key: z.string().optional().describe("Keyboard key, e.g. 'Enter', 'Tab', 'ArrowDown'."),
  coords: z.object({ x: z.number(), y: z.number() }).optional().describe("Pixel coords for clickCoords."),
  instruction: z.string().optional().describe("Natural-language instruction for clickVision (e.g. 'click the I am not a robot checkbox')."),
  path: z.string().optional().describe("Output path for screenshot / pdf / saveDownload / traceStop."),
  filePath: z.string().optional().describe("Local file path for upload (comma-separated for multi-file)."),
  pattern: z.string().optional().describe("URL glob pattern for captureResponses / getCapturedResponses."),
  timeout: z.number().int().min(100).max(120_000).optional().describe("Timeout in ms (waitFor / evaluate / capture)."),
  fullPage: z.boolean().optional().describe("Full-page screenshot."),
  direction: z.string().optional().describe("Scroll direction: up | down | left | right OR a selector/ref."),
  amount: z.number().int().optional().describe("Pixel amount for directional scroll."),
  size: z.string().optional().describe("Viewport size, e.g. '1920x1080'."),
  profile: z.string().optional().describe("Profile name for start/newSession. Logins persist across runs per profile."),
  mode: z.enum(["persistent", "attach", "ephemeral"]).optional().describe("Engine mode. persistent = profile-on-disk; attach = connect to user's running Chrome via CDP; ephemeral = throwaway."),
  headless: z.boolean().optional().describe("Headless mode. Default false so the user can see what's happening."),
  cdpUrl: z.string().optional().describe("CDP endpoint for attach mode. Default http://localhost:9222."),
  stealth: z.boolean().optional().describe("Force stealth plugin (defeats most basic bot detection)."),
  cookie: z.record(z.unknown()).optional().describe("Cookie object for setCookie."),
  storage: z.object({
    kind: z.enum(["local", "session"]).default("local"),
    key: z.string().optional(),
    value: z.string().optional(),
  }).optional().describe("getStorage/setStorage/clearStorage payload."),
  intercept: z.object({
    block: z.array(z.string()).optional(),
    modify: z.array(z.object({
      match: z.string(),
      status: z.number().optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    })).optional(),
  }).optional().describe("Network interception config."),
  filter: z.string().optional().describe("Filter for console (all|log|warn|error) or networkRequests (URL substring)."),
  limit: z.number().int().optional().describe("Max number of entries to return."),
  domain: z.string().optional().describe("Cookie domain filter for getCookies."),
  frameSelector: z.string().optional().describe("iframe CSS selector for snapshotFrame."),
  interactive: z.boolean().optional(),
  compact: z.boolean().optional(),
  expression: z.string().optional().describe("JavaScript expression for evaluate."),
  targetId: z.string().optional().describe("Tab id like 't1' for switchTab/closeTab."),
  dialogAction: z.enum(["accept", "dismiss"]).optional(),
  dialogText: z.string().optional(),
  dialogMode: z.enum(["auto", "accept", "dismiss", "manual"]).optional(),
  actions: z.array(z.unknown()).optional().describe("Array of action objects for batch."),
  clear: z.boolean().optional().describe("Clear after read (pageErrors)."),
});

type ActionInput = z.infer<typeof inputSchema>;

// ─── Action handler ────────────────────────────────────────────────────────
async function runAction(input: ActionInput, deps: { cfg: ConfigManager; guard: FilesystemGuard; bus?: EventBus }, depth = 0): Promise<unknown> {
  const { cfg, guard } = deps;
  const a = input.action;

  switch (a) {
    case "start": {
      const opts: EngineOpts = { mode: input.mode ?? "persistent" };
      if (input.profile !== undefined) opts.profile = input.profile;
      if (input.headless !== undefined) opts.headless = input.headless;
      if (input.stealth !== undefined) opts.stealth = input.stealth;
      const page = await ensureBrowser(cfg, opts);
      return { ok: true, mode: currentMode, profile: currentProfileName, targetId: activeTargetId, url: page.url() };
    }

    case "attach": {
      const page = await ensureBrowser(cfg, {
        mode: "attach",
        cdpUrl: input.cdpUrl ?? "http://localhost:9222",
      });
      return { ok: true, mode: currentMode, attachedTo: input.cdpUrl ?? "http://localhost:9222", targetId: activeTargetId, url: page.url() };
    }

    case "newSession": {
      if (browser) {
        try { await (browser as PWBrowserContext).close(); } catch { /* ignore */ }
        cleanup();
      }
      const opts: EngineOpts = { mode: input.mode ?? "persistent", profile: input.profile ?? "default" };
      if (input.headless !== undefined) opts.headless = input.headless;
      if (input.stealth !== undefined) opts.stealth = input.stealth;
      const page = await ensureBrowser(cfg, opts);
      return { ok: true, mode: currentMode, profile: currentProfileName, targetId: activeTargetId, url: page.url() };
    }

    case "status": {
      if (!browser || !browserConnected) return { running: false };
      const state = pageStates.get(activeTargetId!);
      return {
        running: true,
        mode: currentMode,
        profile: currentProfileName,
        tabs: pages.size,
        active: activeTargetId,
        url: currentPage().url(),
        title: await currentPage().title().catch(() => null),
        requests: state?.networkRequests.length ?? 0,
        errors: state?.pageErrors.length ?? 0,
        routes: activeRoutes.size,
        downloads: downloads.size,
        trace: traceActive,
      };
    }

    case "close": {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (traceActive && browserContext) {
        await browserContext.tracing.stop({ path: join(tmpdir(), `daemora-trace-final-${Date.now()}.zip`) }).catch(() => { /* ignore */ });
        traceActive = false;
      }
      if (browser) {
        try { await (browser as PWBrowserContext).close(); } catch { /* ignore */ }
      }
      cleanup();
      return { ok: true, message: "Browser closed." };
    }

    case "listProfiles": {
      const profileDir = join(cfg.env.dataDir, "browser");
      if (!existsSync(profileDir)) return { profiles: [], active: null };
      const dirs = readdirSync(profileDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== "downloads")
        .map((d) => d.name);
      return { profiles: dirs, active: browserConnected ? currentProfileName : null };
    }

    case "navigate": {
      if (!input.url) throw new Error("url is required.");
      if (isBlockedUrl(input.url)) throw new Error(`Navigation to "${input.url}" is blocked (private network range). Localhost is allowed.`);
      const p = await ensureBrowser(cfg);
      await p.goto(input.url, { waitUntil: "domcontentloaded" });
      const captcha = await detectCaptchaOnPage(p);
      return { ok: true, url: input.url, title: await p.title(), tab: activeTargetId, captchaDetected: captcha.detected, captchaKind: captcha.kind };
    }

    case "reload": {
      const p = currentPage();
      await p.reload({ waitUntil: "domcontentloaded" });
      return { ok: true, title: await p.title(), url: p.url() };
    }

    case "back": {
      const p = currentPage();
      await p.goBack({ waitUntil: "domcontentloaded" });
      return { ok: true, url: p.url() };
    }

    case "forward": {
      const p = currentPage();
      await p.goForward({ waitUntil: "domcontentloaded" });
      return { ok: true, url: p.url() };
    }

    case "snapshot": {
      const p = await ensureBrowser(cfg);
      const opts: SnapshotOpts = {};
      if (input.interactive !== undefined) opts.interactive = input.interactive;
      if (input.compact !== undefined) opts.compact = input.compact;
      if (input.frameSelector) opts.frameSelector = input.frameSelector;
      const snap = await buildAccessibilitySnapshot(p, opts);
      return { count: snap.count, frame: opts.frameSelector ?? null, text: snap.text, hint: "Use refs like 'e5' in click/fill/type instead of CSS." };
    }

    case "snapshotFrame": {
      if (!input.frameSelector) throw new Error("frameSelector required.");
      const p = await ensureBrowser(cfg);
      const snapOpts: SnapshotOpts = { frameSelector: input.frameSelector };
      if (input.interactive !== undefined) snapOpts.interactive = input.interactive;
      if (input.compact !== undefined) snapOpts.compact = input.compact;
      const snap = await buildAccessibilitySnapshot(p, snapOpts);
      return { count: snap.count, frame: input.frameSelector, text: snap.text };
    }

    case "listFrames": {
      const p = currentPage();
      const frames = p.frames();
      if (frames.length <= 1) return { frames: [] };
      return {
        frames: frames.map((f, i) => ({ idx: i, name: f.name() || null, url: f.url() || "about:blank", main: f === p.mainFrame() })),
      };
    }

    case "ariaSnapshot": {
      const p = await ensureBrowser(cfg);
      const sel = input.selector ?? "body";
      try {
        const yaml = await p.locator(sel).ariaSnapshot();
        return { selector: sel, yaml };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("ariaSnapshot")) throw new Error("ariaSnapshot requires Playwright 1.49+. Update playwright.");
        throw e;
      }
    }

    case "screenshot": {
      const p = await ensureBrowser(cfg);
      const out = input.path ?? join(tmpdir(), `daemora-shot-${Date.now()}.png`);
      const canonical = guard.ensureAllowed(out, "write");
      const result = await normalizedScreenshot(p, {
        path: canonical,
        fullPage: input.fullPage ?? false,
        selector: input.selector ?? null,
      });
      return { ...result, sizeKB: Math.round(result.size / 1024) };
    }

    case "pdf": {
      const out = input.path ?? join(tmpdir(), `daemora-page-${Date.now()}.pdf`);
      const canonical = guard.ensureAllowed(out, "write");
      await currentPage().pdf({ path: canonical, format: "A4", printBackground: true });
      return { ok: true, path: canonical };
    }

    case "click": {
      if (!input.selector) throw new Error("selector or ref required.");
      const p = currentPage();
      const loc = await getLocator(p, input.selector);
      await loc.click();
      return { ok: true, selector: input.selector };
    }

    case "clickCoords": {
      if (!input.coords) throw new Error("coords {x, y} required.");
      const p = currentPage();
      await p.mouse.move(input.coords.x, input.coords.y, { steps: 10 });
      await p.mouse.click(input.coords.x, input.coords.y);
      return { ok: true, x: input.coords.x, y: input.coords.y };
    }

    case "clickVision": {
      if (!input.instruction) throw new Error("instruction required (e.g. 'click the login button').");
      const p = currentPage();
      const located = await visionLocateClick(cfg, p, input.instruction);
      await p.mouse.move(located.x, located.y, { steps: 10 });
      await p.mouse.click(located.x, located.y);
      return { ok: true, x: located.x, y: located.y, reasoning: located.reasoning };
    }

    case "fill": {
      if (!input.selector || input.value === undefined) throw new Error("selector and value required.");
      const loc = await getLocator(currentPage(), input.selector);
      await loc.fill(input.value);
      return { ok: true, selector: input.selector };
    }

    case "type": {
      if (!input.selector || input.value === undefined) throw new Error("selector and value required.");
      const p = currentPage();
      const loc = await getLocator(p, input.selector);
      await loc.click();
      await p.keyboard.type(input.value, { delay: 50 });
      return { ok: true, selector: input.selector, length: input.value.length };
    }

    case "hover": {
      if (!input.selector) throw new Error("selector required.");
      const loc = await getLocator(currentPage(), input.selector);
      await loc.hover();
      return { ok: true, selector: input.selector };
    }

    case "selectOption": {
      if (!input.selector || input.value === undefined) throw new Error("selector and value required.");
      const loc = await getLocator(currentPage(), input.selector);
      await loc.selectOption(input.value);
      return { ok: true, selector: input.selector, value: input.value };
    }

    case "pressKey": {
      if (!input.key) throw new Error("key required (e.g. 'Enter', 'Tab').");
      await currentPage().keyboard.press(input.key);
      return { ok: true, key: input.key };
    }

    case "scroll": {
      const p = currentPage();
      const direction = input.direction ?? "down";
      const amount = input.amount ?? 500;
      if (direction === "up") await p.evaluate((px) => window.scrollBy(0, -px), amount);
      else if (direction === "down") await p.evaluate((px) => window.scrollBy(0, px), amount);
      else if (direction === "left") await p.evaluate((px) => window.scrollBy(-px, 0), amount);
      else if (direction === "right") await p.evaluate((px) => window.scrollBy(px, 0), amount);
      else if (isRef(direction)) {
        const loc = await resolveRef(p, direction);
        await loc.scrollIntoViewIfNeeded();
      } else {
        await p.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, direction);
      }
      return { ok: true, direction, amount: ["up", "down", "left", "right"].includes(direction) ? amount : null };
    }

    case "drag": {
      if (!input.selector || !input.selector2) throw new Error("selector (source) and selector2 (target) required.");
      const p = currentPage();
      const src = await getLocator(p, input.selector);
      const tgt = await getLocator(p, input.selector2);
      await src.dragTo(tgt);
      return { ok: true, from: input.selector, to: input.selector2 };
    }

    case "getText": {
      const sel = input.selector ?? "body";
      const loc = await getLocator(currentPage(), sel);
      const text = (await loc.textContent()) ?? "";
      return { selector: sel, text: text.trim().slice(0, 10_000) };
    }

    case "getContent": {
      const sel = input.selector ?? "body";
      const html = await currentPage().evaluate((s) => {
        const el = s === "body" ? document.body : document.querySelector(s);
        return el ? el.innerHTML : null;
      }, sel);
      if (!html) return { selector: sel, html: null, error: "no element" };
      return { selector: sel, html: html.slice(0, 20_000) };
    }

    case "getLinks": {
      const links = await currentPage().evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 50)
          .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 80), href: (a as HTMLAnchorElement).href })));
      return { count: links.length, links };
    }

    case "console": {
      const state = pageStates.get(activeTargetId!);
      const logs = state?.consoleLogs ?? [];
      const filter = input.filter ?? "all";
      const limit = input.limit ?? 30;
      const filtered = filter === "all" ? logs : logs.filter((l) => l.type === filter);
      return {
        count: filtered.length,
        entries: filtered.slice(-limit).map((l) => ({
          time: new Date(l.ts).toISOString().slice(11, 19),
          type: l.type,
          text: l.text,
        })),
      };
    }

    case "pageErrors": {
      const state = pageStates.get(activeTargetId!);
      const errs = state?.pageErrors ?? [];
      const limit = input.limit ?? 20;
      const out = errs.slice(-limit).map((e) => ({
        time: new Date(e.ts).toISOString().slice(11, 19),
        name: e.name,
        message: e.message,
      }));
      if (input.clear && state) state.pageErrors.length = 0;
      return { count: out.length, errors: out };
    }

    case "networkRequests": {
      const state = pageStates.get(activeTargetId!);
      const reqs = state?.networkRequests ?? [];
      const filter = input.filter ?? null;
      const limit = input.limit ?? 30;
      const filtered = filter ? reqs.filter((r) => r.url.includes(filter)) : reqs;
      return {
        count: filtered.length,
        requests: filtered.slice(-limit).map((r) => ({
          time: new Date(r.ts).toISOString().slice(11, 19),
          id: r.id, method: r.method, url: r.url.slice(0, 240),
          status: r.status, ok: r.ok, failure: r.failureText,
        })),
      };
    }

    case "captureResponses": {
      if (!input.pattern) throw new Error("pattern required, e.g. '**/api/**'.");
      const timeout = input.timeout ?? 30_000;
      const id = `cap-${++captureCounter}`;
      const listener: ResponseListener = { pattern: input.pattern, results: [], resolve: null, timer: null };
      responseCaptureListeners.set(id, listener);
      return new Promise((resolve) => {
        listener.timer = setTimeout(() => {
          responseCaptureListeners.delete(id);
          resolve({ id, pattern: input.pattern, count: listener.results.length, results: listener.results });
        }, timeout);
        listener.resolve = (v: string) => resolve({ id, pattern: input.pattern, raw: v });
      });
    }

    case "getCapturedResponses": {
      if (!input.pattern) {
        return {
          captures: [...responseCaptureListeners.entries()].map(([id, l]) => ({ id, pattern: l.pattern, captured: l.results.length })),
        };
      }
      const id = input.pattern;
      const listener = responseCaptureListeners.get(id);
      if (!listener) throw new Error(`No capture with id "${id}".`);
      if (listener.timer) clearTimeout(listener.timer);
      responseCaptureListeners.delete(id);
      return { id, pattern: listener.pattern, count: listener.results.length, results: listener.results };
    }

    case "interceptNetwork": {
      if (!input.intercept) throw new Error("intercept config required.");
      const page = currentPage();
      let count = 0;
      if (input.intercept.block) {
        for (const pattern of input.intercept.block) {
          await page.route(pattern, (route) => route.abort());
          activeRoutes.set(pattern, "block");
          count++;
        }
      }
      if (input.intercept.modify) {
        for (const rule of input.intercept.modify) {
          const { match, headers, status, body } = rule;
          if (!match) continue;
          await page.route(match, async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              status: status ?? response.status(),
              headers: { ...response.headers(), ...(headers ?? {}) },
              body: body ?? (await response.body()),
            });
          });
          activeRoutes.set(match, "modify");
          count++;
        }
      }
      return { added: count, active: activeRoutes.size };
    }

    case "clearInterceptions": {
      const page = currentPage();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const count = activeRoutes.size;
      activeRoutes.clear();
      return { cleared: count };
    }

    case "waitFor": {
      if (!input.selector && !input.url && !input.expression && !input.value) {
        throw new Error("Need selector, url, expression, or value (for text:/load/networkidle).");
      }
      const p = currentPage();
      const timeout = input.timeout ?? 10_000;
      // Disambiguate by which field is set
      if (input.value === "load" || input.value === "networkidle") {
        await p.waitForLoadState(input.value, { timeout });
        return { ok: true, state: input.value };
      }
      if (input.expression) {
        await p.waitForFunction(input.expression, undefined, { timeout });
        return { ok: true, predicate: "satisfied" };
      }
      if (input.url) {
        await p.waitForURL(`**${input.url}**`, { timeout });
        return { ok: true, url: p.url() };
      }
      if (input.value) {
        const text = input.value;
        await p.waitForFunction((t: string) => document.body.innerText.includes(t), text, { timeout });
        return { ok: true, text };
      }
      await p.waitForSelector(input.selector!, { timeout });
      return { ok: true, selector: input.selector };
    }

    case "waitForNavigation": {
      const timeout = input.timeout ?? 30_000;
      await currentPage().waitForNavigation({ timeout });
      return { ok: true, url: currentPage().url() };
    }

    case "newTab": {
      if (!browserContext) await ensureBrowser(cfg);
      if (input.url && isBlockedUrl(input.url)) throw new Error(`URL "${input.url}" is blocked.`);
      const page = await browserContext!.newPage();
      page.setDefaultTimeout(15_000);
      const tid = genTargetId();
      pages.set(tid, page);
      attachPageListeners(tid, page);
      activeTargetId = tid;
      if (input.url) await page.goto(input.url, { waitUntil: "domcontentloaded" });
      return { ok: true, targetId: tid, url: input.url ?? "about:blank" };
    }

    case "switchTab": {
      if (!input.targetId) throw new Error("targetId required.");
      if (!pages.has(input.targetId)) throw new Error(`Tab "${input.targetId}" not found.`);
      activeTargetId = input.targetId;
      const page = pages.get(input.targetId)!;
      return { ok: true, targetId: input.targetId, url: page.url(), title: await page.title().catch(() => null) };
    }

    case "listTabs": {
      const tabs: { targetId: string; url: string; title: string | null; active: boolean; closed: boolean }[] = [];
      for (const [tid, page] of pages) {
        if (page.isClosed()) {
          tabs.push({ targetId: tid, url: "(closed)", title: null, active: tid === activeTargetId, closed: true });
          continue;
        }
        tabs.push({ targetId: tid, url: page.url(), title: await page.title().catch(() => null), active: tid === activeTargetId, closed: false });
      }
      return { tabs };
    }

    case "closeTab": {
      const tid = input.targetId ?? activeTargetId;
      if (!tid || !pages.has(tid)) throw new Error(`Tab "${tid ?? ""}" not found.`);
      await pages.get(tid)!.close();
      pages.delete(tid);
      pageStates.delete(tid);
      refCacheByTarget.delete(tid);
      if (activeTargetId === tid) activeTargetId = pages.size > 0 ? pages.keys().next().value! : null;
      return { ok: true, closed: tid, remaining: pages.size };
    }

    case "getCookies": {
      if (!browserContext) throw new Error("No browser open.");
      const cookies = await browserContext.cookies();
      const filtered = input.domain ? cookies.filter((c) => c.domain.includes(input.domain!)) : cookies;
      return { count: filtered.length, cookies: filtered.slice(0, 30) };
    }

    case "setCookie": {
      if (!input.cookie) throw new Error("cookie object required.");
      if (!browserContext) await ensureBrowser(cfg);
      await browserContext!.addCookies([input.cookie as Parameters<PWBrowserContext["addCookies"]>[0][number]]);
      return { ok: true };
    }

    case "clearCookies": {
      if (!browserContext) throw new Error("No browser open.");
      await browserContext.clearCookies();
      return { ok: true };
    }

    case "getStorage": {
      const kind = input.storage?.kind ?? "local";
      const key = input.storage?.key;
      const obj = kind === "session" ? "sessionStorage" : "localStorage";
      const result = await currentPage().evaluate(([o, k]: [string, string | undefined]) => {
        const s = (window as unknown as Record<string, Storage>)[o]!;
        if (k) return { [k]: s.getItem(k) };
        const all: Record<string, string | null> = {};
        for (let i = 0; i < s.length; i++) {
          const kk = s.key(i);
          if (kk !== null) all[kk] = s.getItem(kk);
        }
        return all;
      }, [obj, key] as [string, string | undefined]);
      return { kind, items: result };
    }

    case "setStorage": {
      if (!input.storage?.key || input.storage.value === undefined) throw new Error("storage.key and storage.value required.");
      const obj = input.storage.kind === "session" ? "sessionStorage" : "localStorage";
      await currentPage().evaluate(([o, k, v]: [string, string, string]) => {
        (window as unknown as Record<string, Storage>)[o]!.setItem(k, v);
      }, [obj, input.storage.key, input.storage.value] as [string, string, string]);
      return { ok: true };
    }

    case "clearStorage": {
      const obj = input.storage?.kind === "session" ? "sessionStorage" : "localStorage";
      await currentPage().evaluate((o: string) => {
        (window as unknown as Record<string, Storage>)[o]!.clear();
      }, obj);
      return { ok: true };
    }

    case "upload": {
      if (!input.selector || !input.filePath) throw new Error("selector and filePath required.");
      // Allow multiple files via comma; ensureAllowed each one
      const paths = input.filePath.includes(",")
        ? input.filePath.split(",").map((f) => guard.ensureAllowed(f.trim(), "read"))
        : guard.ensureAllowed(input.filePath, "read");
      const loc = await getLocator(currentPage(), input.selector);
      await loc.setInputFiles(paths);
      return { ok: true, files: Array.isArray(paths) ? paths : [paths] };
    }

    case "download": {
      if (!input.selector) throw new Error("selector to click for download required.");
      const page = currentPage();
      const downloadDir = join(cfg.env.dataDir, "browser", "downloads");
      mkdirSync(downloadDir, { recursive: true });
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        (await getLocator(page, input.selector)).click(),
      ]);
      const safeName = basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
      const dlPath = join(downloadDir, safeName);
      const canonical = guard.ensureAllowed(dlPath, "write");
      const tmpPath = canonical + `.tmp-${Date.now()}`;
      await download.saveAs(tmpPath);
      try { renameSync(tmpPath, canonical); } catch { /* keep tmp */ }
      return { ok: true, path: canonical, filename: safeName };
    }

    case "listDownloads": {
      return {
        count: downloads.size,
        downloads: [...downloads.values()].slice(-20).map((d) => ({
          id: d.id, filename: d.filename, status: d.status, path: d.path, url: d.url,
        })),
      };
    }

    case "saveDownload": {
      if (!input.targetId) throw new Error("targetId (downloadId) required.");
      const dl = downloads.get(input.targetId);
      if (!dl) throw new Error(`download "${input.targetId}" not found.`);
      if (!dl._download) throw new Error(`download "${input.targetId}" has no pending object.`);
      const out = input.path ?? join(cfg.env.dataDir, "browser", "downloads", dl.filename);
      const canonical = guard.ensureAllowed(out, "write");
      mkdirSync(join(canonical, ".."), { recursive: true });
      const tmpPath = canonical + `.tmp-${Date.now()}`;
      await dl._download.saveAs(tmpPath);
      try { renameSync(tmpPath, canonical); } catch { /* keep tmp */ }
      dl.path = canonical;
      dl.status = "saved";
      return { ok: true, path: canonical };
    }

    case "resize": {
      if (!input.size) throw new Error("size required, e.g. '1920x1080'.");
      const [w, h] = input.size.split("x").map(Number);
      if (!w || !h) throw new Error("size must be 'WIDTHxHEIGHT'.");
      await currentPage().setViewportSize({ width: w, height: h });
      return { ok: true, width: w, height: h };
    }

    case "highlight": {
      if (!input.selector) throw new Error("selector required.");
      const p = currentPage();
      if (isRef(input.selector)) {
        const loc = await resolveRef(p, input.selector);
        await loc.evaluate((el) => {
          const e = el as HTMLElement;
          e.style.outline = "3px solid red";
          e.style.outlineOffset = "2px";
          setTimeout(() => { e.style.outline = ""; e.style.outlineOffset = ""; }, 3000);
        });
      } else {
        await p.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            el.style.outline = "3px solid red";
            el.style.outlineOffset = "2px";
            setTimeout(() => { el.style.outline = ""; el.style.outlineOffset = ""; }, 3000);
          }
        }, input.selector);
      }
      return { ok: true };
    }

    case "configureDialog": {
      const m = input.dialogMode ?? "auto";
      dialogMode = m;
      pendingDialogs.length = 0;
      return { ok: true, mode: m };
    }

    case "handleDialog": {
      const action = input.dialogAction ?? "accept";
      const text = input.dialogText ?? "";
      if (dialogMode === "manual" && pendingDialogs.length > 0) {
        const dialog = pendingDialogs.shift()!;
        if (action === "accept") await dialog.accept(text);
        else await dialog.dismiss();
        return { ok: true, action, pending: pendingDialogs.length };
      }
      currentPage().once("dialog", async (dialog) => {
        if (action === "accept") await dialog.accept(text);
        else await dialog.dismiss();
      });
      return { ok: true, action, queued: true };
    }

    case "getLastDialog": return lastDialog ?? { message: "no dialog seen" };

    case "detectCaptcha": {
      const p = currentPage();
      return detectCaptchaOnPage(p);
    }

    case "evaluate": {
      if (!input.expression) throw new Error("expression required.");
      const result = await safeEvaluate(currentPage(), input.expression, input.timeout);
      return { result };
    }

    case "batch": {
      if (!input.actions) throw new Error("actions array required.");
      if (input.actions.length > 100) throw new Error("max 100 actions per batch.");
      if (depth >= 5) throw new Error("max batch nesting depth (5) exceeded.");
      const results: { action: string; ok: boolean; result?: unknown; error?: string }[] = [];
      for (const entry of input.actions) {
        const sub = inputSchema.safeParse(entry);
        if (!sub.success) { results.push({ action: "?", ok: false, error: sub.error.message }); break; }
        try {
          const r = await runAction(sub.data, deps, depth + 1);
          results.push({ action: sub.data.action, ok: true, result: r });
        } catch (e) {
          results.push({ action: sub.data.action, ok: false, error: e instanceof Error ? e.message : String(e) });
          break;
        }
      }
      return { total: input.actions.length, executed: results.length, results };
    }

    case "recoverStuck": {
      const p = currentPage();
      try {
        const client = await p.context().newCDPSession(p);
        await client.send("Runtime.terminateExecution");
        await client.detach();
        return { ok: true, recovered: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    case "forceDisconnect": {
      const p = currentPage();
      try {
        const client = await p.context().newCDPSession(p);
        await Promise.race([
          client.send("Runtime.terminateExecution"),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("CDP timed out")), 3000)),
        ]);
        await client.detach().catch(() => { /* ignore */ });
      } catch { /* CDP itself stuck */ }
      const url = p.url();
      try { await p.close({ runBeforeUnload: false }); } catch { /* may hang */ }
      pages.delete(activeTargetId!);
      pageStates.delete(activeTargetId!);
      refCacheByTarget.delete(activeTargetId!);
      const fresh = await browserContext!.newPage();
      fresh.setDefaultTimeout(15_000);
      const tid = genTargetId();
      pages.set(tid, fresh);
      attachPageListeners(tid, fresh);
      activeTargetId = tid;
      if (url && url !== "about:blank") {
        try { await fresh.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch { /* best effort */ }
      }
      return { ok: true, newTab: tid, url };
    }

    case "traceStart": {
      if (!browserContext) throw new Error("No browser open.");
      if (traceActive) throw new Error("Trace already running.");
      await browserContext.tracing.start({ screenshots: true, snapshots: true, sources: false });
      traceActive = true;
      return { ok: true };
    }

    case "traceStop": {
      if (!browserContext || !traceActive) throw new Error("No trace running.");
      const out = input.path ?? join(tmpdir(), `daemora-trace-${Date.now()}.zip`);
      const canonical = guard.ensureAllowed(out, "write");
      const tmpPath = canonical + `.tmp-${Date.now()}`;
      await browserContext.tracing.stop({ path: tmpPath });
      try { renameSync(tmpPath, canonical); } catch { /* keep tmp */ }
      traceActive = false;
      return { ok: true, path: canonical, hint: `npx playwright show-trace ${canonical}` };
    }

    default: {
      const unreachable: never = a;
      throw new Error(`Unknown action: ${unreachable as string}`);
    }
  }
}

// ─── Tool factory ──────────────────────────────────────────────────────────
export interface BrowserToolDeps {
  readonly cfg: ConfigManager;
  readonly guard: FilesystemGuard;
  readonly bus?: EventBus;
}

export function makeBrowserTool(deps: BrowserToolDeps): ToolDef<typeof inputSchema, unknown> {
  const description =
    "Heavy Playwright browser control. One tool, ~60 actions. Modes: persistent (profile dir, default), attach (CDP to user's running Chrome on :9222 — no login needed), ephemeral (incognito). " +
    "Workflow: start({mode,profile}) → navigate(url) → snapshot (returns refs e1,e2,...) → click/fill/type using refs (NOT raw CSS). " +
    "Captcha policy: stealth + warm profile handles 95%. If detectCaptcha returns true OR a click fails on a hidden anti-bot widget, fall back to clickVision({instruction:'click the I am not a robot checkbox'}) — it screenshots, asks the vision LLM for coords, and clicks the pixel. " +
    "Login flow: persistent mode keeps cookies across runs — user logs in once per profile. For 2FA sites, pause via reply_to_user and let the human enter the code in the visible window. " +
    "Always close() when done so the profile saves cleanly. forceDisconnect/recoverStuck for hung pages. batch for chains of >2 actions on the same page.";

  return {
    name: "browser",
    description,
    category: "browser",
    source: { kind: "core" },
    alwaysOn: false,
    tags: ["browser", "playwright", "scrape", "automation", "login", "form", "click", "screenshot", "stealth", "captcha", "vision"],
    inputSchema,
    async execute(input, ctx) {
      try {
        const out = await runAction(input, deps);
        return out;
      } catch (e) {
        ctx.logger.warn("browser action failed", { action: input.action, error: e instanceof Error ? e.message : String(e) });
        return { ok: false, error: toAIFriendlyError(e), action: input.action };
      }
    },
  };
}


