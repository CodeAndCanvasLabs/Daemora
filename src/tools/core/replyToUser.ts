/**
 * reply_to_user — narrate progress mid-task without ending the turn.
 *
 * Two modes:
 *   1. **Default (no `channels` arg)** — surfaces as a text-delta event
 *      on the SSE stream of the current task. The user sees the message
 *      in whatever surface spawned the task (web UI / a channel reply).
 *
 *   2. **`channels: ["telegram", "discord", ...]`** — fans the message
 *      out to the named targets. Each entry is resolved as:
 *        a. a DeliveryPreset *name* (richest — gives `(channel, channelMeta)`)
 *        b. a channel id, with `<CHANNEL>_DEFAULT_CHAT_ID` setting as the
 *           target (e.g. `TELEGRAM_DEFAULT_CHAT_ID`)
 *      If neither resolves, that entry fails (the rest still try).
 *
 * The factory is called twice in production:
 *   - Once at AgentLoop construction (no opts → bare narration tool)
 *   - Once in start.ts after ChannelManager exists, where the bare tool
 *     is unregistered and replaced with a channel-aware build.
 */

import { z } from "zod";

import type { ChannelMeta } from "../../channels/BaseChannel.js";
import type { ChannelManager } from "../../channels/ChannelManager.js";
import type { ConfigManager } from "../../config/ConfigManager.js";
import type { DeliveryPresetStore } from "../../scheduler/DeliveryPresetStore.js";
import type { ToolDef } from "../types.js";

export interface ReplyToUserOpts {
  readonly channels?: ChannelManager;
  readonly deliveryPresets?: DeliveryPresetStore;
  readonly cfg?: ConfigManager;
}

interface ChannelDelivery {
  readonly target: string;
  readonly resolvedAs: "preset" | "channel-default" | "unresolved";
  readonly ok: boolean;
  readonly error?: string;
}

export function makeReplyToUserTool(opts?: ReplyToUserOpts): ToolDef<z.ZodTypeAny, { delivered: boolean; channels?: readonly ChannelDelivery[] }> {
  const cm = opts?.channels;
  const presets = opts?.deliveryPresets;
  const cfg = opts?.cfg;

  // Build the input schema. The `channels` field only appears in the
  // schema when channel routing is actually wired — agents in contexts
  // without ChannelManager don't see (and can't pass) the field.
  const baseShape: { message: z.ZodString; channels?: z.ZodArray<z.ZodString> } = {
    message: z.string().min(1).max(10_000)
      .describe("Text to send to the user immediately, mid-task."),
  };
  if (cm) {
    baseShape.channels = z.array(z.string().min(1)).optional()
      .describe(
        `Optional. Route the message to one or more channels. Each entry is a delivery-preset name OR a running channel id. ${describeTargets(cm, presets)} ` +
        "If omitted, replies in the current conversation/source channel.",
      ) as unknown as z.ZodArray<z.ZodString>;
  }
  const inputSchema = z.object(baseShape);

  const description = cm
    ? `Send a message to the user mid-task without stopping. Default delivery is the current conversation. Pass \`channels\` to fan out to other targets. ${describeTargets(cm, presets)}`
    : "Send a message to the user mid-task without stopping. Use for progress updates or acknowledgements while continuing work.";

  return {
    name: "reply_to_user",
    description,
    category: "core",
    source: { kind: "core" },
    alwaysOn: true,
    inputSchema,
    async execute(input: { message: string; channels?: readonly string[] }, { logger }) {
      const message = input.message;
      const targets = input.channels ?? [];

      // Mode 1 — current behavior. Logged here, surfaced on SSE by the
      // agent loop's text-delta shim.
      if (targets.length === 0 || !cm) {
        logger.info("reply_to_user called", { messageLength: message.length });
        return { delivered: true };
      }

      // Mode 2 — explicit channel fan-out.
      const results: ChannelDelivery[] = [];
      for (const target of targets) {
        const r = await deliver(target, message, cm, presets, cfg);
        results.push(r);
        if (!r.ok) logger.warn("reply_to_user delivery failed", { target, error: r.error });
      }
      const okCount = results.filter((r) => r.ok).length;
      return { delivered: okCount > 0, channels: results };
    },
  };
}

function describeTargets(cm: ChannelManager, presets?: DeliveryPresetStore): string {
  const channels = [...cm.runningSet()].sort();
  const presetNames = presets ? presets.list().map((p) => p.name).sort() : [];
  const parts: string[] = [];
  if (channels.length > 0) parts.push(`Running channels: ${channels.join(", ")}.`);
  if (presetNames.length > 0) parts.push(`Delivery presets: ${presetNames.join(", ")}.`);
  if (parts.length === 0) return "No channels currently running.";
  return parts.join(" ");
}

async function deliver(
  target: string,
  message: string,
  cm: ChannelManager,
  presets: DeliveryPresetStore | undefined,
  cfg: ConfigManager | undefined,
): Promise<ChannelDelivery> {
  // Try preset name first. A preset is a *list* of (channel, channelMeta)
  // targets, so a single preset entry may fan out to several channels.
  const preset = presets?.getByName(target);
  if (preset) {
    if (preset.targets.length === 0) {
      return { target, resolvedAs: "preset", ok: false, error: `preset '${target}' has no targets configured` };
    }
    const errors: string[] = [];
    let anyOk = false;
    for (const t of preset.targets) {
      const ch = cm.getChannel(t.channel);
      if (!ch) {
        errors.push(`channel '${t.channel}' not running`);
        continue;
      }
      const meta = { ...(t.channelMeta ?? {}), channel: t.channel } as ChannelMeta;
      try {
        await ch.sendReply(meta, message);
        anyOk = true;
      } catch (e) {
        errors.push(`${t.channel}: ${(e as Error).message}`);
      }
    }
    return anyOk
      ? { target, resolvedAs: "preset", ok: true, ...(errors.length > 0 ? { error: errors.join("; ") } : {}) }
      : { target, resolvedAs: "preset", ok: false, error: errors.join("; ") };
  }

  // Try as a channel id with a `<CHANNEL>_DEFAULT_CHAT_ID` setting.
  const id = target.toLowerCase();
  const ch = cm.getChannel(id);
  if (ch) {
    const settingKey = `${id.toUpperCase()}_DEFAULT_CHAT_ID`;
    const raw = cfg?.settings.getGeneric(settingKey);
    const chatId = typeof raw === "string" ? raw : "";
    if (!chatId) {
      return {
        target,
        resolvedAs: "unresolved",
        ok: false,
        error: `no default target for channel '${id}'. Set ${settingKey} or create a delivery preset.`,
      };
    }
    const meta: ChannelMeta = {
      channel: id,
      userId: chatId,
      chatId,
      to: chatId,
      phoneNumber: chatId,
      email: chatId,
    };
    try {
      await ch.sendReply(meta, message);
      return { target, resolvedAs: "channel-default", ok: true };
    } catch (e) {
      return { target, resolvedAs: "channel-default", ok: false, error: (e as Error).message };
    }
  }

  return {
    target,
    resolvedAs: "unresolved",
    ok: false,
    error: `'${target}' is neither a delivery-preset name nor a running channel id`,
  };
}

/**
 * Backward-compat export — kept so existing imports of `replyToUserTool`
 * continue to compile. Returns the bare-narration version (no opts).
 */
export const replyToUserTool: ToolDef<z.ZodTypeAny, { delivered: boolean; channels?: readonly ChannelDelivery[] }> = makeReplyToUserTool();
