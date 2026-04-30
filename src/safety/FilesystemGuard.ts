/**
 * FilesystemGuard — central policy point for filesystem access.
 *
 * Every FS tool (read_file, write_file, edit_file, list_directory) and
 * every shell command (execute_command) routes through this guard. It
 * does one job: answer "is this path allowed for this kind of access?"
 *
 * Design principles
 * -----------------
 *  1. Path normalisation is centralised. Tools pass whatever the LLM
 *     gave us; the guard resolves, absolutises, and canonicalises (via
 *     realpath when the target exists, lexical otherwise) before any
 *     comparison. This closes the `../../../etc/shadow` family of bugs.
 *
 *  2. Symlinks are resolved. If `/tmp/x -> /etc/shadow`, writing to
 *     `/tmp/x` is treated as writing to `/etc/shadow` and denied.
 *
 *  3. Denylist > allowlist. By default we run in "moderate" mode — most
 *     of the disk is allowed (the user ASKED the agent to work on their
 *     files), but a curated set of sensitive directories is hard-denied
 *     for both reads and writes. Strict mode tightens this to "nothing
 *     outside $HOME + $WORKSPACE_ROOT".
 *
 *  4. Tools call `ensureAllowed(path, mode)` and get a canonical
 *     resolved path back. They MUST use that returned path for the
 *     actual fs call — otherwise a symlink swap between check and use
 *     re-introduces the race we're closing.
 *
 *  5. Every denial throws `BlockedActionError` with a stable reason code
 *     so the UI can surface WHY (and so tests can assert on it).
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { BlockedActionError } from "../util/errors.js";

export type FsAccess = "read" | "write" | "execute";

const ALL_ACCESS: readonly FsAccess[] = ["read", "write", "execute"];

/**
 * Guard modes, in order of strictness:
 *   off       — no checks. Escape hatch for trusted environments.
 *   moderate  — denylist of sensitive dirs (.ssh, .aws, /etc, ...) + Daemora's
 *               own data dir is read-blocked. Default for general use.
 *   strict    — only $HOME + extraAllow roots are reachable.
 *   sandbox   — only extraAllow roots are reachable. $HOME is NOT auto-included.
 *               Use this to confine the agent to a specific project directory.
 */
export type FsGuardMode = "off" | "moderate" | "strict" | "sandbox";

export interface FilesystemGuardOptions {
  readonly mode?: FsGuardMode;
  /** Extra directories the agent is always allowed to touch. */
  readonly extraAllow?: readonly string[];
  /** Extra directories the agent is never allowed to touch. */
  readonly extraDeny?: readonly string[];
  /** Daemora's own data dir (vault DB, embeddings). Agent should NOT write here. */
  readonly dataDir?: string;
}

/**
 * Baseline denied-for-write paths across all modes. These contain
 * secrets or OS-level config an agent has no business mutating.
 * Reads are permitted by default but individual paths can override.
 */
const SENSITIVE_DIRS = (home: string): readonly { path: string; access: readonly FsAccess[] }[] => [
  // OS
  { path: "/etc",          access: ["write"] },
  { path: "/System",       access: ["read", "write", "execute"] },
  { path: "/private/etc",  access: ["write"] },
  { path: "/Library/LaunchDaemons", access: ["write", "execute"] },
  // User secrets — both read AND write blocked
  { path: `${home}/.ssh`,   access: ["read", "write"] },
  { path: `${home}/.aws`,   access: ["read", "write"] },
  { path: `${home}/.gnupg`, access: ["read", "write"] },
  { path: `${home}/.config/gcloud`, access: ["read", "write"] },
  { path: `${home}/.netrc`, access: ["read", "write"] },
  { path: `${home}/.kube`,  access: ["read", "write"] },
];

export class FilesystemGuard {
  // These are mutated by `update()` so a live guard can be reconfigured
  // (via PUT /api/security/fs) without restarting the server. Tools hold
  // a reference to this instance, so mutating in place beats rebuilding.
  private mode: FsGuardMode;
  private readonly home: string;
  private allow: readonly string[];
  private deny: readonly { path: string; access: readonly FsAccess[] }[];
  private readonly dataDir: string | undefined;

