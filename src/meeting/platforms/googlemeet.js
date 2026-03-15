/**
 * Google Meet platform handler.
 *
 * Based on Vexa's googlemeet/ directory — exact selectors and flow.
 * Join → admission wait → removal monitoring → leave.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { config } from "../../config/default.js";

// ── Selectors (from Vexa's selectors.ts) ─────────────────────────────────

const SELECTORS = {
  nameInput: [
    'input[type="text"][aria-label="Your name"]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
  ],
  joinButton: [
    '//button[.//span[text()="Ask to join"]]',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Join")',
  ],
  cameraOff: [
    '[aria-label*="Turn off camera" i]',
    'button[aria-label*="Turn off camera" i]',
    'button[aria-label*="camera" i][data-is-muted="false"]',
  ],
  micOff: [
    '[aria-label*="Turn off microphone" i]',
    'button[aria-label*="Turn off microphone" i]',
  ],
  leaveButton: [
    '[aria-label*="Leave call" i]',
    '[aria-label*="Leave meeting" i]',
    'button[aria-label*="Leave" i]',
    '[data-tooltip*="Leave" i]',
  ],
  admissionIndicators: [
    'button[aria-label*="Chat" i]',
    'button[aria-label*="People" i]',
    'button[aria-label*="Leave call" i]',
    'button[aria-label*="Leave meeting" i]',
    '[role="toolbar"]',
    '[aria-label*="microphone" i]',
  ],
  waitingRoomIndicators: [
    'text="Asking to be let in..."',
    "text=\"You'll join the call when someone lets you in\"",
    'text="Please wait until a meeting host brings you into the call"',
    'text="Waiting for the host to let you in"',
  ],
  rejectionPatterns: [
    "can't join", "cannot join", "meeting not found", "unable to join",
    "access denied", "meeting has ended", "invalid meeting", "link expired",
    "you were removed",
  ],
  removalIndicators: [
    "you were removed", "meeting ended", "you've been removed",
    "the meeting has ended", "call ended",
  ],
};

/**
 * Browser-side speaker detection script.
 * Google Meet adds CSS classes to participant tiles when they speak.
 * MutationObserver watches for these classes and reports active speaker.
 * Calls window.__daemoraSpeakerChanged(name) when speaker changes.
 */
export const SPEAKER_DETECTION_SCRIPT = `
(function() {
  if (window.__daemoraSpeakerDetectionActive) return "already-active";
  window.__daemoraSpeakerDetectionActive = true;

  // Google Meet speaking CSS classes (from Vexa's selectors.ts)
  const SPEAKING_CLASSES = ['Oaajhc', 'HX2H7', 'wEsLMd', 'OgVli'];

  // Name selectors for participant tiles
  const NAME_SELECTORS = [
    '[data-self-name]',
    '.zWGUib',    // participant name in tile
    '.cS7aqe',   // name text
    '.XEazBc',   // alternative name class
    '.ZjFb7c',   // another name variant
  ];

  let lastSpeaker = null;

  function findSpeakerName(element) {
    // Walk up from the element with the speaking class to find the participant container
    let container = element;
    for (let i = 0; i < 10; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;

      // Check for name within this container
      for (const sel of NAME_SELECTORS) {
        const nameEl = container.querySelector(sel);
        if (nameEl) {
          const name = nameEl.getAttribute('data-self-name') || nameEl.textContent?.trim();
          if (name && name.length > 0 && name.length < 80) return name;
        }
      }

      // Check aria-label on the container itself
      const ariaLabel = container.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 80) return ariaLabel;
    }
    return null;
  }

  // Check all participant tiles for speaking classes
  function checkSpeakers() {
    for (const className of SPEAKING_CLASSES) {
      const elements = document.querySelectorAll('.' + className);
      for (const el of elements) {
        const name = findSpeakerName(el);
        if (name && name !== lastSpeaker) {
          lastSpeaker = name;
          if (window.__daemoraSpeakerChanged) {
            window.__daemoraSpeakerChanged(name);
          }
        }
      }
    }
  }

  // MutationObserver on the meeting container
  const observer = new MutationObserver(() => checkSpeakers());
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    subtree: true,
  });

  // Also poll every 2 seconds as fallback
  setInterval(checkSpeakers, 2000);

  window.__daemoraSpeakerObserver = observer;
  console.log("[Daemora:Speaker] Speaker detection started");
  return "speaker-detection-started";
})();
`;

