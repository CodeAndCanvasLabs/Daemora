/**
 * Microsoft Teams platform handler.
 *
 * Based on Vexa's msteams/ directory.
 * RTCPeerConnection hook → pre-join setup → join → admission → leave.
 *
 * Critical: RTCPeerConnection hook MUST be injected via addInitScript BEFORE navigation.
 * Teams uses WebRTC for audio — without the hook, AudioCapture can't find audio elements.
 */

import { TEAMS_RTC_HOOK_SCRIPT } from "../services/AudioCapture.js";

// ── Selectors (from Vexa's msteams/selectors.ts) ─────────────────────────

const SELECTORS = {
  continueButton: [
    'button:has-text("Continue on this browser")',
    'a:has-text("Continue on this browser")',
    'button:has-text("Join on the web")',
  ],
  nameInput: [
    'input[data-tid="prejoin-display-name-input"]',
    'input[placeholder*="name" i]',
  ],
  joinButton: [
    'button:has-text("Join now")',
    'button[data-tid="prejoin-join-button"]',
  ],
  cameraOff: [
    'button[aria-label*="Turn off camera" i]',
    'button[aria-label*="Turn off video" i]',
    '[data-tid="toggle-video"]',
  ],
  computerAudio: [
    'input[value="computer-audio"]',
    '[data-tid="computer-audio"]',
    '[role="radio"][aria-label*="Computer audio" i]',
  ],
  speakerEnable: [
    'button[aria-label*="Turn speaker on" i]',
    'button[aria-label*="speaker" i]',
  ],
  leaveButton: [
    'button[id="hangup-button"]',
    'button[aria-label*="Leave" i]',
    'button[aria-label*="Hang up" i]',
  ],
  admissionIndicators: [
    '[data-tid*="participant"]',
    'button[aria-label*="Chat" i]',
    'button[aria-label*="Leave" i]',
    'button[id="hangup-button"]',
  ],
  rejectionPatterns: [
    "sorry, but you were denied",
    "can't join",
    "meeting has ended",
    "unable to join",
  ],
};

function _wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Join ─────────────────────────────────────────────────────────────────

/**
 * Join a Microsoft Teams meeting.
 * @param {import('playwright').Page} page
 * @param {object} session — { meetingUrl, displayName }
 * @returns {Promise<string>} status
 */
export async function joinTeams(page, session) {
  const { meetingUrl, displayName } = session;

  // RTCPeerConnection hook MUST be injected before navigation
  // (Already done in BrowserMeetingBot before calling this function)

  await page.goto(meetingUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.bringToFront();
  await _wait(5000);

  console.log(`[Teams:Join] Page URL: ${page.url()}`);

  // Handle "Continue on this browser"
  for (const sel of SELECTORS.continueButton) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log("[Teams:Join] Clicked 'Continue on this browser'");
        await _wait(3000);
        break;
      }
    } catch {}
  }

  // Warm up media devices (Vexa pattern — triggers permission grant)
  try {
    await page.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach(t => t.stop());
      } catch {}
    });
    await _wait(1000);
  } catch {}

  // Fill display name
  for (const sel of SELECTORS.nameInput) {
    try {
      const input = await page.waitForSelector(sel, { timeout: 10000 });
      if (input) {
        await input.fill(displayName);
        console.log(`[Teams:Join] Name: ${displayName}`);
        break;
      }
    } catch {}
  }
  await _wait(500);

  // Turn off camera
  for (const sel of SELECTORS.cameraOff) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log("[Teams:Join] Camera off"); break; }
    } catch {}
  }
  await _wait(500);

  // Select "Computer audio"
  for (const sel of SELECTORS.computerAudio) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); console.log("[Teams:Join] Computer audio selected"); break; }
    } catch {}
  }
  await _wait(500);

  // Enable speaker
  for (const sel of SELECTORS.speakerEnable) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); console.log("[Teams:Join] Speaker enabled"); break; }
    } catch {}
  }

  // Unmute all audio elements (Teams may mute them)
  await page.evaluate(() => {
    document.querySelectorAll("audio").forEach(el => {
      el.muted = false;
      el.autoplay = true;
      el.volume = 1.0;
      el.play().catch(() => {});
    });
  });

  // Click "Join now"
  let clicked = false;
  for (const sel of SELECTORS.joinButton) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 15000 });
      if (btn) {
        await btn.click();
        console.log("[Teams:Join] Clicked 'Join now'");
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    console.log("[Teams:Join] No join button found");
    return "no-join-button";
  }

  await _wait(8000);

  // Check admission
  return await waitForAdmission(page);
}

// ── Admission ────────────────────────────────────────────────────────────

async function waitForAdmission(page, timeoutMs = 120000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check rejection
    const bodyText = await page.textContent("body").catch(() => "");
    if (SELECTORS.rejectionPatterns.some(p => bodyText.toLowerCase().includes(p))) {
      console.log("[Teams:Admission] Rejected");
      return "rejected";
    }

    // Check admitted (≥2 indicators)
    let count = 0;
    for (const sel of SELECTORS.admissionIndicators) {
      try {
        const el = await page.$(sel);
        if (el) count++;
        if (count >= 2) {
          console.log("[Teams:Admission] In meeting");
          return "joined";
        }
      } catch {}
    }

    await _wait(2000);
  }

  return "admission-timeout";
}

// ── Leave ────────────────────────────────────────────────────────────────

export async function leaveTeams(page) {
  for (const sel of SELECTORS.leaveButton) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        console.log("[Teams:Leave] Left meeting");
        await _wait(1000);
        return "left";
      }
    } catch {}
  }
  return "left";
}

// ── Removal Monitor ──────────────────────────────────────────────────────

export function startRemovalMonitor(page, onRemoval) {
  const intervalId = setInterval(async () => {
    try {
      const bodyText = await page.textContent("body").catch(() => "");
      if (SELECTORS.rejectionPatterns.some(p => bodyText.toLowerCase().includes(p))) {
        clearInterval(intervalId);
        onRemoval("removed");
      }
    } catch {
      clearInterval(intervalId);
    }
  }, 1500);

  return () => clearInterval(intervalId);
}