  constructor(opts: FilesystemGuardOptions = {}) {
    this.mode = opts.mode ?? "moderate";
    this.home = homedir();
    this.dataDir = opts.dataDir;

    // strict  → $HOME + extras are the only reachable roots.
    // sandbox → ONLY extras are reachable ($HOME is NOT auto-allowed). Use
    //           this to confine the agent to a specific project directory.
    if (this.mode === "strict") {
      const strictRoots = [this.home, ...(opts.extraAllow ?? [])];
      this.allow = strictRoots.map((p) => normaliseLexical(p));
    } else if (this.mode === "sandbox") {
      // Always include the data dir so the agent can write its own state
      // (memory, costs, audit). Without this, every write would 403.
      const sandboxRoots = [...(opts.extraAllow ?? [])];
      if (opts.dataDir) sandboxRoots.push(opts.dataDir);
      this.allow = sandboxRoots.map((p) => normaliseLexical(p));
    } else {
      this.allow = [];
    }

    const baseDeny = SENSITIVE_DIRS(this.home);
    const extraDeny = (opts.extraDeny ?? []).map((p) => ({
      path: p,
      access: ["read", "write", "execute"] as const,
    }));
    this.deny = [...baseDeny, ...extraDeny];
  }

  /**
   * Throws BlockedActionError if the access is not permitted. Returns
   * the CANONICAL path the caller should use for the actual syscall —
   * tools MUST use this (not the caller-supplied path) to close the
   * symlink-swap race.
   */
  ensureAllowed(rawPath: string, access: FsAccess): string {
    if (this.mode === "off") return absolute(rawPath);

    const target = absolute(rawPath);
    const canonical = canonicalise(target);

    // 1a) (Removed.) Previously this block denied ALL writes anywhere
    //    under dataDir. Too aggressive — agents are explicitly told to
    //    write journal entries, research files, generated artifacts,
    //    etc. into `data/journal/`, `data/research/`, `data/artifacts/`.
    //    The actually-sensitive files (vault, sqlite database, salt)
    //    are protected by the targeted rule below (1b), which catches
    //    them by suffix regardless of subpath.

    // 1b) Block ALL access (read OR write) to Daemora's own SQLite
    //    database + WAL / SHM sidecar files. Even reading is off-limits
    //    — the DB holds vault blobs, session history, memory rows. An
    //    agent that could open it raw would trivially exfiltrate every
    //    secret the user ever stored. The file-tool paths (read_file,
    //    execute_command, grep, etc.) all route through ensureAllowed,
    //    so this one check covers every pathway.
    if (this.dataDir) {
      const dataCanon = canonicalise(this.dataDir);
      const looksLikeOurDb =
        canonical === dataCanon ||
        canonical.startsWith(dataCanon + sep);
      if (looksLikeOurDb) {
        const base = canonical.slice(dataCanon.length + 1);
        if (/\.(?:db|sqlite)(?:-wal|-shm|-journal)?$/i.test(base) || base.endsWith(".vault.enc") || base.endsWith(".vault.salt")) {
          throw new BlockedActionError(
            `Access to Daemora's own database / vault files denied: ${canonical}`,
            { rawPath, canonical, reason: "self_db_access" },
          );
        }
      }
    }

    // 2) Check denylist (applies to both canonical AND pre-realpath
    //    target — so a symlink pointing INTO a denied dir is caught).
    for (const rule of this.deny) {
      if (!rule.access.includes(access)) continue;
      const denyCanon = canonicalise(rule.path);
      const hitsTarget = target === denyCanon || target.startsWith(denyCanon + sep);
      const hitsCanonical = canonical === denyCanon || canonical.startsWith(denyCanon + sep);
      if (hitsTarget || hitsCanonical) {
        throw new BlockedActionError(
          `${access} denied for sensitive path: ${rule.path}`,
          { rawPath, canonical, reason: "sensitive_path", rule: rule.path },
        );
      }
    }

    // 3) Strict / sandbox mode: require hit in allowlist.
    if (this.mode === "strict" || this.mode === "sandbox") {
      const inAllow = this.allow.some(
        (root) => canonical === root || canonical.startsWith(root + sep),
      );
      if (!inAllow) {
        throw new BlockedActionError(
          `${access} outside allowed roots: ${canonical}`,
          { rawPath, canonical, reason: "outside_allowlist", mode: this.mode, allow: this.allow },
        );
      }
    }

    return canonical;
  }

