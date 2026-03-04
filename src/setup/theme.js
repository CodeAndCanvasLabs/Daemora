import chalk from "chalk";

/**
 * Daemora CLI Theme
 * Color palette matches the UI exactly:
 *   Cyan   #00d9ff  — primary brand / headings / CTAs
 *   Teal   #4ECDC4  — secondary / commands / accents
 *   Red    #ff4458  — danger / features (matches logo horns)
 *   Green  #00ff88  — success / security / live badges
 *   Amber  #ffaa00  — warning / scheduling / [NEW] badges
 *   Muted  #64748b  — slate-500 body text
 *   Dim    #94a3b8  — slate-400 captions
 */
export const P = {
  cyan:    "#00d9ff",
  teal:    "#4ECDC4",
  red:     "#ff4458",
  green:   "#00ff88",
  amber:   "#ffaa00",
  muted:   "#64748b",
  dim:     "#94a3b8",
  border:  "#1f1f2e",
  // semantic aliases
  get brand()   { return this.cyan; },
  get accent()  { return this.teal; },
  get success() { return this.green; },
  get warning() { return this.amber; },
  get error()   { return this.red; },
};

export const t = {
  brand:   (s) => chalk.hex(P.cyan)(s),
  accent:  (s) => chalk.hex(P.teal)(s),
  success: (s) => chalk.hex(P.green)(s),
  warning: (s) => chalk.hex(P.amber)(s),
  error:   (s) => chalk.hex(P.red)(s),
  muted:   (s) => chalk.hex(P.muted)(s),
  dim:     (s) => chalk.hex(P.dim)(s),
  bold:    (s) => chalk.bold(s),
  h:       (s) => chalk.bold.hex(P.cyan)(s),
  h2:      (s) => chalk.bold.hex(P.teal)(s),
  cmd:     (s) => chalk.hex(P.teal)(s),
  new:     (s) => chalk.hex(P.amber)(s),
};

export const S = {
  check:   chalk.hex(P.green)("✔"),
  cross:   chalk.hex(P.red)("✘"),
  arrow:   chalk.hex(P.cyan)("▸"),
  dot:     chalk.hex(P.muted)("·"),
  bar:     chalk.hex(P.muted)("│"),
  dash:    chalk.hex(P.border)("─"),
  diamond: chalk.hex(P.cyan)("◆"),
  shield:  chalk.hex(P.green)("◈"),
  lock:    chalk.hex(P.amber)("▣"),
  gear:    chalk.hex(P.muted)("○"),
  bolt:    chalk.hex(P.cyan)("●"),
  eye:     chalk.hex(P.red)("◉"),
  star:    chalk.hex(P.amber)("★"),
};

// ─── Gradient helpers ──────────────────────────────────────────────────────

/** Interpolate a single hex colour component */
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

/**
 * Render a string with a left→right cyan→teal gradient.
 * One chalk call per visible character — fast enough for a one-shot banner.
 */
function gradientLine(line) {
  const [cyR, cyG, cyB] = [0x00, 0xd9, 0xff]; // #00d9ff
  const [tlR, tlG, tlB] = [0x4e, 0xcd, 0xc4]; // #4ECDC4
  let out = "";
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const frac = len > 1 ? i / (len - 1) : 0;
    out += chalk.rgb(
      lerp(cyR, tlR, frac),
      lerp(cyG, tlG, frac),
      lerp(cyB, tlB, frac),
    )(line[i]);
  }
  return out;
}

// ─── Banner ────────────────────────────────────────────────────────────────

/**
 * DAEMORA ASCII art — figlet "Doom" font.
 * Width: ~65 chars — fits a standard 80-col terminal.
 */
const DAEMORA_ART = [
  "██████╗  █████╗ ███████╗███╗   ███╗ ██████╗ ██████╗  █████╗ ",
  "██╔══██╗██╔══██╗██╔════╝████╗ ████║██╔═══██╗██╔══██╗██╔══██╗",
  "██║  ██║███████║█████╗  ██╔████╔██║██║   ██║██████╔╝███████║",
  "██║  ██║██╔══██║██╔══╝  ██║╚██╔╝██║██║   ██║██╔══██╗██╔══██║",
  "██████╔╝██║  ██║███████╗██║ ╚═╝ ██║╚██████╔╝██║  ██║██║  ██║",
  "╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
];

