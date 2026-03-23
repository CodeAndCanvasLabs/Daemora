/**
 * SchedulePicker — visual schedule builder for non-technical users.
 *
 * Three modes:
 *   1. Once — calendar date picker + time picker + timezone
 *   2. Recurring — frequency (hourly/daily/weekly/monthly) + visual pickers
 *   3. Advanced — raw cron expression for power users
 *
 * Outputs: { cronExpression?, every?, at?, timezone? }
 * All formats the backend already supports — no backend changes needed.
 */

import { useState, useEffect } from "react";
import { Calendar } from "./ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Button } from "./ui/button";
import { CalendarIcon, Clock, Repeat, Terminal } from "lucide-react";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScheduleValue {
  cronExpression?: string;
  every?: string;
  at?: string;
  timezone?: string;
}

interface SchedulePickerProps {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  showOnce?: boolean;      // show "Once" tab (default true for scheduler, false for goals)
  defaultMode?: "once" | "recurring" | "advanced";
  className?: string;
}

// ── Common Timezones ────────────────────────────────────────────────────────

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// ── Day names ───────────────────────────────────────────────────────────────

const DAYS = [
  { label: "Mon", value: 1 },
  { label: "Tue", value: 2 },
  { label: "Wed", value: 3 },
  { label: "Thu", value: 4 },
  { label: "Fri", value: 5 },
  { label: "Sat", value: 6 },
  { label: "Sun", value: 0 },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function detectUserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Component ───────────────────────────────────────────────────────────────

export function SchedulePicker({ value, onChange, showOnce = true, defaultMode = "recurring", className }: SchedulePickerProps) {
  const [mode, setMode] = useState<"once" | "recurring" | "advanced">(defaultMode);
  const [frequency, setFrequency] = useState<"hourly" | "daily" | "weekly" | "monthly">("daily");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined);
  const [time, setTime] = useState("09:00");
  const [timezone, setTimezone] = useState(value.timezone || detectUserTimezone());
  const [selectedDays, setSelectedDays] = useState<number[]>([1]); // Monday
  const [monthDay, setMonthDay] = useState("1");
  const [intervalValue, setIntervalValue] = useState("4");
  const [intervalUnit, setIntervalUnit] = useState("h");
  const [customCron, setCustomCron] = useState(value.cronExpression || "");

  // Initialize from existing value
  useEffect(() => {
    if (value.at) {
      setMode("once");
      try {
        const d = new Date(value.at);
        setSelectedDate(d);
        setTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
      } catch {}
    } else if (value.every) {
      setMode("recurring");
      setFrequency("hourly");
      const match = value.every.match(/^(\d+)(s|m|h|d)$/);
      if (match) {
        setIntervalValue(match[1]);
        setIntervalUnit(match[2]);
      }
    } else if (value.cronExpression) {
      // Try to parse cron into visual mode
      const parsed = parseCronToVisual(value.cronExpression);
      if (parsed) {
        setMode("recurring");
        setFrequency(parsed.frequency);
        if (parsed.time) setTime(parsed.time);
        if (parsed.days) setSelectedDays(parsed.days);
        if (parsed.monthDay) setMonthDay(parsed.monthDay);
      } else {
        setMode("advanced");
        setCustomCron(value.cronExpression);
      }
    }
    if (value.timezone) setTimezone(value.timezone);
  }, []);

  // Emit changes
  useEffect(() => {
    const result: ScheduleValue = { timezone };

    if (mode === "once" && selectedDate) {
      const [h, m] = time.split(":").map(Number);
      const d = new Date(selectedDate);
      d.setHours(h || 0, m || 0, 0, 0);
      result.at = d.toISOString();
    } else if (mode === "recurring") {
      if (frequency === "hourly") {
        result.every = `${intervalValue}${intervalUnit}`;
      } else if (frequency === "daily") {
        const [h, m] = time.split(":").map(Number);
        result.cronExpression = `${m || 0} ${h || 9} * * *`;
      } else if (frequency === "weekly") {
        const [h, m] = time.split(":").map(Number);
        const dayStr = selectedDays.sort().join(",");
        result.cronExpression = `${m || 0} ${h || 9} * * ${dayStr || "1"}`;
      } else if (frequency === "monthly") {
        const [h, m] = time.split(":").map(Number);
        result.cronExpression = `${m || 0} ${h || 9} ${monthDay || "1"} * *`;
      }
    } else if (mode === "advanced") {
      result.cronExpression = customCron;
    }

    onChange(result);
  }, [mode, frequency, selectedDate, time, timezone, selectedDays, monthDay, intervalValue, intervalUnit, customCron]);

  return (
    <div className={`space-y-3 ${className || ""}`}>
      {/* Mode tabs */}
      <div className="flex gap-1 p-1 bg-slate-800/50 rounded-lg">
        {showOnce && (
          <button onClick={() => setMode("once")} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${mode === "once" ? "bg-[#00d9ff]/20 text-[#00d9ff]" : "text-gray-400 hover:text-white"}`}>
            <CalendarIcon className="w-3.5 h-3.5" /> Once
          </button>
        )}
        <button onClick={() => setMode("recurring")} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${mode === "recurring" ? "bg-[#00d9ff]/20 text-[#00d9ff]" : "text-gray-400 hover:text-white"}`}>
          <Repeat className="w-3.5 h-3.5" /> Recurring
        </button>
        <button onClick={() => setMode("advanced")} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${mode === "advanced" ? "bg-[#00d9ff]/20 text-[#00d9ff]" : "text-gray-400 hover:text-white"}`}>
          <Terminal className="w-3.5 h-3.5" /> Advanced
        </button>
      </div>

      {/* ── Once mode ──────────────────────────────────────────────────── */}
      {mode === "once" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Date picker */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal bg-slate-800 border-slate-700 text-white hover:bg-slate-700">
                    <CalendarIcon className="mr-2 h-4 w-4 text-gray-400" />
                    {selectedDate ? formatDate(selectedDate) : "Pick a date"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 bg-slate-900 border-slate-700" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={setSelectedDate}
                    disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* Time picker */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Time</label>
              <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="bg-slate-800 border-slate-700 text-white" />
            </div>
          </div>

          {/* Timezone */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                {COMMON_TIMEZONES.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedDate && (
            <p className="text-[10px] text-[#00d9ff]">Will run on {formatDate(selectedDate)} at {time} ({timezone})</p>
          )}
        </div>
      )}

      {/* ── Recurring mode ─────────────────────────────────────────────── */}
      {mode === "recurring" && (
        <div className="space-y-3">
          {/* Frequency selector */}
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Frequency</label>
            <div className="grid grid-cols-4 gap-1">
              {(["hourly", "daily", "weekly", "monthly"] as const).map(f => (
                <button key={f} onClick={() => setFrequency(f)} className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${frequency === f ? "bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30" : "bg-slate-800 text-gray-400 border border-slate-700 hover:text-white"}`}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Hourly — interval picker */}
          {frequency === "hourly" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Every</span>
              <Input type="number" min="1" max="720" value={intervalValue} onChange={e => setIntervalValue(e.target.value)} className="w-20 bg-slate-800 border-slate-700 text-white text-center" />
              <Select value={intervalUnit} onValueChange={setIntervalUnit}>
                <SelectTrigger className="w-28 bg-slate-800 border-slate-700 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="m">minutes</SelectItem>
                  <SelectItem value="h">hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Daily — time picker */}
          {frequency === "daily" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">At</label>
                <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="bg-slate-800 border-slate-700 text-white" />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                    {COMMON_TIMEZONES.map(tz => (
                      <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Weekly — day checkboxes + time */}
          {frequency === "weekly" && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 mb-1 block">Days</label>
                <div className="flex gap-1">
                  {DAYS.map(d => (
                    <button key={d.value} onClick={() => {
                      setSelectedDays(prev => prev.includes(d.value) ? prev.filter(v => v !== d.value) : [...prev, d.value]);
                    }} className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${selectedDays.includes(d.value) ? "bg-[#00d9ff]/20 text-[#00d9ff] border border-[#00d9ff]/30" : "bg-slate-800 text-gray-400 border border-slate-700 hover:text-white"}`}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">At</label>
                  <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="bg-slate-800 border-slate-700 text-white" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                      {COMMON_TIMEZONES.map(tz => (
                        <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Monthly — day of month + time */}
          {frequency === "monthly" && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Day of month</label>
                  <Select value={monthDay} onValueChange={setMonthDay}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                      {Array.from({ length: 28 }, (_, i) => (
                        <SelectItem key={i + 1} value={String(i + 1)}>{ordinal(i + 1)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">At</label>
                  <Input type="time" value={time} onChange={e => setTime(e.target.value)} className="bg-slate-800 border-slate-700 text-white" />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
                  <Select value={timezone} onValueChange={setTimezone}>
                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                      {COMMON_TIMEZONES.map(tz => (
                        <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          {/* Human-readable summary */}
          <p className="text-[10px] text-[#00d9ff]">{describeSchedule(mode, frequency, time, timezone, selectedDays, monthDay, intervalValue, intervalUnit)}</p>
        </div>
      )}

      {/* ── Advanced mode ──────────────────────────────────────────────── */}
      {mode === "advanced" && (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Cron Expression</label>
            <Input value={customCron} onChange={e => setCustomCron(e.target.value)} className="bg-slate-800 border-slate-700 text-white font-mono" placeholder="0 9 * * *" />
            <p className="text-[10px] text-gray-500 mt-1">Format: minute hour day month weekday — e.g. "0 9 * * 1-5" = weekdays at 9am</p>
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Timezone</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700 max-h-48">
                {COMMON_TIMEZONES.map(tz => (
                  <SelectItem key={tz} value={tz}>{tz.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Utilities ────────────────────────────────────────────────────────────────

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function describeSchedule(
  mode: string, frequency: string, time: string, timezone: string,
  days: number[], monthDay: string, intervalVal: string, intervalUnit: string
): string {
  if (mode !== "recurring") return "";
  const tzShort = timezone.split("/").pop()?.replace(/_/g, " ") || timezone;
  if (frequency === "hourly") return `Every ${intervalVal} ${intervalUnit === "m" ? "minute" : "hour"}${Number(intervalVal) > 1 ? "s" : ""}`;
  if (frequency === "daily") return `Every day at ${time} (${tzShort})`;
  if (frequency === "weekly") {
    const dayNames = days.sort().map(d => DAYS.find(dd => dd.value === d)?.label).filter(Boolean);
    return `Every ${dayNames.join(", ")} at ${time} (${tzShort})`;
  }
  if (frequency === "monthly") return `${ordinal(Number(monthDay))} of every month at ${time} (${tzShort})`;
  return "";
}

function parseCronToVisual(cron: string): { frequency: "hourly" | "daily" | "weekly" | "monthly"; time?: string; days?: number[]; monthDay?: string } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;

  // Daily: "M H * * *"
  if (dom === "*" && dow === "*" && !min.includes("/") && !hour.includes("/")) {
    return { frequency: "daily", time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}` };
  }

  // Weekly: "M H * * 1,3,5"
  if (dom === "*" && dow !== "*" && !min.includes("/") && !hour.includes("/")) {
    const days = dow.split(",").map(Number).filter(n => !isNaN(n));
    return { frequency: "weekly", time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`, days };
  }

  // Monthly: "M H D * *"
  if (dom !== "*" && dow === "*" && !min.includes("/") && !hour.includes("/")) {
    return { frequency: "monthly", time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`, monthDay: dom };
  }

  return null;
}
