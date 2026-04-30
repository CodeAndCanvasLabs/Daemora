/**
 * Desktop-control tools — drive mouse, keyboard, windows, and screen
 * capture via the Python sidecar at 127.0.0.1:8765.
 *
 * All tools in this module talk to the same HTTP sidecar (shipped
 * with the Daemora desktop app, or launchable manually via
 * `python -m daemora_sidecar.main`). If the sidecar isn't running,
 * every tool fails with a clear error telling the user how to start it.
 *
 * Exported as a batch — `makeDesktopTools()` returns all of them so
 * the index file doesn't need to know every operation by name.
 */

import { z, type ZodType } from "zod";

import type { ConfigManager } from "../../config/ConfigManager.js";
import { ProviderError } from "../../util/errors.js";
import type { ToolDef } from "../types.js";

import { makeImageAnalysisTool } from "./imageAnalysis.js";

/**
 * Identity helper that anchors the generics on ToolDef so each factory
 * gets proper input/output inference inside execute() without us having
 * to spell out `ToolDef<typeof schema, T>` by hand on every tool.
 */
function def<TIn extends ZodType, TOut>(d: ToolDef<TIn, TOut>): ToolDef<TIn, TOut> {
  return d;
}

// ── Sidecar HTTP client ──────────────────────────────────────────

const DEFAULT_URL = "http://127.0.0.1:8765";

function sidecarConfig(cfg: ConfigManager): { baseUrl: string; token: string } {
  const baseUrl =
    (cfg.settings.getGeneric("DESKTOP_SIDECAR_URL") as string | undefined)
    ?? process.env["DESKTOP_SIDECAR_URL"]
    ?? process.env["CREW_DESKTOP_CONTROL_SIDECAR_URL"]
    ?? DEFAULT_URL;
  const token =
    cfg.vault.get("DESKTOP_SIDECAR_TOKEN")?.reveal()
    ?? process.env["DESKTOP_SIDECAR_TOKEN"]
    ?? process.env["CREW_DESKTOP_CONTROL_SIDECAR_TOKEN"]
    ?? "";
  return { baseUrl, token };
}

async function sidecarPost<T = unknown>(
  cfg: ConfigManager,
  path: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, token } = sidecarConfig(cfg);
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["X-Daemora-Token"] = token;

  let res: Response;
  try {
    const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
    if (signal) init.signal = signal;
    res = await fetch(url, init);
  } catch (e) {
    throw new ProviderError(
      `Desktop sidecar unreachable at ${url}. Start the Daemora desktop app, or run the sidecar: \`python -m daemora_sidecar.main\`. (${(e as Error).message})`,
      "desktop-sidecar",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`Desktop sidecar ${res.status}: ${text.slice(0, 400)}`, "desktop-sidecar");
  }
  return (await res.json()) as T;
}

async function sidecarGet<T = unknown>(
  cfg: ConfigManager,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const { baseUrl, token } = sidecarConfig(cfg);
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {};
  if (token) headers["X-Daemora-Token"] = token;

  let res: Response;
  try {
    const init: RequestInit = { method: "GET", headers };
    if (signal) init.signal = signal;
    res = await fetch(url, init);
  } catch (e) {
    throw new ProviderError(
      `Desktop sidecar unreachable at ${url}. (${(e as Error).message})`,
      "desktop-sidecar",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`Desktop sidecar ${res.status}: ${text.slice(0, 400)}`, "desktop-sidecar");
  }
  return (await res.json()) as T;
}

// ── Shared schemas ────────────────────────────────────────────────

const buttonSchema = z.enum(["left", "right", "middle"]).default("left");
const modifiersSchema = z.array(z.string()).optional();

// ── Individual tool factories ─────────────────────────────────────

function makeCursorPositionTool(cfg: ConfigManager) {
  const schema = z.object({});
  return def({
    name: "desktop_cursor_position",
    description: "Read the current mouse cursor position as {x, y} screen coordinates.",
    category: "system",
    source: { kind: "core" },
    tags: ["desktop", "mouse"],
    inputSchema: schema,
    async execute(_input, { abortSignal }) {
      const { x, y } = await sidecarGet<{ x: number; y: number }>(cfg, "/desktop/cursor", abortSignal);
      return { x, y, message: `Cursor at (${x}, ${y})` };
    },
  });
}

