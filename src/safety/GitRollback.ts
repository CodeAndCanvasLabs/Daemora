/**
 * GitRollback — snapshots the working tree before the first write in a
 * task so "undo" stays possible.
 *
 * Semantics:
 *   • `snapshot(taskId)` — call once before the first write tool fires.
 *     Uses `git stash push --include-untracked -m <msg>` so the user's
 *     index + untracked files are preserved.
 *   • `undo(taskId)` — discards agent edits (`git checkout -- .` +
 *     `git clean -fd`) and reapplies the stash. Returns a user-facing
 *     status string.
 *   • `drop(taskId)` — called when the task is confirmed good and the
 *     stash can be dropped.
 *
 * No-ops gracefully if git is unavailable or the cwd isn't inside a
 * repo. Failures never block the agent.
 */

import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";

import { createLogger } from "../util/logger.js";

const log = createLogger("git-rollback");

export class GitRollback extends EventEmitter {
  private readonly snapshotMessages = new Map<string, string>();
  private readonly snapshotted = new Set<string>();
  private enabled = true;

  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }

  isGitRepo(cwd?: string): boolean {
    try {
      execFileSync("git", ["rev-parse", "--git-dir"], {
        stdio: "pipe",
        ...(cwd ? { cwd } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Snapshot the working tree for a task. Idempotent — subsequent calls
   * for the same taskId return null without touching git. Returns the
   * stash message (used as a lookup key in `git stash list`) or null
   * when nothing needed stashing.
   */
  snapshot(taskId: string, cwd?: string): string | null {
    if (!this.enabled || !taskId) return null;
    if (this.snapshotted.has(taskId)) return null;
    if (!this.isGitRepo(cwd)) return null;

    try {
      const status = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      }).trim();

      if (!status) {
        // Clean tree — mark done so we don't keep re-checking.
        this.snapshotted.add(taskId);
        return null;
      }

      const msg = `daemora-snapshot-${taskId.slice(0, 8)}-${Date.now()}`;
      execFileSync("git", ["stash", "push", "-m", msg, "--include-untracked"], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });

      this.snapshotted.add(taskId);
      this.snapshotMessages.set(taskId, msg);
      log.info({ taskId, msg }, "git snapshot created");
      this.emit("snapshot", { taskId, ref: msg });
      return msg;
    } catch (err) {
      log.warn({ taskId, err: (err as Error).message }, "git snapshot failed (non-fatal)");
      this.snapshotted.add(taskId); // don't retry
      return null;
    }
  }

  /**
   * Pop the snapshot, overwriting any mid-task edits. Returns a
   * user-facing status string.
   */
  undo(taskId: string, cwd?: string): string {
    if (!this.isGitRepo(cwd)) return "Not a git repository — cannot undo.";

    const msg = this.snapshotMessages.get(taskId);
    if (!msg) {
      return "No snapshot found for this task. Either no files were modified or it's already been applied.";
    }

    try {
      const idx = this.findStashIndex(msg, cwd);
      if (idx === -1) {
        this.snapshotMessages.delete(taskId);
        return "Snapshot not found in `git stash list` — it may have already been applied or cleared.";
      }

      // Discard mid-task edits, then restore the stashed state.
      execFileSync("git", ["checkout", "--", "."], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });
      execFileSync("git", ["clean", "-fd"], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });
      execFileSync("git", ["stash", "pop", `stash@{${idx}}`], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(cwd ? { cwd } : {}),
      });

      this.snapshotMessages.delete(taskId);
      this.snapshotted.delete(taskId);
      log.info({ taskId }, "git rollback succeeded");
      this.emit("rollback", { taskId, ref: msg, success: true });
      return "All agent changes for this task have been rolled back.";
    } catch (err) {
      log.error({ taskId, err: (err as Error).message }, "git rollback failed");
      this.emit("rollback", { taskId, ref: msg, success: false });
      return `Rollback failed: ${(err as Error).message}`;
    }
  }

  /**
   * Drop the snapshot for a successful task (cleanup). Safe if the
   * stash no longer exists.
   */
  drop(taskId: string, cwd?: string): void {
    const msg = this.snapshotMessages.get(taskId);
    if (!msg) return;
    try {
      const idx = this.findStashIndex(msg, cwd);
      if (idx !== -1) {
        execFileSync("git", ["stash", "drop", `stash@{${idx}}`], {
          stdio: ["pipe", "pipe", "pipe"],
          ...(cwd ? { cwd } : {}),
        });
        log.info({ taskId }, "git snapshot dropped");
      }
    } catch {
      // Non-fatal.
    }
    this.snapshotMessages.delete(taskId);
    this.snapshotted.delete(taskId);
  }

  hasSnapshot(taskId: string): boolean {
    return this.snapshotMessages.has(taskId);
  }

  private findStashIndex(msg: string, cwd?: string): number {
    const out = execFileSync("git", ["stash", "list"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    const lines = out.split("\n").filter(Boolean);
    return lines.findIndex((l) => l.includes(msg));
  }
}

export const gitRollback = new GitRollback();
