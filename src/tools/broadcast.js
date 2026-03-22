/**
 * broadcast(preset, text?, filePath?, channels?) — Send content to delivery preset targets or specific channels.
 *
 * General-purpose delivery tool. Works in any context: cron, chat, sub-agent, API.
 * Resolves routing metadata from tenant_channels at send time (always fresh).
 */
import channelRegistry from "../channels/index.js";
import tenantManager from "../tenants/TenantManager.js";
import tenantContext from "../tenants/TenantContext.js";
import { loadPresetByName, loadPreset } from "../scheduler/DeliveryPresetStore.js";
import { existsSync, statSync } from "node:fs";
import filesystemGuard from "../safety/FilesystemGuard.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export async function broadcast(params) {
  const { preset, text, filePath, channels } = params || {};

  try {
    // ── Admin-only check ───────────────────────────────────────────────────
    const store = tenantContext.getStore();
    const tenant = store?.tenant;
    const isAdmin = !tenant || tenant.globalAdmin === true;
    if (!isAdmin) return "Error: broadcast is admin-only.";

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
        // No preset — build targets from channel names (global channels)
        targets = filter.map(ch => ({ channel: ch, tenantId: null, userId: null }));
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
 * Send to a single target — resolves fresh routing meta, finds channel instance, sends.
 */
async function _sendToTarget(target, text, filePath) {
  const { channel: channelType, tenantId, userId } = target;
  if (!channelType) return { ok: false, error: "No channel type" };

  // Resolve routing metadata from tenant_channels
  const meta = _resolveMeta(channelType, tenantId, userId, target.channelMeta);
  if (!meta) return { ok: false, error: `No routing metadata for ${channelType}${tenantId ? `:${tenantId}` : ""}` };

  // Find channel instance — tenant-specific first, then global
  const instanceKey = meta.instanceKey || (tenantId ? `${channelType}::${tenantId}` : null);
  const ch = channelRegistry.get(channelType, instanceKey) || channelRegistry.get(channelType);
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

/**
 * Resolve fresh routing metadata from tenant_channels.
 */
function _resolveMeta(channelType, tenantId, userId, fallback) {
  if (!tenantId) return fallback || null;
  try {
    const channels = tenantManager.getChannels(tenantId);
    const match = channels.find(c =>
      c.channel === channelType && (!userId || c.user_id === userId)
    );
    if (!match?.meta) return fallback || null;
    // Add instanceKey for tenant channel routing
    const instanceKey = `${channelType}::${tenantId}`;
    const instance = channelRegistry.get(channelType, instanceKey);
    return instance ? { ...match.meta, instanceKey } : match.meta;
  } catch {
    return fallback || null;
  }
}

export const broadcastDescription =
  "broadcast(preset, text?, filePath?, channels?) — Fleet Command: send text or file to all targets in a delivery preset. " +
  "preset: preset name (required unless channels specified). " +
  "channels: optional comma-separated filter. " +
  "Admin-only.";