  /**
   * Best-effort scan of a shell command for absolute paths and
   * enforce the deny rules on any we find. Not a sandbox — just a
   * defence-in-depth layer so a model that convinces itself to run
   * `cat /etc/shadow` still gets blocked at the tool boundary.
   *
   * We look for tokens that begin with `/` (POSIX absolute) OR with a
   * drive letter (Windows absolute). We check them for "execute"
   * denial (covers the whole deny set on macOS/Linux for this use).
   */
  ensureCommandAllowed(command: string): void {
    if (this.mode === "off") return;
    const paths = extractAbsolutePaths(command);
    for (const p of paths) {
      // A shell command can touch a path in any way (read, write,
      // execute). We don't know which ahead of parsing the whole
      // command line, so we probe ALL three access kinds and refuse
      // the command if ANY of them is denied.
      for (const access of ALL_ACCESS) {
        try {
          this.ensureAllowed(p, access);
        } catch (e) {
          if (e instanceof BlockedActionError) {
            throw new BlockedActionError(
              `Command references a blocked path: ${p}`,
              {
                rawPath: p,
                command,
                reason: "command_path_blocked",
                deniedAccess: access,
                innerReason: e.context["reason"],
              },
            );
          }
          throw e;
        }
      }
    }
  }

  /** Public inspect so /api/config and tests can see what's configured. */
  describe(): {
    mode: FsGuardMode;
    allow: readonly string[];
    deny: readonly { path: string; access: readonly FsAccess[] }[];
    dataDir: string | undefined;
  } {
    return { mode: this.mode, allow: this.allow, deny: this.deny, dataDir: this.dataDir };
  }

  /**
   * Hot-reconfigure. Used by PUT /api/security/fs so users can change the
   * guard from the UI without restarting the server. Same constructor logic
   * as the original setup, applied to `this` in place.
   */
  update(opts: Pick<FilesystemGuardOptions, "mode" | "extraAllow" | "extraDeny">): void {
    if (opts.mode) this.mode = opts.mode;

    if (this.mode === "strict") {
      const strictRoots = [this.home, ...(opts.extraAllow ?? [])];
      this.allow = strictRoots.map((p) => normaliseLexical(p));
    } else if (this.mode === "sandbox") {
      const sandboxRoots = [...(opts.extraAllow ?? [])];
      if (this.dataDir) sandboxRoots.push(this.dataDir);
      this.allow = sandboxRoots.map((p) => normaliseLexical(p));
    } else {
      this.allow = [];
    }

    const baseDeny = SENSITIVE_DIRS(this.home);
    const extraDeny = (opts.extraDeny ?? []).map((p) => ({
      path: p,
      access: ["read", "write", "execute"] as const,
    }));
    this.deny = [...baseDeny, ...extraDeny];
  }
}

function absolute(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}

/** Pure path collapse (no fs). Handles `..`, `.`, trailing `/`. */
function normaliseLexical(p: string): string {
  return resolve(p);
}

/**
 * Realpath where the target exists, lexical otherwise. We want the
 * canonical form when we CAN get it so symlink tricks are closed, but
 * we must still work for writes to new files (target doesn't exist yet
 * — the parent dir might though). Strategy: realpath the deepest
 * ancestor that exists, then rejoin the missing tail.
 */
function canonicalise(p: string): string {
  const abs = absolute(p);
  try {
    return realpathSync(abs);
  } catch {
    // Fall through to ancestor-walk.
  }
  const parts = abs.split(sep);
  for (let i = parts.length; i > 0; i--) {
    const probe = parts.slice(0, i).join(sep) || sep;
    try {
      statSync(probe);
      const real = realpathSync(probe);
      const tail = parts.slice(i).join(sep);
      return tail ? `${real}${sep}${tail}` : real;
    } catch { /* keep walking up */ }
  }
  return abs;
}

/**
 * Extract absolute paths from a shell command. Matches POSIX `/…` and
 * Windows `C:\…`. Handles quotes so `rm "/etc/shadow"` still gets
 * picked up. This isn't a parser — it's a belt-and-suspenders lint.
 */
function extractAbsolutePaths(cmd: string): readonly string[] {
  const hits: string[] = [];
  // POSIX: a slash preceded by start/whitespace/quote, continuing to next whitespace/quote/end
  const posix = /(?:^|[\s"'`(])(\/[^\s"'`)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = posix.exec(cmd)) !== null) hits.push(m[1]!);
  // Windows absolute: C:\foo or C:/foo
  const win = /(?:^|[\s"'`(])([A-Za-z]:[\\\/][^\s"'`)]+)/g;
  while ((m = win.exec(cmd)) !== null) hits.push(m[1]!);
  return hits;
}
