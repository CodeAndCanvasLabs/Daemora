/**
 * Zoom platform handler (browser-based).
 *
 * Limited — Zoom's web client requires "Join from Browser" to be enabled by host.
 * Many Zoom meetings won't support this. For full Zoom support, SDK integration is needed.
 */

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const SELECTORS = {
  browserLink: [
    'a:has-text("Join from Your Browser")',
    'a:has-text("Join from browser")',
    'a:has-text("join from your browser")',
  ],
  nameInput: [
    '#inputname',
    '[placeholder*="name" i]',
    'input[name="name"]',
  ],
  joinButton: [
    '[id*="joinBtn"]',
    'button:has-text("Join")',
    'button[class*="join" i]',
  ],
  leaveButton: [
    'button[aria-label*="Leave" i]',
    'button:has-text("Leave")',
    'button:has-text("End")',
  ],
};

export async function joinZoom(page, session) {
  const { meetingUrl, displayName } = session;

  // Convert zoom.us/j/xxx to web client URL
  let url = meetingUrl;
  if (url.includes("zoom.us/j/")) {
    const meetingId = url.match(/\/j\/(\d+)/)?.[1];
    if (meetingId) url = `https://app.zoom.us/wc/join/${meetingId}`;
  }

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.bringToFront();
  await _wait(3000);

  console.log(`[Zoom:Join] Page URL: ${page.url()}`);

  // Click "Join from Your Browser" if present
  for (const sel of SELECTORS.browserLink) {
    try {
      const link = await page.$(sel);
      if (link) {
        await link.click();
        console.log("[Zoom:Join] Clicked 'Join from Browser'");
        await _wait(3000);
        break;
      }
    } catch {}
  }

  // Fill display name
  for (const sel of SELECTORS.nameInput) {
    try {
      const input = await page.$(sel);
      if (input) {
        await input.fill(displayName);
        console.log(`[Zoom:Join] Name: ${displayName}`);
        break;
      }
    } catch {}
  }
  await _wait(500);

  // Click Join
  let clicked = false;
  for (const sel of SELECTORS.joinButton) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log("[Zoom:Join] Clicked Join");
        clicked = true;
        break;
      }
    } catch {}
  }

  await _wait(5000);
  return clicked ? "join-attempted" : "no-join-button";
}

export async function leaveZoom(page) {
  for (const sel of SELECTORS.leaveButton) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await _wait(1000);
        return "left";
      }
    } catch {}
  }
  return "left";
}

export function startRemovalMonitor(page, onRemoval) {
  const intervalId = setInterval(async () => {
    try {
      const bodyText = await page.textContent("body").catch(() => "");
      if (bodyText.toLowerCase().includes("meeting has ended") ||
          bodyText.toLowerCase().includes("host ended")) {
        clearInterval(intervalId);
        onRemoval("removed");
      }
    } catch {
      clearInterval(intervalId);
    }
  }, 2000);
  return () => clearInterval(intervalId);
}
