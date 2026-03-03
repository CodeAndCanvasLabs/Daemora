import chalk from "chalk";

/**
 * Daemora CLI Theme - professional color palette and symbols.
 * No emojis. Clean Unicode symbols only.
 */

const P = {
  brand:   "#7C6AFF",
  accent:  "#4ECDC4",
  success: "#2ECC71",
  warning: "#F1C40F",
  error:   "#E74C3C",
  muted:   "#7F8C8D",
  info:    "#3498DB",
  dim:     "#555E68",
};

export const t = {
  brand:   (s) => chalk.hex(P.brand)(s),
  accent:  (s) => chalk.hex(P.accent)(s),
  success: (s) => chalk.hex(P.success)(s),
  warning: (s) => chalk.hex(P.warning)(s),
  error:   (s) => chalk.hex(P.error)(s),
  muted:   (s) => chalk.hex(P.muted)(s),
  info:    (s) => chalk.hex(P.info)(s),
  dim:     (s) => chalk.hex(P.dim)(s),
  bold:    (s) => chalk.bold(s),
  h:       (s) => chalk.bold.hex(P.brand)(s),
  cmd:     (s) => chalk.hex(P.accent)(s),
};

export const S = {
  check:   chalk.hex(P.success)("\u2714"),
  cross:   chalk.hex(P.error)("\u2718"),
  arrow:   chalk.hex(P.brand)("\u25B8"),
  dot:     chalk.hex(P.muted)("\u00B7"),
  bar:     chalk.hex(P.dim)("\u2502"),
  dash:    chalk.hex(P.dim)("\u2500"),
  diamond: chalk.hex(P.brand)("\u25C6"),
  shield:  chalk.hex(P.success)("\u25C8"),
  lock:    chalk.hex(P.warning)("\u25A3"),
  gear:    chalk.hex(P.muted)("\u25CB"),
  bolt:    chalk.hex(P.warning)("\u25CF"),
};

export function banner() {
  const w = 56;
  const line = chalk.hex(P.brand)("\u2501".repeat(w));
  const dimLine = chalk.hex(P.dim)("\u2500".repeat(w));
  console.log("");
  console.log(line);
  console.log("");
  console.log(chalk.bold.hex(P.brand)(
    "      \u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588"
  ));
  console.log(chalk.bold.hex(P.brand)(
    "      \u2588\u2588   \u2588\u2588 \u2588\u2588       \u2588\u2588       \u2588\u2588 \u2588\u2588"
  ));
  console.log(chalk.bold.hex(P.brand)(
    "      \u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588\u2588\u2588\u2588\u2588    \u2588\u2588  \u2588\u2588\u2588 \u2588\u2588  \u2588\u2588\u2588\u2588\u2588"
  ));
  console.log(chalk.bold.hex(P.brand)(
    "      \u2588\u2588   \u2588\u2588 \u2588\u2588       \u2588\u2588   \u2588\u2588 \u2588\u2588      \u2588\u2588"
  ));
  console.log(chalk.bold.hex(P.brand)(
    "      \u2588\u2588   \u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588\u2588\u2588\u2588\u2588  \u2588\u2588 \u2588\u2588\u2588\u2588\u2588\u2588"
  ));
  console.log("");
  console.log(chalk.hex(P.muted)("           Your 24/7 AI Digital Worker"));
  console.log(dimLine);
  console.log("");
}

export function stepHeader(current, total, title) {
  const filled = Math.round((current / total) * 20);
  const empty = 20 - filled;
  const bar = chalk.hex(P.brand)("\u2588".repeat(filled)) + chalk.hex(P.dim)("\u2591".repeat(empty));
  const label = chalk.hex(P.dim)(`[${current}/${total}]`);
  console.log(`\n  ${bar}  ${label}  ${chalk.bold(title)}\n`);
}

export function kv(key, value) {
  console.log(`  ${S.bar}  ${t.muted(key)}  ${value}`);
}

export function summaryTable(title, rows) {
  const maxKey = Math.max(...rows.map(([k]) => k.length), 10);
  const w = maxKey + 30;
  const line = chalk.hex(P.dim)("\u2500".repeat(w));
  console.log(`\n  ${t.h(title)}`);
  console.log(`  ${line}`);
  for (const [key, val] of rows) {
    const k = t.muted(key.padEnd(maxKey));
    console.log(`  ${S.bar}  ${k}  ${val}`);
  }
  console.log(`  ${line}`);
}

export function completeBanner(lines) {
  const w = 56;
  const line = chalk.hex(P.success)("\u2501".repeat(w));
  console.log(`\n${line}`);
  console.log(`  ${S.check}  ${chalk.bold.hex(P.success)("Setup Complete")}`);
  console.log("");
  for (const l of lines) {
    console.log(`  ${l}`);
  }
  console.log(`${line}\n`);
}
