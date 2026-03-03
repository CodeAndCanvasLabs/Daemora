/**
 * Browser Automation - Playwright-based web interaction.
 * Upgraded: multi-tab, navigation guard, dialog handling, waitFor, cookies.
 */

let browser = null;
let browserContext = null;
const pages = []; // Multi-tab support

// Blocked navigation patterns - SSRF / security guard
const NAV_BLOCKLIST = [
  /^file:\/\//i,
  /^(http:\/\/|https:\/\/)(127\.|0\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/,
  /^(http:\/\/|https:\/\/)localhost/i,
];

function isBlockedUrl(url) {
  return NAV_BLOCKLIST.some((pattern) => pattern.test(url));
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) {
    if (pages.length === 0 || pages[0].isClosed()) {
      pages[0] = await browserContext.newPage();
      pages[0].setDefaultTimeout(15000);
    }
    return pages[0];
  }

  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      viewport: { width: 1280, height: 720 },
    });

    // Auto-handle dialogs (accept by default)
    browserContext.on("dialog", async (dialog) => {
      console.log(`      [browser] Auto-dismissed dialog: ${dialog.type()} - "${dialog.message().slice(0, 80)}"`);
      await dialog.dismiss();
    });

    const page = await browserContext.newPage();
    page.setDefaultTimeout(15000);
    pages.push(page);
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
  return activePage;
}

export async function browserAction(action, param1, param2) {
  console.log(`      [browser] ${action}: ${param1 || ""}`);

  try {
    switch (action) {
      case "navigate":
      case "openPage": {
        if (!param1) return "Error: URL is required.";
        if (isBlockedUrl(param1)) return `Error: Navigation to "${param1}" is blocked for security (private/local addresses not allowed).`;
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

      case "getText": {
        const selector = param1 || "body";
        const text = await currentPage().textContent(selector);
        const trimmed = (text || "").trim().slice(0, 10000);
        return trimmed || "(empty)";
      }

      case "screenshot": {
        const p = await ensureBrowser();
        const path = param1 || `/tmp/screenshot-${Date.now()}.png`;
        await p.screenshot({ path, fullPage: param2 === "full" });
        return `Screenshot saved to: ${path}`;
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
        // Bring to focus (Playwright doesn't have focus concept, but we track active)
        pages.push(pages.splice(idx, 1)[0]); // Move selected to end (= current)
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
        const idx = parseInt(param1 || `${pages.length - 1}`);
        if (idx < 0 || idx >= pages.length) return `Error: Tab index ${idx} out of range.`;
        await pages[idx].close();
        pages.splice(idx, 1);
        return `Closed tab ${idx}. Open tabs: ${pages.length}`;
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
        // Override default dismiss behavior for next dialog
        const action = param1 || "accept"; // accept | dismiss
        const text = param2 || "";
        currentPage().once("dialog", async (dialog) => {
          if (action === "accept") await dialog.accept(text);
          else await dialog.dismiss();
        });
        return `Next dialog will be ${action}ed${text ? ` with text: "${text}"` : ""}.`;
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
        if (!param1) return "Error: cookie JSON is required (e.g., {\"name\":\"token\",\"value\":\"abc\",\"domain\":\"example.com\"}).";
        if (!browserContext) await ensureBrowser();
        const cookie = JSON.parse(param1);
        await browserContext.addCookies([cookie]);
        return `Cookie "${cookie.name}" set.`;
      }

      case "close": {
        if (browser) {
          await browser.close();
          browser = null;
          browserContext = null;
          pages.length = 0;
        }
        return "Browser closed.";
      }

      default:
        return `Unknown action: "${action}". Available: navigate, click, fill, getText, screenshot, evaluate, getLinks, newTab, switchTab, listTabs, closeTab, waitFor, handleDialog, getCookies, setCookie, close`;
    }
  } catch (error) {
    console.log(`      [browser] Error: ${error.message}`);
    return `Browser error: ${error.message}`;
  }
}

export const browserActionDescription =
  'browserAction(action: string, param1?: string, param2?: string) - Browser automation via Playwright. Actions: navigate(url), click(selector), fill(selector,value), getText(selector), screenshot(path,full?), evaluate(js), getLinks, newTab(url?), switchTab(index), listTabs, closeTab(index), waitFor(selector,timeoutMs?), handleDialog(accept|dismiss,text?), getCookies(domain?), setCookie(json), close.';