export const SPEAKER_DETECTION_STOP_SCRIPT = `
(function() {
  if (window.__daemoraSpeakerObserver) {
    window.__daemoraSpeakerObserver.disconnect();
    window.__daemoraSpeakerObserver = null;
  }
  window.__daemoraSpeakerDetectionActive = false;
  return "speaker-detection-stopped";
})();
`;

const debugDir = join(config.dataDir, "meetings");

function _screenshot(page, name) {
  mkdirSync(debugDir, { recursive: true });
  return page.screenshot({ path: join(debugDir, `debug-${name}-${Date.now()}.png`) }).catch(() => {});
}

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Join ─────────────────────────────────────────────────────────────────

/**
 * Join a Google Meet meeting.
 * @param {import('playwright').Page} page
 * @param {object} session — { meetingUrl, displayName }
 * @returns {Promise<string>} status
 */
export async function joinGoogleMeet(page, session) {
  const { meetingUrl, displayName } = session;

  // Strip authuser param (causes redirect to sign-in)
  const cleanUrl = meetingUrl.replace(/[?&]authuser=\d+/, "").replace(/\?$/, "");

  // Navigate with networkidle (Vexa pattern)
  await page.goto(cleanUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.bringToFront();
  await _screenshot(page, "0-navigate");

  // 5-second settle time (Vexa pattern)
  await _wait(5000);

  const currentUrl = page.url();
  console.log(`[Meet:Join] Page URL: ${currentUrl}`);

  // Check sign-in redirect
  if (currentUrl.includes("accounts.google.com")) {
    console.log("[Meet:Join] Redirected to Google sign-in");
    return "auth-required";
  }

  // Dismiss popups/overlays ("Got it", "Sign in with Google", cookie consent, etc.)
  const dismissSelectors = [
    'button:has-text("Got it")',
    'button:has-text("Dismiss")',
    'button:has-text("OK")',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    '[aria-label="Close"]',
    '[aria-label="Dismiss"]',
  ];
  for (const sel of dismissSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log(`[Meet:Join] Dismissed popup: ${sel}`);
        await _wait(500);
      }
    } catch {}
  }
  await _wait(1000);

  // Check rejection FIRST (Vexa pattern — check before anything else)
  const bodyText = await page.textContent("body").catch(() => "");
  const isRejected = SELECTORS.rejectionPatterns.some(p => bodyText.toLowerCase().includes(p));
  if (isRejected) {
    console.log("[Meet:Join] REJECTED by Google Meet");
    await _screenshot(page, "rejected");
    return "rejected";
  }

  // Fill display name (120s timeout — Vexa uses 120s)
  for (const sel of SELECTORS.nameInput) {
    try {
      const input = await page.waitForSelector(sel, { timeout: 15000 });
      if (input) {
        await input.fill(displayName);
        console.log(`[Meet:Join] Name: ${displayName}`);
        break;
      }
    } catch {}
  }
  await _wait(1000);

  // Turn off camera
  for (const sel of SELECTORS.cameraOff) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log("[Meet:Join] Camera off"); break; }
    } catch {}
  }
  await _wait(500);

  // Turn off microphone
  for (const sel of SELECTORS.micOff) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log("[Meet:Join] Mic off"); break; }
    } catch {}
  }
  await _wait(500);

  // Click join button
  let clicked = false;
  for (const sel of SELECTORS.joinButton) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 5000 });
      if (btn) {
        const text = await btn.textContent().catch(() => "join");
        await btn.click();
        console.log(`[Meet:Join] Clicked: "${text.trim()}"`);
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    console.log("[Meet:Join] No join button found");
    await _screenshot(page, "no-join-button");
    return "no-join-button";
  }

  await _wait(8000);
  await _screenshot(page, "1-post-join");

  // Wait for admission (Vexa pattern — require ≥2 indicators)
  return await waitForAdmission(page);
}

