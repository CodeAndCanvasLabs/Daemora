/**
 * WikiLog — append-only event log for the agent's wiki memory.
 *
 * The log is the raw record. Pages under data/wiki/{projects,people,topics,
 * decisions}/ are the synthesis the agent (or an idle maintenance turn)
 * builds on top of these entries.
 *
 * Anything that should affect the wiki — facts the agent saved, gallery
 * project changes, decisions made — gets one line here. The agent reads
 * the log tail when it needs to update pages.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PREAMBLE = `# Wiki Log

Append-only record. Each line is one event the wiki may need to reflect.
Format: <iso-timestamp> <kind> key="value" key="value"
`;

const INDEX_PREAMBLE = `# Wiki Index

Table of contents for data/wiki/. One line per page, kept in sync as pages
are added or removed. Pages live under projects/, people/, topics/, and
decisions/ — read this file first, then follow the link to the right page.
`;

export class WikiLog {
  private readonly root: string;
  private readonly logPath: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "wiki");
    this.logPath = join(this.root, "log.md");
    this.ensureSkeleton();
  }

  /** Created on first call. Idempotent. */
  private ensureSkeleton(): void {
    mkdirSync(this.root, { recursive: true });
    for (const sub of ["projects", "people", "topics", "decisions"]) {
      mkdirSync(join(this.root, sub), { recursive: true });
    }
    if (!existsSync(this.logPath)) {
      writeFileSync(this.logPath, LOG_PREAMBLE, "utf-8");
    }
    const indexPath = join(this.root, "index.md");
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, INDEX_PREAMBLE, "utf-8");
    }
  }

  /**
   * Append one event line. POSIX guarantees that small (<PIPE_BUF, ~4KB)
   * append() calls are atomic across processes — fine for our line sizes.
   */
  append(kind: string, attrs: Record<string, string | number | undefined | null> = {}): void {
    const ts = new Date().toISOString();
    const parts: string[] = [ts, kind];
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      const escaped = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, "\\n");
      parts.push(`${k}="${escaped}"`);
    }
    appendFileSync(this.logPath, parts.join(" ") + "\n", "utf-8");
  }

  get rootPath(): string {
    return this.root;
  }
}