function makeClickTool(cfg: ConfigManager) {
  const schema = z.object({
    x: z.number().describe("Screen X coordinate."),
    y: z.number().describe("Screen Y coordinate."),
    button: buttonSchema,
    clicks: z.number().int().min(1).max(3).default(1),
    modifiers: modifiersSchema.describe("Keys held during the click, e.g. ['cmd'], ['shift','alt']."),
  });
  return def({
    name: "desktop_click",
    description: "Click at screen coordinates. Optional modifier keys held atomically around the click.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "mouse", "click"],
    inputSchema: schema,
    async execute({ x, y, button, clicks, modifiers }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/click", { x, y, button, clicks, modifiers: modifiers ?? null }, abortSignal);
      const mod = modifiers?.length ? ` [${modifiers.join("+")}]` : "";
      return `Clicked${mod} (${button}×${clicks}) at (${x}, ${y})`;
    },
  });
}

function makeMoveTool(cfg: ConfigManager) {
  const schema = z.object({
    x: z.number(),
    y: z.number(),
    duration: z.number().min(0).default(0).describe("Move duration in seconds; 0 = instant."),
  });
  return def({
    name: "desktop_move",
    description: "Move the mouse to screen coordinates (no click).",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "mouse"],
    inputSchema: schema,
    async execute({ x, y, duration }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/move", { x, y, duration }, abortSignal);
      return `Moved cursor to (${x}, ${y})`;
    },
  });
}

function makeMouseDownTool(cfg: ConfigManager) {
  const schema = z.object({
    button: buttonSchema,
    x: z.number().optional(),
    y: z.number().optional(),
  });
  return def({
    name: "desktop_mouse_down",
    description: "Press and hold a mouse button. Optionally at coords. Pair with desktop_mouse_up.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "mouse"],
    inputSchema: schema,
    async execute({ button, x, y }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/mouse_down", { button, x: x ?? null, y: y ?? null }, abortSignal);
      return `Pressed ${button} mouse${x != null && y != null ? ` at (${x}, ${y})` : ""}`;
    },
  });
}

function makeMouseUpTool(cfg: ConfigManager) {
  const schema = z.object({
    button: buttonSchema,
    x: z.number().optional(),
    y: z.number().optional(),
  });
  return def({
    name: "desktop_mouse_up",
    description: "Release a mouse button. Optionally at coords.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "mouse"],
    inputSchema: schema,
    async execute({ button, x, y }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/mouse_up", { button, x: x ?? null, y: y ?? null }, abortSignal);
      return `Released ${button} mouse${x != null && y != null ? ` at (${x}, ${y})` : ""}`;
    },
  });
}

function makeDragTool(cfg: ConfigManager) {
  const schema = z.object({
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    button: buttonSchema,
    duration: z.number().min(0).default(0.3),
    modifiers: modifiersSchema,
  });
  return def({
    name: "desktop_drag",
    description: "Drag from (fromX, fromY) to (toX, toY). Used for text selection, file moves, window resizing.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "mouse", "drag"],
    inputSchema: schema,
    async execute({ fromX, fromY, toX, toY, button, duration, modifiers }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/drag", {
        from_x: fromX, from_y: fromY, to_x: toX, to_y: toY,
        button, duration, modifiers: modifiers ?? null,
      }, abortSignal);
      const mod = modifiers?.length ? ` [${modifiers.join("+")}]` : "";
      return `Dragged${mod} (${button}) (${fromX}, ${fromY}) → (${toX}, ${toY})`;
    },
  });
}

function makeTypeTextTool(cfg: ConfigManager) {
  const schema = z.object({
    text: z.string().min(1).describe("Text to type into the focused window."),
    interval: z.number().min(0).default(0.01).describe("Per-character delay in seconds."),
  });
  return def({
    name: "desktop_type",
    description: "Type a string into the currently focused window.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "keyboard"],
    inputSchema: schema,
    async execute({ text, interval }, { abortSignal }) {
      const res = await sidecarPost<{ chars?: number }>(cfg, "/desktop/type", { text, interval }, abortSignal);
      return `Typed ${res.chars ?? text.length} characters into focused window`;
    },
  });
}

function makePressKeyTool(cfg: ConfigManager) {
  const schema = z.object({
    key: z.string().min(1).describe("Key name, e.g. 'enter', 'tab', 'escape', 'f5', 'down'."),
  });
  return def({
    name: "desktop_press_key",
    description: "Press a single named key (enter, tab, escape, arrow keys, function keys, etc.).",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "keyboard"],
    inputSchema: schema,
    async execute({ key }, { abortSignal }) {
      await sidecarPost(cfg, "/desktop/keypress", { key }, abortSignal);
      return `Pressed key: ${key}`;
    },
  });
}

