/**
 * Daemora ASCII banner — printed at the top of `setup` and `start`.
 *
 * Raw ANSI escape codes (no chalk dep). Falls back to plain text when the
 * stream isn't a TTY (piped output, CI, log files), so logs stay greppable.
 */

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  brightCyan: "\x1b[96m",
  magenta: "\x1b[35m",
  brightMagenta: "\x1b[95m",
  gray: "\x1b[90m",
} as const;

const LINES: readonly string[] = [
  "  ____                                       ",
  " |  _ \\  __ _  ___ _ __ ___   ___  _ __ __ _ ",
  " | | | |/ _` |/ _ \\ '_ ` _ \\ / _ \\| '__/ _` |",
  " | |_| | (_| |  __/ | | | | | (_) | | | (_| |",
  " |____/ \\__,_|\\___|_| |_| |_|\\___/|_|  \\__,_|",
];

export function renderBanner(opts: { tagline?: string; version?: string } = {}): string {
  const tty = process.stdout.isTTY;
  if (!tty) {
    // Plain banner for non-TTY (CI, piped, journalctl)
    const v = opts.version ? ` v${opts.version}` : "";
    return `Daemora${v}\n${opts.tagline ?? ""}\n`;
  }

  const out: string[] = [""];
  for (const line of LINES) out.push(`${ANSI.brightCyan}${line}${ANSI.reset}`);
  out.push("");
  if (opts.tagline) {
    out.push(`     ${ANSI.dim}${opts.tagline}${ANSI.reset}`);
  }
  if (opts.version) {
    out.push(`     ${ANSI.gray}v${opts.version}${ANSI.reset}`);
  }
  out.push("");
  return out.join("\n");
}

export function printBanner(opts: { tagline?: string; version?: string } = {}): void {
  process.stdout.write(renderBanner(opts));
}