// ── Admission ────────────────────────────────────────────────────────────

/**
 * Wait for bot to be admitted to meeting.
 * Vexa pattern: require ≥2 admission indicators, poll every 2s, timeout 2min.
 */
async function waitForAdmission(page, timeoutMs = 120000) {
  const startTime = Date.now();

  // Quick check — already admitted?
  const quickResult = await checkAdmitted(page);
  if (quickResult === "admitted") {
    console.log("[Meet:Admission] Already in meeting");
    return "joined";
  }

  // Check for waiting room
  const bodyText = await page.textContent("body").catch(() => "");
  const inWaitingRoom = SELECTORS.waitingRoomIndicators.some(indicator => {
    const text = indicator.replace(/^text="/, "").replace(/"$/, "");
    return bodyText.includes(text);
  });

  if (inWaitingRoom) {
    console.log("[Meet:Admission] In waiting room — polling for admission...");
  }

  // Poll every 2s (Vexa pattern)
  while (Date.now() - startTime < timeoutMs) {
    await _wait(2000);

    // Check rejection
    const currentText = await page.textContent("body").catch(() => "");
    if (SELECTORS.rejectionPatterns.some(p => currentText.toLowerCase().includes(p))) {
      console.log("[Meet:Admission] Rejected by host");
      return "rejected";
    }

    // Check admitted (≥2 indicators)
    const result = await checkAdmitted(page);
    if (result === "admitted") {
      console.log("[Meet:Admission] Admitted to meeting");
      return "joined";
    }
  }

  console.log("[Meet:Admission] Timeout — host did not admit");
  return "admission-timeout";
}

/**
 * Check if bot is admitted to meeting.
 * Vexa pattern: require ≥2 admission indicators to reduce false positives.
 */
async function checkAdmitted(page) {
  let count = 0;
  for (const sel of SELECTORS.admissionIndicators) {
    try {
      const el = await page.$(sel);
      if (el) count++;
      if (count >= 2) return "admitted"; // Vexa requires ≥2
    } catch {}
  }
  return "not-admitted";
}

// ── Leave ────────────────────────────────────────────────────────────────

/**
 * Leave Google Meet.
 */
export async function leaveGoogleMeet(page) {
  for (const sel of SELECTORS.leaveButton) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.scrollIntoViewIfNeeded();
        await _wait(500);
        await btn.click();
        console.log("[Meet:Leave] Clicked leave button");
        await _wait(1000);
        return "left";
      }
    } catch {}
  }

  // Fallback — evaluate click
  await page.evaluate(() => {
    const btns = document.querySelectorAll("button");
    for (const btn of btns) {
      const text = btn.textContent.toLowerCase();
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (text.includes("leave") || label.includes("leave") || label.includes("hang up")) {
        btn.click();
        return;
      }
    }
  });
  await _wait(1000);
  return "left";
}

// ── Removal Monitoring ───────────────────────────────────────────────────

/**
 * Start monitoring for host removing the bot.
 * Returns a cleanup function to stop monitoring.
 * @param {import('playwright').Page} page
 * @param {Function} onRemoval — called when removal detected
 */
export function startRemovalMonitor(page, onRemoval) {
  const intervalId = setInterval(async () => {
    try {
      const bodyText = await page.textContent("body").catch(() => "");
      const removed = SELECTORS.removalIndicators.some(p =>
        bodyText.toLowerCase().includes(p)
      );
      if (removed) {
        clearInterval(intervalId);
        console.log("[Meet:Removal] Bot was removed from meeting");
        onRemoval("removed");
      }
    } catch {
      // Page may be closed — stop monitoring
      clearInterval(intervalId);
    }
  }, 1500); // Check every 1.5s (Vexa pattern)

  return () => clearInterval(intervalId);
}