function makeKeyComboTool(cfg: ConfigManager) {
  const schema = z.object({
    keys: z.union([
      z.array(z.string()).min(1),
      z.string().min(1).describe("Plus-separated string, e.g. 'cmd+c'."),
    ]).describe("Keys pressed simultaneously."),
  });
  return def({
    name: "desktop_key_combo",
    description: "Press a combination of keys atomically (e.g. cmd+c, ctrl+shift+t).",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "keyboard", "hotkey"],
    inputSchema: schema,
    async execute({ keys }, { abortSignal }) {
      const arr = Array.isArray(keys) ? keys : keys.split("+").map((s) => s.trim()).filter(Boolean);
      if (arr.length === 0) throw new ProviderError("keys must be non-empty", "desktop");
      await sidecarPost(cfg, "/desktop/combo", { keys: arr }, abortSignal);
      return `Pressed combo: ${arr.join("+")}`;
    },
  });
}

function makeHoldKeyTool(cfg: ConfigManager) {
  const schema = z.object({
    key: z.string().min(1).describe("Key to hold."),
    duration: z.number().min(0).default(0.5).describe("Hold duration in seconds."),
  });
  return def({
    name: "desktop_hold_key",
    description: "Press and hold a key for a duration, then release.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "keyboard"],
    inputSchema: schema,
    async execute({ key, duration }, { abortSignal }) {
      const res = await sidecarPost<{ held_seconds?: number }>(cfg, "/desktop/hold_key", { key, duration }, abortSignal);
      return `Held '${key}' for ${res.held_seconds ?? duration}s`;
    },
  });
}

function makeScrollTool(cfg: ConfigManager) {
  const schema = z.object({
    dx: z.number().default(0).describe("Horizontal scroll delta."),
    dy: z.number().default(0).describe("Vertical scroll delta. Negative = scroll up."),
  });
  return def({
    name: "desktop_scroll",
    description: "Scroll the focused window or element.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "scroll"],
    inputSchema: schema,
    async execute({ dx, dy }, { abortSignal }) {
      if (dx === 0 && dy === 0) throw new ProviderError("dx or dy must be non-zero", "desktop");
      await sidecarPost(cfg, "/desktop/scroll", { dx, dy }, abortSignal);
      return `Scrolled dx=${dx} dy=${dy}`;
    },
  });
}

function makeScreenshotTool(cfg: ConfigManager) {
  const schema = z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  });
  return def({
    name: "desktop_screenshot",
    description: "Capture the full screen or a region to disk. Returns the file path.",
    category: "system",
    source: { kind: "core" },
    tags: ["desktop", "screenshot", "capture"],
    inputSchema: schema,
    async execute({ x, y, width, height }, { abortSignal }) {
      const body: Record<string, unknown> = {};
      if (x != null && y != null && width != null && height != null) {
        body["region"] = { x, y, width, height };
      }
      const res = await sidecarPost<{ path: string; width: number; height: number }>(cfg, "/desktop/screenshot", body, abortSignal);
      return { path: res.path, width: res.width, height: res.height, message: `Screenshot ${res.width}×${res.height}: ${res.path}` };
    },
  });
}

function makeListWindowsTool(cfg: ConfigManager) {
  const schema = z.object({});
  return def({
    name: "desktop_list_windows",
    description: "List visible windows with title and active status.",
    category: "system",
    source: { kind: "core" },
    tags: ["desktop", "window"],
    inputSchema: schema,
    async execute(_input, { abortSignal }) {
      const res = await sidecarGet<{ windows?: { title: string; pid?: number; active?: boolean }[] }>(cfg, "/desktop/windows", abortSignal);
      const windows = res.windows ?? [];
      return {
        count: windows.length,
        windows,
        summary: windows.length
          ? windows.map((w) => `${w.active ? "●" : "○"} ${w.title}${w.pid ? ` (pid ${w.pid})` : ""}`).join("\n")
          : "No visible windows detected",
      };
    },
  });
}

function makeFocusWindowTool(cfg: ConfigManager) {
  const schema = z.object({
    name: z.string().min(1).describe("App name on macOS, or substring of window title elsewhere."),
  });
  return def({
    name: "desktop_focus_window",
    description: "Bring a window/app to the foreground.",
    category: "system",
    source: { kind: "core" },
    destructive: true,
    tags: ["desktop", "window"],
    inputSchema: schema,
    async execute({ name }, { abortSignal }) {
      const res = await sidecarPost<{ ok: boolean; error?: string }>(cfg, "/desktop/focus", { name }, abortSignal);
      if (!res.ok) throw new ProviderError(`Focus '${name}' failed: ${res.error ?? "unknown"}`, "desktop");
      return `Focused '${name}'`;
    },
  });
}

