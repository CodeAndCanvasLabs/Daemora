/**
 * calendar - Read and create calendar events.
 * macOS: AppleScript (Calendar app). Google Calendar: Google Calendar API.
 * Supports: list upcoming events, create event, delete event.
 */
import { execSync } from "node:child_process";

export async function calendar(action, paramsJson) {
  if (!action) return "Error: action required. Valid: list, create, delete, search";
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  const { provider = "macos" } = params;

  // ── macOS Calendar (AppleScript) ────────────────────────────────────────
  if (provider === "macos") {
    if (process.platform !== "darwin") {
      return "Error: macOS Calendar provider only works on macOS";
    }

    if (action === "list") {
      const days = params.days || 7;
      const script = `
        tell application "Calendar"
          set startDate to current date
          set endDate to (current date) + (${days} * days)
          set eventList to ""
          set theCalendars to every calendar
          repeat with aCal in theCalendars
            set theEvents to (every event of aCal whose start date >= startDate and start date <= endDate)
            repeat with anEvent in theEvents
              set eventList to eventList & summary of anEvent & " | " & (start date of anEvent as string) & "\\n"
            end repeat
          end repeat
          return eventList
        end tell
      `;
      try {
        const out = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { encoding: "utf-8", timeout: 15000 });
        if (!out.trim()) return `No events found in the next ${days} days`;
        return `Upcoming events (next ${days} days):\n${out.trim()}`;
      } catch (err) {
        return `Calendar error: ${err.message}`;
      }
    }

    if (action === "create") {
      const { title, startDate, endDate, calendarName = "Calendar", notes = "" } = params;
      if (!title) return "Error: title is required";
      if (!startDate) return "Error: startDate is required (e.g. '2026-03-10T10:00:00')";

      const start = new Date(startDate);
      const end = endDate ? new Date(endDate) : new Date(start.getTime() + 60 * 60 * 1000);

      const fmtDate = (d) => {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`;
      };

      const script = `
        tell application "Calendar"
          tell calendar "${calendarName.replace(/"/g, '\\"')}"
            make new event with properties {summary:"${title.replace(/"/g, '\\"')}", start date:date "${fmtDate(start)}", end date:date "${fmtDate(end)}"${notes ? `, description:"${notes.replace(/"/g, '\\"')}"` : ""}}
          end tell
        end tell
      `;
      try {
        execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { timeout: 10000 });
        return `Event created: "${title}" on ${start.toLocaleString()}`;
      } catch (err) {
        return `Calendar create error: ${err.message}`;
      }
    }

    if (action === "search") {
      const { query } = params;
      if (!query) return "Error: query is required";
      const script = `
        tell application "Calendar"
          set hits to ""
          repeat with aCal in every calendar
            repeat with anEvent in (every event of aCal whose summary contains "${query.replace(/"/g, '\\"')}")
              set hits to hits & summary of anEvent & " | " & (start date of anEvent as string) & "\\n"
            end repeat
          end repeat
          return hits
        end tell
      `;
      try {
        const out = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, { encoding: "utf-8", timeout: 15000 });
        if (!out.trim()) return `No events found matching "${query}"`;
        return `Events matching "${query}":\n${out.trim()}`;
      } catch (err) {
        return `Calendar search error: ${err.message}`;
      }
    }
  }

  // ── Google Calendar (API) ────────────────────────────────────────────────
  if (provider === "google") {
    const apiKey = process.env.GOOGLE_CALENDAR_API_KEY;
    const calId = params.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary";
    if (!apiKey) return "Error: GOOGLE_CALENDAR_API_KEY env var required for Google Calendar provider";

    const fetchFn = globalThis.fetch || (await import("node-fetch")).default;

    if (action === "list") {
      const timeMin = new Date().toISOString();
      const maxResults = params.maxResults || 10;
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?key=${apiKey}&timeMin=${timeMin}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;
      const res = await fetchFn(url);
      const data = await res.json();
      if (!res.ok) return `Google Calendar error: ${data.error?.message}`;
      if (!data.items?.length) return "No upcoming events";
      return data.items.map(e => `${e.summary} | ${e.start?.dateTime || e.start?.date}`).join("\n");
    }

    if (action === "create") {
      const accessToken = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN;
      if (!accessToken) return "Error: GOOGLE_CALENDAR_ACCESS_TOKEN required to create Google Calendar events";
      const { title, startDate, endDate, notes } = params;
      if (!title || !startDate) return "Error: title and startDate required";
      const event = {
        summary: title,
        description: notes || "",
        start: { dateTime: new Date(startDate).toISOString() },
        end: { dateTime: new Date(endDate || new Date(startDate).getTime() + 3600000).toISOString() },
      };
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      const data = await res.json();
      if (!res.ok) return `Google Calendar create error: ${data.error?.message}`;
      return `Event created: "${data.summary}" on ${data.start.dateTime}`;
    }
  }

  return `Unknown action: "${action}" for provider "${provider}". Valid actions: list, create, search`;
}

export const calendarDescription =
  `calendar(action: string, paramsJson?: object) - Read/create calendar events.
  action: "list" | "create" | "search"
  params.provider: "macos" (default, AppleScript) | "google" (Google Calendar API)
  list params: { days?: 7, provider, calendarId? }
  create params: { title, startDate: "ISO string", endDate?, calendarName?, notes?, provider }
  search params: { query, provider }
  Env vars: GOOGLE_CALENDAR_API_KEY, GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_ACCESS_TOKEN
  Examples:
    calendar("list", {"days":3})
    calendar("create", {"title":"Team standup","startDate":"2026-03-10T09:00:00"})
    calendar("list", {"provider":"google","maxResults":5})`;
