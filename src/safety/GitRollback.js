import { execSync } from "child_process";
import eventBus from "../core/EventBus.js";

/**
 * Git Rollback - snapshot workspace before agent file writes, enable undo.
 *
 * Before the first write tool (writeFile/editFile/applyPatch) in a task,
 * creates a git stash snapshot. If the user later says "undo", the TaskRunner
 * calls undo(taskId) to restore the snapshot.
 *
 * Only activates if the working directory is inside a git repository.
 * Gracefully no-ops if git is unavailable.
 */

class GitRollback {
  constructor() {
    /** taskId → stash message (used to find stash later) */
    this.snapshots = new Map();
    /** taskId → true if we already snapshotted this task */
    this.snapshotted = new Set();
    this.enabled = true;
  }

  /** Check if cwd is inside a git repo. */
  isGitRepo() {
    try {
      execSync("git rev-parse --git-dir", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a snapshot before the first write in a task.
   * Safe to call multiple times - only snapshots once per task.
   * Returns the stash message used as a key, or null if nothing to snapshot.
   */
  snapshot(taskId) {
    if (!this.enabled || !taskId) return null;
    if (this.snapshotted.has(taskId)) return null; // already done for this task
    if (!this.isGitRepo()) return null;

    try {
      // Check if there are any tracked changes to stash
      const status = execSync("git status --porcelain", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
      if (!status) {
        // No changes - mark as snapshotted so we don't keep trying
        this.snapshotted.add(taskId);
        return null;
      }

      const msg = `daemora-snapshot-${taskId.slice(0, 8)}-${Date.now()}`;
      execSync(`git stash push -m "${msg}" --include-untracked`, { stdio: ["pipe", "pipe", "pipe"] });

      this.snapshotted.add(taskId);
      this.snapshots.set(taskId, msg);

      console.log(`[GitRollback] Snapshot created for task ${taskId.slice(0, 8)}: "${msg}"`);
      eventBus.emitEvent("audit:git_snapshot", { taskId, ref: msg });
      return msg;
    } catch (error) {
      // Don't let rollback failures block the agent
      console.log(`[GitRollback] Snapshot failed (non-fatal): ${error.message}`);
      this.snapshotted.add(taskId); // Don't retry
      return null;
    }
  }

  /**
   * Roll back changes for a task by popping its stash.
   * Returns a human-readable result string.
   */
  undo(taskId) {
    if (!this.isGitRepo()) return "Not a git repository - cannot undo.";

    const stashMsg = this.snapshots.get(taskId);
    if (!stashMsg) {
      return `No snapshot found for this task. Either no files were modified, or the snapshot was already applied.`;
    }

    try {
      // Find the stash index by message
      const stashList = execSync("git stash list", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const lines = stashList.split("\n").filter(Boolean);
      const idx = lines.findIndex((l) => l.includes(stashMsg));

      if (idx === -1) {
        this.snapshots.delete(taskId);
        return `Snapshot not found in git stash list - it may have already been applied or cleared.`;
      }

      // First, discard any uncommitted changes from the agent's work
      execSync("git checkout -- .", { stdio: ["pipe", "pipe", "pipe"] });
      execSync("git clean -fd", { stdio: ["pipe", "pipe", "pipe"] });
      // Restore the stash
      execSync(`git stash pop stash@{${idx}}`, { stdio: ["pipe", "pipe", "pipe"] });

      this.snapshots.delete(taskId);
      this.snapshotted.delete(taskId);

      console.log(`[GitRollback] Rolled back task ${taskId.slice(0, 8)} from stash@{${idx}}`);
      eventBus.emitEvent("audit:git_rollback", { taskId, ref: stashMsg, success: true });
      return `All agent changes for this task have been rolled back.`;
    } catch (error) {
      eventBus.emitEvent("audit:git_rollback", { taskId, ref: stashMsg, success: false });
      return `Rollback failed: ${error.message}`;
    }
  }

  /**
   * Drop the snapshot for a completed task (cleanup).
   * Call this when a task completes successfully and user doesn't need undo.
   */
  dropSnapshot(taskId) {
    if (!this.snapshots.has(taskId)) return;
    const stashMsg = this.snapshots.get(taskId);
    try {
      const stashList = execSync("git stash list", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const lines = stashList.split("\n").filter(Boolean);
      const idx = lines.findIndex((l) => l.includes(stashMsg));
      if (idx !== -1) {
        execSync(`git stash drop stash@{${idx}}`, { stdio: ["pipe", "pipe", "pipe"] });
        console.log(`[GitRollback] Dropped snapshot for completed task ${taskId.slice(0, 8)}`);
      }
    } catch {
      // Non-fatal
    }
    this.snapshots.delete(taskId);
    this.snapshotted.delete(taskId);
  }

  hasSnapshot(taskId) {
    return this.snapshots.has(taskId);
  }
}

const gitRollback = new GitRollback();
export default gitRollback;
