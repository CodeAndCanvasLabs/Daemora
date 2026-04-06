/**
 * broadcast(preset, text?, filePath?, channels?) - Send content to delivery preset targets or specific channels.
 *
 * General-purpose delivery tool. Works in any context: cron, chat, sub-agent, API.
 * Resolves routing metadata from presets at send time.
 */
import channelRegistry from "../channels/index.js";
import { loadPresetByName, loadPreset } from "../scheduler/DeliveryPresetStore.js";
import { existsSync, statSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function broadcast(params) {
  const { preset, text, filePath, channels } = params || {};

  try {
    // ── Validate inputs ────────────────────────────────────────────────────
    if (!text && !filePath) return "Error: text or filePath required.";

    if (filePath) {
      const readCheck = filesystemGuard.checkRead(filePath);
      if (!readCheck.allowed) return `Error: ${readCheck.reason}`;
      if (!existsSync(filePath)) return `Error: File not found: ${filePath}`;
      const size = statSync(filePath).size;
      if (size > MAX_FILE_SIZE) return `Error: File too large (${(size / 1024 / 1024).toFixed(1)} MB). Max 50 MB.`;
    }

    // ── Resolve targets ────────────────────────────────────────────────────
    let targets = [];

    if (preset) {
      // Resolve by name or ID
      const p = loadPresetByName(preset) || loadPreset(preset);
      if (!p || !p.targets?.length) return `Error: Preset "${preset}" not found or empty.`;
      targets = p.targets;
    }

    // Filter to specific channels if requested
    if (channels) {
      const filter = (typeof channels === "string" ? channels.split(",") : channels).map(c => c.trim().toLowerCase());
      if (targets.length > 0) {
        targets = targets.filter(t => filter.includes(t.channel?.toLowerCase()));
        if (targets.length === 0) return `Error: No targets match channels: ${filter.join(", ")}`;
      } else {
        // No preset - build targets from channel names
        targets = filter.map(ch => ({ channel: ch }));
      }
    }

    if (targets.length === 0) return "Error: No targets resolved. Provide preset or channels.";

    // ── Fan-out delivery ─────────────────────────────────────────────────
    const results = await Promise.allSettled(
      targets.map(t => _sendToTarget(t, text, filePath))
    );

    const delivered = results.filter(r => r.status === "fulfilled" && r.value?.ok).length;
    const errors = results
      .filter(r => r.status === "rejected" || !r.value?.ok)
      .map(r => r.reason?.message || r.value?.error)
      .filter(Boolean);

    if (delivered === 0) return `Error: All ${results.length} deliveries failed. ${errors.join("; ")}`;
    if (errors.length > 0) return `Delivered ${delivered}/${results.length}. Errors: ${errors.join("; ")}`;
    return `Delivered to ${delivered} target(s).`;

  } catch (error) {
    return `Error: ${error.message}`;
  }
}

/**
 * Send to a single target - finds channel instance, sends.
 */
async function _sendToTarget(target, text, filePath) {
  const { channel: channelType } = target;
  if (!channelType) return { ok: false, error: "No channel type" };

  const meta = target.channelMeta || null;

  const ch = channelRegistry.get(channelType);
  if (!ch || !ch.running) return { ok: false, error: `Channel "${channelType}" not running` };

  // Send file if provided
  if (filePath && typeof ch.sendFile === "function") {
    await ch.sendFile(meta, filePath, text || "");
    return { ok: true };
  }

  // Send text
  if (text) {
    await ch.sendReply(meta, text);
    return { ok: true };
  }

  return { ok: false, error: "Nothing to send" };
}

export const broadcastDescription =
  "broadcast(preset, text?, filePath?, channels?) - Send text or file to all targets in a delivery preset. " +
  "preset: preset name (required unless channels specified). " +
  "channels: optional comma-separated filter.";
