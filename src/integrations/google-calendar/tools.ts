/**
 * Google Calendar tools exposed to the `google-calendar-crew`.
 *
 * Endpoint coverage matches n8n's GoogleCalendarV2 node: events CRUD,
 * list/query, move, freeBusy, list calendars. Auth flows through
 * IntegrationManager → `google_calendar` integration.
 *
 * Dates/times follow RFC 3339 (ISO-8601 with offset), e.g.
 *   "2026-05-01T09:00:00-07:00"  — timed
 *   "2026-05-01"                 — all-day (set `allDay=true`)
 */

import { z } from "zod";

import type { ToolDef } from "../../tools/types.js";
import type { IntegrationManager } from "../IntegrationManager.js";
import { CalendarClient } from "./CalendarClient.js";

export function makeCalendarTools(integrations: IntegrationManager): readonly ToolDef[] {
  const client = new CalendarClient(integrations);

  const attendeeSchema = z.object({
    email: z.string().email(),
    optional: z.boolean().optional(),
    responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]).optional(),
  });

  const listCalendars: ToolDef<z.ZodObject<Record<string, never>>, unknown> = {
    name: "calendar_list_calendars",
    description: "List calendars the user has access to (primary, shared, group calendars).",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "list"],
    inputSchema: z.object({}),
    async execute() {
      return client.request<unknown>("/users/me/calendarList");
    },
  };

  const eventsList: ToolDef<z.ZodObject<{
    calendarId: z.ZodOptional<z.ZodString>;
    timeMin: z.ZodOptional<z.ZodString>;
    timeMax: z.ZodOptional<z.ZodString>;
    q: z.ZodOptional<z.ZodString>;
    maxResults: z.ZodOptional<z.ZodNumber>;
    singleEvents: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "calendar_events_list",
    description: "List events in a calendar. `timeMin`/`timeMax` bound the window; `q` free-text searches summary+description; `singleEvents=true` expands recurring instances.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      timeMin: z.string().optional(),
      timeMax: z.string().optional(),
      q: z.string().optional(),
      maxResults: z.number().int().min(1).max(2500).optional(),
      singleEvents: z.boolean().optional(),
    }),
    async execute({ calendarId, ...rest }) {
      const cal = calendarId ?? "primary";
      const q = new URLSearchParams();
      if (rest.timeMin) q.set("timeMin", rest.timeMin);
      if (rest.timeMax) q.set("timeMax", rest.timeMax);
      if (rest.q) q.set("q", rest.q);
      if (rest.maxResults) q.set("maxResults", String(rest.maxResults));
      if (rest.singleEvents !== undefined) q.set("singleEvents", String(rest.singleEvents));
      q.set("orderBy", rest.singleEvents ? "startTime" : "updated");
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events?${q.toString()}`);
    },
  };

  const eventsGet: ToolDef<z.ZodObject<{ calendarId: z.ZodOptional<z.ZodString>; eventId: z.ZodString }>, unknown> = {
    name: "calendar_event_get",
    description: "Fetch a single event by id.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      eventId: z.string().min(1),
    }),
    async execute({ calendarId, eventId }) {
      const cal = calendarId ?? "primary";
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`);
    },
  };

  const eventsCreate: ToolDef<z.ZodObject<{
    calendarId: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodString>;
    start: z.ZodString;
    end: z.ZodString;
    timeZone: z.ZodOptional<z.ZodString>;
    allDay: z.ZodOptional<z.ZodBoolean>;
    attendees: z.ZodOptional<z.ZodArray<typeof attendeeSchema>>;
    sendUpdates: z.ZodOptional<z.ZodEnum<["all", "externalOnly", "none"]>>;
    conferenceData: z.ZodOptional<z.ZodBoolean>;
  }>, unknown> = {
    name: "calendar_event_create",
    description: "Create a new event. Set `allDay=true` for date-only events (start/end as YYYY-MM-DD). `conferenceData=true` requests a Meet link.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events", "create"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      summary: z.string().min(1).max(1024),
      description: z.string().optional(),
      location: z.string().optional(),
      start: z.string().min(1),
      end: z.string().min(1),
      timeZone: z.string().optional(),
      allDay: z.boolean().optional(),
      attendees: z.array(attendeeSchema).optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
      conferenceData: z.boolean().optional(),
    }),
    async execute(args) {
      const { calendarId, allDay, start, end, timeZone, attendees, sendUpdates, conferenceData, ...base } = args;
      const cal = calendarId ?? "primary";
      const body: Record<string, unknown> = {
        ...base,
        start: allDay ? { date: start } : { dateTime: start, ...(timeZone ? { timeZone } : {}) },
        end: allDay ? { date: end } : { dateTime: end, ...(timeZone ? { timeZone } : {}) },
        ...(attendees ? { attendees } : {}),
      };
      if (conferenceData) {
        body["conferenceData"] = {
          createRequest: {
            requestId: `daemora-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        };
      }
      const q = new URLSearchParams();
      if (sendUpdates) q.set("sendUpdates", sendUpdates);
      if (conferenceData) q.set("conferenceDataVersion", "1");
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events?${q.toString()}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
  };

  const eventsUpdate: ToolDef<z.ZodObject<{
    calendarId: z.ZodOptional<z.ZodString>;
    eventId: z.ZodString;
    summary: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodString>;
    start: z.ZodOptional<z.ZodString>;
    end: z.ZodOptional<z.ZodString>;
    timeZone: z.ZodOptional<z.ZodString>;
    allDay: z.ZodOptional<z.ZodBoolean>;
    attendees: z.ZodOptional<z.ZodArray<typeof attendeeSchema>>;
    sendUpdates: z.ZodOptional<z.ZodEnum<["all", "externalOnly", "none"]>>;
  }>, unknown> = {
    name: "calendar_event_update",
    description: "Patch an existing event. Only pass the fields you want to change.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events", "update"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      eventId: z.string().min(1),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      timeZone: z.string().optional(),
      allDay: z.boolean().optional(),
      attendees: z.array(attendeeSchema).optional(),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
    }),
    async execute(args) {
      const { calendarId, eventId, allDay, start, end, timeZone, attendees, sendUpdates, ...base } = args;
      const cal = calendarId ?? "primary";
      const body: Record<string, unknown> = { ...base };
      if (start) body["start"] = allDay ? { date: start } : { dateTime: start, ...(timeZone ? { timeZone } : {}) };
      if (end) body["end"] = allDay ? { date: end } : { dateTime: end, ...(timeZone ? { timeZone } : {}) };
      if (attendees) body["attendees"] = attendees;
      const q = new URLSearchParams();
      if (sendUpdates) q.set("sendUpdates", sendUpdates);
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}?${q.toString()}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
  };

  const eventsDelete: ToolDef<z.ZodObject<{
    calendarId: z.ZodOptional<z.ZodString>;
    eventId: z.ZodString;
    sendUpdates: z.ZodOptional<z.ZodEnum<["all", "externalOnly", "none"]>>;
  }>, unknown> = {
    name: "calendar_event_delete",
    description: "Delete an event. Confirm with the user before calling — deletes cascade to attendees' invites.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events", "delete"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      eventId: z.string().min(1),
      sendUpdates: z.enum(["all", "externalOnly", "none"]).optional(),
    }),
    async execute({ calendarId, eventId, sendUpdates }) {
      const cal = calendarId ?? "primary";
      const q = new URLSearchParams();
      if (sendUpdates) q.set("sendUpdates", sendUpdates);
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}?${q.toString()}`, { method: "DELETE" });
    },
  };

  const eventsMove: ToolDef<z.ZodObject<{
    calendarId: z.ZodString;
    eventId: z.ZodString;
    destination: z.ZodString;
  }>, unknown> = {
    name: "calendar_event_move",
    description: "Move an event to a different calendar the user owns.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events", "move"],
    inputSchema: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      destination: z.string().min(1),
    }),
    async execute({ calendarId, eventId, destination }) {
      const q = new URLSearchParams({ destination });
      return client.request<unknown>(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}/move?${q.toString()}`, {
        method: "POST",
      });
    },
  };

  const freeBusy: ToolDef<z.ZodObject<{
    timeMin: z.ZodString;
    timeMax: z.ZodString;
    calendars: z.ZodArray<z.ZodString>;
    timeZone: z.ZodOptional<z.ZodString>;
  }>, unknown> = {
    name: "calendar_freebusy",
    description: "Query free/busy for one or more calendars over a time window. Use for conflict detection before scheduling.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "freebusy"],
    inputSchema: z.object({
      timeMin: z.string().min(1),
      timeMax: z.string().min(1),
      calendars: z.array(z.string()).min(1),
      timeZone: z.string().optional(),
    }),
    async execute({ timeMin, timeMax, calendars, timeZone }) {
      return client.request<unknown>("/freeBusy", {
        method: "POST",
        body: JSON.stringify({
          timeMin,
          timeMax,
          items: calendars.map((id) => ({ id })),
          ...(timeZone ? { timeZone } : {}),
        }),
      });
    },
  };

  const quickAdd: ToolDef<z.ZodObject<{ calendarId: z.ZodOptional<z.ZodString>; text: z.ZodString }>, unknown> = {
    name: "calendar_event_quick_add",
    description: "Quick-add event from natural language (e.g. \"Dinner with Alice 7pm Friday\"). Good for ambiguous inputs.",
    category: "channel",
    source: { kind: "core" },
    tags: ["calendar", "events", "create"],
    inputSchema: z.object({
      calendarId: z.string().optional(),
      text: z.string().min(1).max(1024),
    }),
    async execute({ calendarId, text }) {
      const cal = calendarId ?? "primary";
      const q = new URLSearchParams({ text });
      return client.request<unknown>(`/calendars/${encodeURIComponent(cal)}/events/quickAdd?${q.toString()}`, { method: "POST" });
    },
  };

  return [
    listCalendars, eventsList, eventsGet,
    eventsCreate, eventsUpdate, eventsDelete, eventsMove, quickAdd,
    freeBusy,
  ] as unknown as readonly ToolDef[];
}
