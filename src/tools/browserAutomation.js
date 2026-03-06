/**
 * Browser Automation - Playwright-based web interaction.
 * Features: multi-tab, session persistence, localhost access, PDF generation,
 * type/hover/scroll/pressKey/selectOption/getContent/waitForNavigation/reload/goBack/goForward.
 */

import { join } from "path";
import { mkdirSync } from "fs";
import { config } from "../config/default.js";

let browser = null;
let browserContext = null;
const pages = []; // Multi-tab support
let inactivityTimer = null;
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// Navigation guard — allow localhost, block private network ranges (configurable)
const NAV_BLOCKLIST = [
  /^file:\/\//i,
  // Block private ranges (not localhost)
  /^(https?:\/\/)(10\.\d+\.\d+\.\d+)/,
  /^(https?:\/\/)(172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+)/,
  /^(https?:\/\/)(192\.168\.\d+\.\d+)/,
  /^(https?:\/\/)(169\.254\.\d+\.\d+)/,
];

function isBlockedUrl(url) {
  return NAV_BLOCKLIST.some((pattern) => pattern.test(url));
}

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(async () => {
    if (browser) {
      console.log("[browser] Closing browser due to inactivity (5 min)");
      await browser.close().catch(() => {});
      browser = null;
      browserContext = null;
      pages.length = 0;
    }
  }, INACTIVITY_TIMEOUT);
}

async function ensureBrowser(profileName = "default") {
  resetInactivityTimer();

  if (browser && browser.isConnected()) {
    if (pages.length === 0 || pages[0].isClosed()) {
      pages[0] = await browserContext.newPage();
      pages[0].setDefaultTimeout(15000);
    }
    return pages[0];
  }

  try {
    const { chromium } = await import("playwright");

    // User data directory for cookie/auth persistence across tasks
    const userDataDir = join(config.dataDir, "browser", profileName);
    mkdirSync(userDataDir, { recursive: true });

    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    browserContext = browser;

    // Auto-handle dialogs (accept by default)
    browserContext.on("dialog", async (dialog) => {
      console.log(`      [browser] Auto-dismissed dialog: ${dialog.type()} - "${dialog.message().slice(0, 80)}"`);
      await dialog.dismiss();
    });

    // Use existing page or create one
    const existingPages = browserContext.pages();
    if (existingPages.length > 0) {
      existingPages[0].setDefaultTimeout(15000);
      pages.push(existingPages[0]);
    } else {
      const page = await browserContext.newPage();
      page.setDefaultTimeout(15000);
      pages.push(page);
    }
    return pages[0];
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" || error.message.includes("playwright")) {
      throw new Error("Playwright not installed. Run: pnpm add playwright && npx playwright install chromium");
    }
    throw error;
  }
}

function currentPage() {
  if (pages.length === 0) throw new Error("No browser open. Use navigate first.");
  const activePage = pages[pages.length - 1];
  if (activePage.isClosed()) throw new Error("Current page is closed. Navigate to a URL first.");
  resetInactivityTimer();
  return activePage;
}

function wrapError(error) {
  const msg = error.message;
  if (msg.includes("Timeout") && msg.includes("waiting for selector")) {
    return `Element not found within timeout. Check the selector is correct and the element is visible. Error: ${msg}`;
  }
  if (msg.includes("Target closed") || msg.includes("Target page, context or browser has been closed")) {
    return `Browser/page was closed. Use navigate to open a new page first. Error: ${msg}`;
  }
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) {
    return `Connection refused. Is the server running? Error: ${msg}`;
  }
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) {
    return `DNS resolution failed. Check the URL is correct. Error: ${msg}`;
  }
  return `Browser error: ${msg}`;
}

