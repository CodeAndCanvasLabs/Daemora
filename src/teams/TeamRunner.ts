/**
 * TeamRunner — executes a team's worker DAG.
 *
 * Orchestration loop:
 *   1. Fetch ready workers (all blockers completed).
 *   2. Run them in parallel via CrewAgentRunner.
 *   3. On completion, store results and re-check for newly unblocked workers.
 *   4. Repeat until every worker is in a terminal state or the team times out.
 *
 * Worker failures are isolated — a failed worker does NOT automatically
 * fail its dependents. Dependents whose blockers include a failed worker
 * will never become "ready" and stay in "pending" (effectively skipped).
 * The team completes when no more progress can be made.
 */

import { createLogger } from "../util/logger.js";
import type { CrewAgentRunner, CrewRunInput } from "../crew/CrewAgentRunner.js";
import type { TeamStore, WorkerRow } from "./TeamStore.js";

const log = createLogger("teams.runner");

/** Default team-level timeout: 30 minutes. */
const DEFAULT_TEAM_TIMEOUT_MS = 30 * 60 * 1000;

/** Default per-worker max steps inside the crew run. */
const DEFAULT_WORKER_MAX_STEPS = 25;

export interface TeamRunnerOpts {
  readonly store: TeamStore;
  readonly crewRunner: CrewAgentRunner;
  /** Timeout for the entire team execution. */
  readonly timeoutMs?: number;
  /** Max steps per worker crew run. */
  readonly workerMaxSteps?: number;
}

export interface TeamRunResult {
  readonly teamId: string;
  readonly status: "completed" | "failed";
  readonly workerResults: ReadonlyMap<string, string>;
  readonly failedWorkers: readonly string[];
  readonly skippedWorkers: readonly string[];
  readonly durationMs: number;
}

export class TeamRunner {
  private readonly store: TeamStore;
  private readonly crewRunner: CrewAgentRunner;
  private readonly timeoutMs: number;
  private readonly workerMaxSteps: number;

  constructor(opts: TeamRunnerOpts) {
    this.store = opts.store;
    this.crewRunner = opts.crewRunner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TEAM_TIMEOUT_MS;
    this.workerMaxSteps = opts.workerMaxSteps ?? DEFAULT_WORKER_MAX_STEPS;
  }

  async runTeam(
    teamId: string,
    opts?: { parentTaskId?: string; parentModelId?: string; abortSignal?: AbortSignal },
  ): Promise<TeamRunResult> {
    const team = this.store.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    if (team.status !== "active") throw new Error(`Team ${teamId} is already ${team.status}`);

    const startTime = Date.now();
    const parentTaskId = opts?.parentTaskId ?? `team:${teamId}`;
    const parentModelId = opts?.parentModelId ?? "default";

    // Combine team-level timeout with caller's abort signal.
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), this.timeoutMs);

    const abortSignal = opts?.abortSignal
      ? combineAbortSignals(opts.abortSignal, timeoutController.signal)
      : timeoutController.signal;

    const completedResults = new Map<string, string>();
    const failedWorkers: string[] = [];

    log.info({ teamId, name: team.name }, "team execution starting");

    try {
      // Main orchestration loop.
      while (!this.store.isTeamComplete(teamId)) {
        if (abortSignal.aborted) {
          log.warn({ teamId }, "team execution aborted");
          break;
        }

        const ready = this.store.getReadyWorkers(teamId);

        if (ready.length === 0) {
          // No ready workers and not complete — remaining workers are
          // blocked by failed dependencies. Nothing more to do.
          log.info({ teamId }, "no more ready workers — stalled");
          break;
        }

        log.info(
          { teamId, readyCount: ready.length, names: ready.map((w) => w.name) },
          "running ready workers",
        );

        // Run all ready workers in parallel.
        const results = await Promise.allSettled(
          ready.map((worker) =>
            this.runWorker(worker, completedResults, {
              parentTaskId,
              parentModelId,
              abortSignal,
            }),
          ),
        );

        // Process results.
        for (let i = 0; i < results.length; i++) {
          const worker = ready[i]!;
          const result = results[i]!;

          if (result.status === "fulfilled") {
            completedResults.set(worker.name, result.value);
            this.store.updateWorkerStatus(worker.id, "completed", result.value);
            log.info({ teamId, worker: worker.name }, "worker completed");
          } else {
            const errMsg = result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);
            failedWorkers.push(worker.name);
            this.store.updateWorkerStatus(worker.id, "failed", undefined, errMsg);
            log.error({ teamId, worker: worker.name, error: errMsg }, "worker failed");
          }
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    // Determine final team status.
    const allWorkers = this.store.getWorkers(teamId);
    const skippedWorkers = allWorkers
      .filter((w) => w.status === "pending")
      .map((w) => w.name);

    const anyFailed = failedWorkers.length > 0 || skippedWorkers.length > 0;
    const teamStatus = anyFailed ? "failed" : "completed";

    this.store.completeTeam(teamId, teamStatus);

    const durationMs = Date.now() - startTime;
    log.info(
      {
        teamId,
        status: teamStatus,
        completed: completedResults.size,
        failed: failedWorkers.length,
        skipped: skippedWorkers.length,
        durationMs,
      },
      "team execution finished",
    );

    return {
      teamId,
      status: teamStatus,
      workerResults: completedResults,
      failedWorkers,
      skippedWorkers,
      durationMs,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Internal                                                         */
  /* ---------------------------------------------------------------- */

  private async runWorker(
    worker: WorkerRow,
    completedResults: ReadonlyMap<string, string>,
    ctx: { parentTaskId: string; parentModelId: string; abortSignal: AbortSignal },
  ): Promise<string> {
    this.store.updateWorkerStatus(worker.id, "running");

    const taskWithContext = buildWorkerContext(worker, completedResults);
    const crewId = worker.crew ?? worker.profile ?? "backend";

    const input: CrewRunInput = {
      crewId,
      task: taskWithContext,
      parentTaskId: `${ctx.parentTaskId}/worker:${worker.name}`,
      parentModelId: ctx.parentModelId,
      maxSteps: this.workerMaxSteps,
      abortSignal: ctx.abortSignal,
    };

    const result = await this.crewRunner.run(input);
    return result.text;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the full task prompt for a worker, prepending results from
 * completed dependency workers so the crew has full context.
 */
function buildWorkerContext(
  worker: WorkerRow,
  completedResults: ReadonlyMap<string, string>,
): string {
  const blockers: string[] = JSON.parse(worker.blockedBy);
  if (blockers.length === 0) return worker.task;

  const contextSections: string[] = [];

  for (const depName of blockers) {
    const depResult = completedResults.get(depName);
    if (depResult) {
      contextSections.push(
        `--- Result from "${depName}" ---\n${depResult}\n--- End "${depName}" ---`,
      );
    }
  }

  if (contextSections.length === 0) return worker.task;

  return [
    "## Context from completed dependencies\n",
    ...contextSections,
    "",
    "## Your task\n",
    worker.task,
  ].join("\n");
}

/**
 * Combine two AbortSignals — aborts when either fires.
 */
function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // AbortSignal.any is available in Node 20+.
  if ("any" in AbortSignal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([a, b]);
  }

  // Fallback for older runtimes.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
