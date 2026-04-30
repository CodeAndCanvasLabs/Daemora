/**
 * cronParser -- lightweight cron expression parser.
 *
 * Supports standard 5-field cron: minute hour dom month dow
 * Field syntax: *, N, N-M (range), N,M,... (list), star/N (step),
 * N-M/S (range with step). Day-of-week: 0-7 (0 and 7 = Sunday).
 *
 * No external dependencies. Designed for CronScheduler, not general use.
 */

export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
}

const FIELD_RANGES: readonly { min: number; max: number }[] = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week (0 = Sunday)
];

/**
 * Parse a single cron field into the set of integers it represents.
 */
function parseField(raw: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) {
      throw new Error("Empty sub-expression in cron field: " + raw);
    }

    const slashIdx = trimmed.indexOf("/");
    let step = 1;
    let rangePart = trimmed;

    if (slashIdx !== -1) {
      step = strictInt(trimmed.slice(slashIdx + 1));
      if (step < 1) throw new Error("Step must be >= 1, got " + String(step));
      rangePart = trimmed.slice(0, slashIdx);
    }

    let lo: number;
    let hi: number;

    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [aStr, bStr] = rangePart.split("-");
      lo = strictInt(aStr!);
      hi = strictInt(bStr!);
      if (lo < min || hi > max || lo > hi) {
        throw new Error("Range " + lo + "-" + hi + " out of bounds [" + min + "-" + max + "]");
      }
    } else {
      const val = strictInt(rangePart);
      if (val < min || val > max) {
        throw new Error("Value " + val + " out of bounds [" + min + "-" + max + "]");
      }
      if (slashIdx === -1) {
        result.add(val);
        continue;
      }
      lo = val;
      hi = max;
    }

    for (let v = lo; v <= hi; v += step) {
      result.add(v);
    }
  }

  return result;
}

function strictInt(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    throw new Error("Invalid integer in cron expression: " + s);
  }
  return Number(trimmed);
}

/**
 * Parse a 5-field cron expression into structured field sets.
 * Throws on invalid syntax.
 */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Cron expression must have 5 fields (min hour dom month dow), got " + parts.length + ": " + expression,
    );
  }

  const minutes = parseField(parts[0]!, FIELD_RANGES[0]!.min, FIELD_RANGES[0]!.max);
  const hours = parseField(parts[1]!, FIELD_RANGES[1]!.min, FIELD_RANGES[1]!.max);
  const daysOfMonth = parseField(parts[2]!, FIELD_RANGES[2]!.min, FIELD_RANGES[2]!.max);
  const months = parseField(parts[3]!, FIELD_RANGES[3]!.min, FIELD_RANGES[3]!.max);
  const rawDow = parseField(parts[4]!, 0, 7);

  // Normalise: treat 7 as 0 (Sunday).
  const daysOfWeek = new Set<number>();
  for (const d of rawDow) {
    daysOfWeek.add(d === 7 ? 0 : d);
  }

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Check whether a Date matches a parsed cron expression.
 * Evaluates in the context of the provided timezone (default UTC).
 */
export function cronMatches(fields: CronFields, date: Date, timezone = "UTC"): boolean {
  const localized = toTimezone(date, timezone);
  return (
    fields.minutes.has(localized.minute) &&
    fields.hours.has(localized.hour) &&
    fields.daysOfMonth.has(localized.dayOfMonth) &&
    fields.months.has(localized.month) &&
    fields.daysOfWeek.has(localized.dayOfWeek)
  );
}

/**
 * Compute the next fire time after the given date for the cron fields.
 * Searches minute-by-minute up to 2 years out (safety cap).
 * Returns epoch millis, or undefined if no match found.
 */
export function nextFire(fields: CronFields, after: Date, timezone = "UTC"): number | undefined {
  // Start from the next whole minute after the reference date.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);

  const cap = after.getTime() + 2 * 365 * 24 * 60 * 60_000;

  let cursor = start.getTime();
  while (cursor < cap) {
    const d = new Date(cursor);
    const tz = toTimezone(d, timezone);

    // Fast-forward: skip wrong month.
    if (!fields.months.has(tz.month)) {
      cursor = advanceToNextMonth(cursor, timezone);
      continue;
    }
    // Skip wrong day.
    if (!fields.daysOfMonth.has(tz.dayOfMonth) || !fields.daysOfWeek.has(tz.dayOfWeek)) {
      cursor = advanceToNextDay(cursor);
      continue;
    }
    // Skip wrong hour.
    if (!fields.hours.has(tz.hour)) {
      cursor = advanceToNextHour(cursor);
      continue;
    }
    // Check minute.
    if (fields.minutes.has(tz.minute)) {
      return cursor;
    }
    cursor += 60_000;
  }
  return undefined;
}

// -- Timezone helpers -------------------------------------------------------

interface LocalizedTime {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number; // 1-12
  dayOfWeek: number; // 0-6, 0=Sunday
}

function toTimezone(date: Date, timezone: string): LocalizedTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };

  // Intl hour12:false returns 24 for midnight in some engines -- normalise.
  const rawHour = get("hour");

  return {
    minute: get("minute"),
    hour: rawHour === 24 ? 0 : rawHour,
    dayOfMonth: get("day"),
    month: get("month"),
    dayOfWeek: new Date(
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(date),
    ).getDay(),
  };
}

function advanceToNextMonth(epochMs: number, timezone: string): number {
  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const isoStr = String(nextYear) + "-" + String(nextMonth).padStart(2, "0") + "-01T00:00:00";
  return dateInTimezone(isoStr, timezone);
}

function advanceToNextDay(epochMs: number): number {
  return epochMs + 24 * 60 * 60_000;
}

function advanceToNextHour(epochMs: number): number {
  return epochMs + 60 * 60_000;
}

/**
 * Approximate: create epoch ms for a wall-clock ISO string in the given timezone.
 * Uses a two-pass approach via Intl for reasonable accuracy.
 */
function dateInTimezone(isoNaive: string, timezone: string): number {
  const rough = new Date(isoNaive + "Z").getTime();
  const utcStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(rough));
  const localRough = new Date(utcStr.replace(",", "") + "Z").getTime();
  const offset = localRough - rough;
  return rough - offset;
}