export async function browserAction(action, param1, param2) {
  console.log(`      [browser] ${action}: ${param1 || ""}`);

  try {
    switch (action) {
      case "navigate":
      case "openPage": {
        if (!param1) return "Error: URL is required.";
        if (isBlockedUrl(param1)) return `Error: Navigation to "${param1}" is blocked (private network range). Localhost is allowed.`;
        const p = await ensureBrowser();
        await p.goto(param1, { waitUntil: "domcontentloaded" });
        const title = await p.title();
        return `Navigated to: ${param1}\nTitle: ${title}`;
      }

      case "click": {
        if (!param1) return "Error: selector is required.";
        await currentPage().click(param1);
        return `Clicked: ${param1}`;
      }

      case "fill": {
        if (!param1 || param2 === undefined) return "Error: selector and value are required.";
        await currentPage().fill(param1, param2);
        return `Filled "${param1}" with "${param2}"`;
      }

      case "type": {
        if (!param1 || param2 === undefined) return "Error: selector and text are required.";
        await currentPage().click(param1);
        await currentPage().keyboard.type(param2, { delay: 50 });
        return `Typed "${param2}" into "${param1}" (keystroke-by-keystroke)`;
      }

      case "hover": {
        if (!param1) return "Error: selector is required.";
        await currentPage().hover(param1);
        return `Hovered over: ${param1}`;
      }

      case "selectOption": {
        if (!param1 || param2 === undefined) return "Error: selector and value are required.";
        await currentPage().selectOption(param1, param2);
        return `Selected option "${param2}" in "${param1}"`;
      }

      case "pressKey": {
        if (!param1) return "Error: key is required (e.g., Enter, Tab, Escape, ArrowDown).";
        await currentPage().keyboard.press(param1);
        return `Pressed key: ${param1}`;
      }

      case "scroll": {
        const direction = param1 || "down";
        const amount = parseInt(param2 || "500");
        if (direction === "up") {
          await currentPage().evaluate((px) => window.scrollBy(0, -px), amount);
        } else if (direction === "down") {
          await currentPage().evaluate((px) => window.scrollBy(0, px), amount);
        } else {
          // Scroll to element
          await currentPage().evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          }, direction);
        }
        return `Scrolled ${direction}${amount ? ` ${amount}px` : ""}`;
      }

      case "getText": {
        const selector = param1 || "body";
        const text = await currentPage().textContent(selector);
        const trimmed = (text || "").trim().slice(0, 10000);
        return trimmed || "(empty)";
      }

      case "getContent": {
        const selector = param1 || "body";
        const html = await currentPage().evaluate((sel) => {
          const el = sel === "body" ? document.body : document.querySelector(sel);
          return el ? el.innerHTML : null;
        }, selector);
        if (!html) return `No element found for selector: ${selector}`;
        return html.slice(0, 20000);
      }

      case "screenshot": {
        const p = await ensureBrowser();
        const path = param1 || `/tmp/screenshot-${Date.now()}.png`;
        await p.screenshot({ path, fullPage: param2 === "full" });
        return `Screenshot saved to: ${path}`;
      }

      case "pdf": {
        const p = currentPage();
        const path = param1 || `/tmp/page-${Date.now()}.pdf`;
        await p.pdf({ path, format: "A4", printBackground: true });
        return `PDF saved to: ${path}`;
      }

      case "evaluate": {
        if (!param1) return "Error: JavaScript expression is required.";
        const result = await currentPage().evaluate(param1);
        return JSON.stringify(result, null, 2);
      }

      case "getLinks": {
        const links = await currentPage().evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .slice(0, 50)
            .map((a) => ({ text: a.textContent.trim().slice(0, 80), href: a.href }))
        );
        return links.map((l) => `${l.text} → ${l.href}`).join("\n") || "(no links found)";
      }

      case "reload": {
        await currentPage().reload({ waitUntil: "domcontentloaded" });
        const title = await currentPage().title();
        return `Reloaded page. Title: ${title}`;
      }

      case "goBack": {
        await currentPage().goBack({ waitUntil: "domcontentloaded" });
        const title = await currentPage().title();
        const url = currentPage().url();
        return `Navigated back. Now at: ${url} (${title})`;
      }

      case "goForward": {
        await currentPage().goForward({ waitUntil: "domcontentloaded" });
        const title = await currentPage().title();
        const url = currentPage().url();
        return `Navigated forward. Now at: ${url} (${title})`;
      }

      case "waitForNavigation": {
        const timeout = param1 ? parseInt(param1) : 30000;
        await currentPage().waitForNavigation({ timeout });
        const url = currentPage().url();
        return `Navigation complete. Now at: ${url}`;
      }

      // Multi-tab support
      case "newTab": {
        const url = param1;
        if (url && isBlockedUrl(url)) return `Error: Navigation to "${url}" is blocked.`;
        if (!browserContext) await ensureBrowser();
        const newPage = await browserContext.newPage();
        newPage.setDefaultTimeout(15000);
        pages.push(newPage);
        if (url) {
          await newPage.goto(url, { waitUntil: "domcontentloaded" });
          return `Opened new tab (${pages.length - 1}) at: ${url}`;
        }
        return `Opened new blank tab (index: ${pages.length - 1})`;
      }

      case "switchTab": {
        const idx = parseInt(param1 || "0");
        if (isNaN(idx) || idx < 0 || idx >= pages.length) {
          return `Error: Tab index ${idx} out of range. Open tabs: 0–${pages.length - 1}`;
        }
        pages.push(pages.splice(idx, 1)[0]);
        return `Switched to tab ${idx} (now active)`;
      }

      case "listTabs": {
        if (pages.length === 0) return "No open tabs.";
        const titles = await Promise.all(
          pages.map(async (p, i) => {
            if (p.isClosed()) return `  ${i}: [closed]`;
            const title = await p.title().catch(() => "?");
            const url = p.url();
            return `  ${i}${i === pages.length - 1 ? " (active)" : ""}: ${title} - ${url}`;
          })
        );
        return `Open tabs (${pages.length}):\n${titles.join("\n")}`;
      }

      case "closeTab": {
        const closeIdx = parseInt(param1 || `${pages.length - 1}`);
        if (closeIdx < 0 || closeIdx >= pages.length) return `Error: Tab index ${closeIdx} out of range.`;
        await pages[closeIdx].close();
        pages.splice(closeIdx, 1);
        return `Closed tab ${closeIdx}. Open tabs: ${pages.length}`;
      }

      // Waiting
      case "waitFor": {
        if (!param1) return "Error: selector is required.";
        const timeout = param2 ? parseInt(param2) : 10000;
        await currentPage().waitForSelector(param1, { timeout });
        return `Element "${param1}" found.`;
      }

      // Dialog handling
      case "handleDialog": {
        const dialogAction = param1 || "accept";
        const text = param2 || "";
        currentPage().once("dialog", async (dialog) => {
          if (dialogAction === "accept") await dialog.accept(text);
          else await dialog.dismiss();
        });
        return `Next dialog will be ${dialogAction}ed${text ? ` with text: "${text}"` : ""}.`;
      }

      // Cookies
      case "getCookies": {
        if (!browserContext) return "No browser open.";
        const cookies = await browserContext.cookies();
        const filtered = param1
          ? cookies.filter((c) => c.domain.includes(param1))
          : cookies;
        return JSON.stringify(filtered.slice(0, 20), null, 2);
      }

      case "setCookie": {
        if (!param1) return 'Error: cookie JSON is required (e.g., {"name":"token","value":"abc","domain":"example.com"}).';
        if (!browserContext) await ensureBrowser();
        const cookie = JSON.parse(param1);
        await browserContext.addCookies([cookie]);
        return `Cookie "${cookie.name}" set.`;
      }

      // Session management
      case "newSession": {
        // Close existing browser and start fresh with optional profile
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
          browserContext = null;
          pages.length = 0;
        }
        const profile = param1 || "default";
        await ensureBrowser(profile);
        return `New browser session started (profile: ${profile}). Cookies/auth from previous sessions in this profile are preserved.`;
      }

      case "close": {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (browser) {
          await browser.close();
          browser = null;
          browserContext = null;
          pages.length = 0;
        }
        return "Browser closed.";
      }

      default:
        return `Unknown action: "${action}". Available: navigate, click, fill, type, hover, selectOption, pressKey, scroll, getText, getContent, screenshot, pdf, evaluate, getLinks, reload, goBack, goForward, waitForNavigation, newTab, switchTab, listTabs, closeTab, waitFor, handleDialog, getCookies, setCookie, newSession, close`;
    }
  } catch (error) {
    console.log(`      [browser] Error: ${error.message}`);
    return wrapError(error);
  }
}

export const browserActionDescription =
  'browserAction(action: string, param1?: string, param2?: string) - Browser automation via Playwright. Actions: navigate(url), click(selector), fill(selector,value), type(selector,text), hover(selector), selectOption(selector,value), pressKey(key), scroll(direction|selector,amount?), getText(selector?), getContent(selector?), screenshot(path?,full?), pdf(path?), evaluate(js), getLinks, reload, goBack, goForward, waitForNavigation(timeout?), newTab(url?), switchTab(index), listTabs, closeTab(index?), waitFor(selector,timeoutMs?), handleDialog(accept|dismiss,text?), getCookies(domain?), setCookie(json), newSession(profile?), close.';