/** Logo mark — small demon eye motif drawn with ASCII */
function logoMark() {
  return [
    chalk.hex(P.red)("    ▲               ▲"),
    chalk.hex(P.red)("   ▲ ▲             ▲ ▲"),
    chalk.hex(P.dim)("  ╔═══════════════════╗"),
    chalk.hex(P.dim)("  ║") +
      chalk.hex(P.muted)("  ") +
      chalk.hex(P.red)("◤▬▬▬▬◥") +
      chalk.hex(P.muted)("   ") +
      chalk.hex(P.red)("◤▬▬▬▬◥") +
      chalk.hex(P.muted)("  ") +
      chalk.hex(P.dim)("║"),
    chalk.hex(P.dim)("  ║") +
      chalk.hex(P.muted)("    ") +
      chalk.hex(P.red)("◉") +
      chalk.hex(P.muted)("         ") +
      chalk.hex(P.red)("◉") +
      chalk.hex(P.muted)("    ") +
      chalk.hex(P.dim)("║"),
    chalk.hex(P.dim)("  ╚═══════════════════╝"),
    chalk.hex(P.cyan)("    ◦               ◦"),
  ].join("\n");
}

export function banner() {
  const w = 67;
  const topLine = chalk.hex(P.cyan)("━".repeat(w));
  const botLine = chalk.hex(P.teal)("─".repeat(w));

  console.log("\n" + topLine);
  console.log("");

  // Gradient DAEMORA lettering
  for (const line of DAEMORA_ART) {
    console.log("  " + gradientLine(line));
  }

  console.log("");
  console.log(
    "  " +
    chalk.hex(P.muted)("           ") +
    chalk.hex(P.cyan)("◉") +
    chalk.hex(P.dim)("       Your 24/7 AI Agent       ") +
    chalk.hex(P.red)("◉"),
  );
  console.log(botLine);
  console.log("");
}

// ─── Step header (progress bar) ────────────────────────────────────────────

export function stepHeader(current, total, title) {
  const filled = Math.round((current / total) * 22);
  const empty  = 22 - filled;
  const bar =
    chalk.hex(P.cyan)("█".repeat(filled)) +
    chalk.hex(P.border)("░".repeat(empty));
  const label = chalk.hex(P.muted)(`[${current}/${total}]`);
  const w = 67;
  const line = chalk.hex(P.border)("─".repeat(w));
  console.log(`\n${line}`);
  console.log(`  ${bar}  ${label}  ${chalk.bold.hex(P.teal)(title)}`);
  console.log(`${line}\n`);
}

// ─── Key/value row ─────────────────────────────────────────────────────────

export function kv(key, value) {
  console.log(`  ${S.bar}  ${t.muted(key)}  ${value}`);
}

// ─── Summary table ─────────────────────────────────────────────────────────

export function summaryTable(title, rows) {
  const maxKey = Math.max(...rows.map(([k]) => k.length), 10);
  const w = maxKey + 34;
  const topLine = chalk.hex(P.cyan)("━".repeat(w));
  const rowLine = chalk.hex(P.border)("─".repeat(w));
  console.log(`\n  ${chalk.bold.hex(P.cyan)(title)}`);
  console.log(`  ${topLine}`);
  for (const [key, val] of rows) {
    const k = t.muted(key.padEnd(maxKey));
    console.log(`  ${S.bar}  ${k}  ${val}`);
  }
  console.log(`  ${rowLine}`);
}

// ─── Complete banner ────────────────────────────────────────────────────────

export function completeBanner(lines) {
  const w = 67;
  const line = chalk.hex(P.green)("━".repeat(w));
  console.log(`\n${line}`);
  console.log(`  ${S.check}  ${chalk.bold.hex(P.green)("Setup Complete")}`);
  console.log(`  ${chalk.hex(P.dim)("─".repeat(w - 2))}`);
  console.log("");
  for (const l of lines) {
    console.log(`  ${l}`);
  }
  console.log(`${line}\n`);
}

// ─── Section header (for info commands) ────────────────────────────────────

export function sectionHeader(title, subtitle = "") {
  const w = 67;
  const topLine = chalk.hex(P.cyan)("━".repeat(w));
  const botLine = chalk.hex(P.border)("─".repeat(w));
  console.log(`\n${topLine}`);
  const sub = subtitle ? `  ${chalk.hex(P.muted)(subtitle)}` : "";
  console.log(`  ${chalk.bold.hex(P.cyan)(title)}${sub}`);
  console.log(`${botLine}`);
}
