import { z } from "zod";
import { desktopClick } from "./tools/mouseClick.js";
import { desktopMove } from "./tools/mouseMove.js";
import { desktopType } from "./tools/typeText.js";
import { desktopPressKey } from "./tools/pressKey.js";
import { desktopKeyCombo } from "./tools/keyCombo.js";
import { desktopScroll } from "./tools/scroll.js";
import { desktopScreenshot } from "./tools/screenshot.js";
import { desktopListWindows } from "./tools/listWindows.js";
import { desktopFocusWindow } from "./tools/focusWindow.js";
import { desktopFindElement } from "./tools/findElement.js";
import { sidecarHealth } from "./tools/_sidecar.js";

export default {
  id: "desktop-control",
  name: "Desktop Control",

  register(api) {
    api.registerTool(
      "desktopScreenshot",
      desktopScreenshot,
      z.object({
        x: z.number().optional().describe("Region top-left x (optional — omit for full screen)"),
        y: z.number().optional().describe("Region top-left y"),
        width: z.number().optional().describe("Region width"),
        height: z.number().optional().describe("Region height"),
      }),
      "desktopScreenshot(x?, y?, width?, height?) — capture the screen (or a region). Returns the saved path and dimensions. ALWAYS call before interacting with the GUI so you know what's visible."
    );

    api.registerTool(
      "desktopListWindows",
      desktopListWindows,
      z.object({}),
      "desktopListWindows() — list visible GUI windows / running apps. Returns name, pid, and active flag."
    );

    api.registerTool(
      "desktopFocusWindow",
      desktopFocusWindow,
      z.object({
        name: z.string().describe("App name (macOS) or window title substring (Windows)"),
      }),
      "desktopFocusWindow(name) — bring an app or window to the foreground. Call before typing."
    );

    api.registerTool(
      "desktopFindElement",
      desktopFindElement,
      z.object({
        description: z.string().describe("Natural-language description of the UI element, e.g. 'the blue Sign In button', 'the search box at the top'"),
      }),
      "desktopFindElement(description) — take a screenshot and use vision AI to locate a UI element by description. Returns coordinates, then use desktopClick to interact. Prefer this over guessing pixel coordinates."
    );

    api.registerTool(
      "desktopClick",
      desktopClick,
      z.object({
        x: z.number().describe("Screen x in pixels"),
        y: z.number().describe("Screen y in pixels"),
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)"),
        clicks: z.number().int().min(1).max(3).optional().describe("Click count, 1=single 2=double 3=triple"),
      }),
      "desktopClick(x, y, button?, clicks?) — click at screen coordinates. Use desktopFindElement first to get coordinates for UI elements."
    );

    api.registerTool(
      "desktopMove",
      desktopMove,
      z.object({
        x: z.number(),
        y: z.number(),
        duration: z.number().optional().describe("Seconds for smooth move (default 0 = instant)"),
      }),
      "desktopMove(x, y, duration?) — move the mouse cursor without clicking."
    );

    api.registerTool(
      "desktopType",
      desktopType,
      z.object({
        text: z.string().describe("Text to type into the focused window"),
        interval: z.number().optional().describe("Seconds between keystrokes (default 0.01)"),
      }),
      "desktopType(text, interval?) — type text into whatever window is currently focused. Call desktopFocusWindow first if unsure."
    );

    api.registerTool(
      "desktopPressKey",
      desktopPressKey,
      z.object({
        key: z.string().describe("Single key name, e.g. 'enter', 'tab', 'escape', 'f5', 'backspace'"),
      }),
      "desktopPressKey(key) — press a single key."
    );

    api.registerTool(
      "desktopKeyCombo",
      desktopKeyCombo,
      z.object({
        keys: z.union([
          z.array(z.string()),
          z.string().describe("Plus-separated, e.g. 'cmd+c'"),
        ]).describe("Keys to press together"),
      }),
      "desktopKeyCombo(keys) — press a key combo like cmd+c or ctrl+shift+t."
    );

    api.registerTool(
      "desktopScroll",
      desktopScroll,
      z.object({
        dx: z.number().optional().describe("Horizontal scroll units"),
        dy: z.number().optional().describe("Vertical scroll units (positive = up, negative = down)"),
      }),
      "desktopScroll(dx?, dy?) — scroll the focused window."
    );

    api.registerService({
      id: "desktop-control-health",
      async start() {
        try {
          await sidecarHealth();
          api.log?.info?.("Desktop sidecar reachable");
        } catch (e) {
          api.log?.warn?.(`Desktop sidecar not reachable on startup — desktop-control tools will fail until the Daemora desktop app or \`python -m daemora_sidecar.main\` is running. (${e.message})`);
        }
      },
    });

    api.log?.info?.("Registered 10 desktop-control tools");
  },
};