function makeWaitTool(cfg: ConfigManager) {
  const schema = z.object({
    seconds: z.number().min(0).max(60).default(1).describe("Seconds to sleep. Max 60."),
  });
  return def({
    name: "desktop_wait",
    description: "Sleep for N seconds (runs on the sidecar side — doesn't block the agent's own event loop).",
    category: "system",
    source: { kind: "core" },
    tags: ["desktop", "timing"],
    inputSchema: schema,
    async execute({ seconds }, { abortSignal }) {
      const res = await sidecarPost<{ slept_seconds?: number }>(cfg, "/desktop/wait", { seconds }, abortSignal);
      return `Waited ${res.slept_seconds ?? seconds}s`;
    },
  });
}

function makeFindElementTool(cfg: ConfigManager) {
  const schema = z.object({
    description: z.string().min(1).describe("Natural-language description of the UI element (e.g. 'the blue Sign In button')."),
  });
  return def({
    name: "desktop_find_element",
    description:
      "Take a screenshot and use vision to locate a UI element by description. Returns screen coordinates you can pass to desktop_click.",
    category: "system",
    source: { kind: "core" },
    tags: ["desktop", "vision", "find"],
    inputSchema: schema,
    async execute({ description }, ctx) {
      type Health = { screen?: { width?: number; height?: number; scaleX?: number; scaleY?: number } };
      const [shot, health] = await Promise.all([
        sidecarPost<{ path: string; width: number; height: number }>(cfg, "/desktop/screenshot", {}, ctx.abortSignal),
        sidecarGet<Health>(cfg, "/health", ctx.abortSignal).catch((): Health => ({})),
      ]);
      if (!shot?.path) throw new ProviderError("Could not capture screenshot for vision lookup", "desktop");

      const screen = health.screen ?? {};
      const scaleX = Number(screen.scaleX) || (shot.width / (screen.width ?? shot.width)) || 1;
      const scaleY = Number(screen.scaleY) || (shot.height / (screen.height ?? shot.height)) || 1;

      const analyse = makeImageAnalysisTool(cfg);
      const prompt =
        `You are a UI vision assistant. The screenshot is ${shot.width}x${shot.height} pixels. ` +
        `Locate this element: "${description}".\n` +
        `Respond with JSON only: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0-1>, "notes": "<short>"}.`;
      const analysis = await analyse.execute(
        { imagePath: shot.path, prompt },
        ctx,
      ) as { text?: string } | string;
      const text = typeof analysis === "string" ? analysis : analysis.text ?? "";

      // Extract the JSON or fall back to a "x, y" coord match
      let parsed: { x?: number; y?: number; confidence?: number; notes?: string } | null = null;
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
      }
      if (!parsed?.x || !parsed?.y) {
        const coordRe = /\b(?:x\s*[:=]\s*)?(\d{1,4})\s*[,\s]\s*(?:y\s*[:=]\s*)?(\d{1,4})\b/i;
        const m = text.match(coordRe);
        if (m?.[1] && m?.[2]) parsed = { x: Number(m[1]), y: Number(m[2]) };
      }
      if (!parsed?.x || !parsed?.y) {
        throw new ProviderError(`Vision returned no coordinates. Raw: ${text.slice(0, 200)}`, "desktop");
      }

      // Vision returns pixel coords against the screenshot — scale back
      // to logical screen coords for use with click/move.
      const logicalX = Math.round(parsed.x / scaleX);
      const logicalY = Math.round(parsed.y / scaleY);
      return {
        x: logicalX,
        y: logicalY,
        confidence: parsed.confidence ?? null,
        notes: parsed.notes ?? null,
        screenshotPath: shot.path,
        message: `Found '${description}' at (${logicalX}, ${logicalY})${parsed.confidence != null ? ` conf=${parsed.confidence}` : ""}`,
      };
    },
  });
}

// ── Batch export ─────────────────────────────────────────────────

export function makeDesktopTools(cfg: ConfigManager): readonly ToolDef[] {
  // Each factory returns a precisely-typed ToolDef<typeof schema, Ret>;
  // the core registry uses the erased `ToolDef` interface, so widen
  // once here via `as unknown as ToolDef`.
  const tools = [
    makeCursorPositionTool(cfg),
    makeClickTool(cfg),
    makeMoveTool(cfg),
    makeMouseDownTool(cfg),
    makeMouseUpTool(cfg),
    makeDragTool(cfg),
    makeTypeTextTool(cfg),
    makePressKeyTool(cfg),
    makeKeyComboTool(cfg),
    makeHoldKeyTool(cfg),
    makeScrollTool(cfg),
    makeScreenshotTool(cfg),
    makeListWindowsTool(cfg),
    makeFocusWindowTool(cfg),
    makeWaitTool(cfg),
    makeFindElementTool(cfg),
  ];
  return tools.map((t) => t as unknown as ToolDef);
}
