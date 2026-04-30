/**
 * EventBus — typed pub/sub for task lifecycle events.
 *
 * The TaskRunner emits events while an agent turn runs; channel handlers
 * (and anything else interested) subscribe by task id. Filter in the
 * listener — the bus is global so late subscribers don't miss events
 * from a task they care about.
 */

import { EventEmitter } from "node:events";

import type { ChannelMeta } from "../channels/BaseChannel.js";

export interface TaskEventMap {
  "task:state": {
    taskId: string;
    status: "running" | "completed" | "failed";
    result?: string;
    error?: string;
  };
  "task:text:delta": { taskId: string; delta: string };
  "task:text:end": { taskId: string; finalText: string };
  "task:tool:before": { taskId: string; name: string; args: unknown };
  "task:tool:after": {
    taskId: string;
    name: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  };
  "task:reply:needed": {
    taskId: string;
    channel: string;
    channelMeta: ChannelMeta;
    text: string;
    failed: boolean;
  };
  // Audit / learning-lifecycle events (hermes parity)
  "compact:triggered": { sessionId: string; tokens: number; threshold: number };
  "compact:completed": {
    sessionId: string;
    newSessionId: string;
    tokensBefore: number;
    tokensAfter: number;
    savingsPct: number;
  };
  "compact:skipped": { sessionId: string; reason: string };
  "loop:detected": {
    taskId: string;
    toolName: string;
    pattern: "exact_repeat" | "ping_pong" | "semantic_repeat" | "polling";
    message: string;
  };
  "memory:written": { target: "memory" | "user"; action: "add" | "replace" | "remove" };
  "skill:created": { skillId: string; path: string };
  "skill:updated": { skillId: string };
  "skill:deleted": { skillId: string };
  "review:started": { sessionId: string; kind: "memory" | "skill" | "combined" };
  "review:completed": { sessionId: string; saves: number };
}

export type TaskEventName = keyof TaskEventMap;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends TaskEventName>(
    event: K,
    listener: (payload: TaskEventMap[K]) => void,
  ): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  off<K extends TaskEventName>(
    event: K,
    listener: (payload: TaskEventMap[K]) => void,
  ): void {
    this.emitter.off(event, listener);
  }

  emit<K extends TaskEventName>(event: K, payload: TaskEventMap[K]): void {
    this.emitter.emit(event, payload);
  }
}
