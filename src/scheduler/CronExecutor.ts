/**
 * CronExecutor — the callback CronScheduler invokes on each due job.
 *
 * Walks the job through the same TaskRunner that serves HTTP / channels,
 * so a cron-triggered run produces the same session history, event
 * stream, and terminal state as a user-driven one.
 *
 * Delivery: if `job.delivery.channel` is set, the assistant's final
 * text is forwarded to that channel via the normal `task:reply:needed`
 * bus event (ChannelManager subscribes).
 */

import type { ChannelMeta } from "../channels/BaseChannel.js";
import type { TaskRunner } from "../core/TaskRunner.js";
import type { CronJob } from "../cron/CronStore.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("cron.exec");

export interface CronExecutorDeps {
  readonly runner: TaskRunner;
}

export function makeCronExecutor(deps: CronExecutorDeps): (job: CronJob) => Promise<string> {
  return async (job: CronJob): Promise<string> => {
    // Write into the shared "main" session so cron activity (morning
    // pulse, background briefings, etc.) shows up inline in the chat
    // view — otherwise the user has to dig through the Logs page to
    // see what Daemora did while they were away. Task history + tool
    // traces are still keyed by taskId, so per-run isolation for
    // audit/logs is unaffected.
    const sessionId = "main";
    const deliveryChannel = typeof job.delivery?.["channel"] === "string" ? (job.delivery["channel"] as string) : undefined;
    const deliveryMeta = isObject(job.delivery?.["channelMeta"]) ? (job.delivery["channelMeta"] as ChannelMeta) : undefined;
    const input = [
      `[Cron: ${job.name}] — scheduled, no user present.`,
      "",
      job.task,
    ].join("\n");

    // Use send() so cron firings inject into a running chat loop on
    // "main" instead of spawning a parallel task. The agent absorbs the
    // cron prompt at its next safe boundary; the user sees it inline.
    const sendResult = deps.runner.send({
      input,
      sessionId,
      ...(deliveryChannel ? { channel: deliveryChannel } : {}),
      ...(deliveryMeta ? { channelMeta: deliveryMeta } : {}),
    });
    log.info(
      { jobId: job.id, taskId: sendResult.taskId, mode: sendResult.mode },
      sendResult.mode === "injected" ? "cron job injected into running loop" : "cron job spawned fresh loop",
    );

    if (sendResult.mode === "injected") {
      // The running loop will absorb this cron prompt and respond as
      // part of its next iteration. There's no per-cron `done` to await
      // — return immediately. Caller logs the firing; the agent's
      // reply lands in the running task's stream.
      return "injected";
    }

    const terminal = await sendResult.done!;
    if (terminal.status === "failed") {
      throw new Error(terminal.error ?? "cron job failed");
    }
    return terminal.result ?? "ok";
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
