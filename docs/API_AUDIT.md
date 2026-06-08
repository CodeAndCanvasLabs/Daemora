# Daemora API Audit — dead & duplicate endpoints

> Status: analysis only (no code changed). Written 2026-06-03.
> Scope: the per-tenant daemora server, `src/server/routes/*`. Cross-referenced
> against `ui/src` callers. This is the prep for the API refactor (Stream D, #28) —
> which the owner wants done LAST. Nothing here is removed yet.

## ⚠️ CORRECTION (2026-06-03) — do the removals WITH the UI rewrite, not before

Re-grepping the "dead" candidates against `ui/src` + `src` found this audit is a
**guide, not gospel** — it has false positives, and grep-based dead-detection is
unreliable here for three reasons:
- **Substring matches:** `/api/profile` matches `/api/profiles`; `/api/tools`
  matches `/api/toolsets` — a naive grep over-counts.
- **Template-string calls:** the UI calls parameterized routes as
  `` `/api/skills/${id}` `` so the literal `/api/skills/:id` never appears — you
  can't confirm those dead by grep.
- **Response-shape coupling:** several `compat.ts` "duplicates" return a DIFFERENT
  shape than the canonical route, and the UI may depend on the compat shape.

Confirmed false positives (have real callers — KEEP): `/api/cron/status`,
`/api/audit`, `/api/models/all`, `/api/profile`/`/api/profiles`, `/api/tools`,
`/api/cron/runs`.

**Therefore endpoint removal is NOT done autonomously — it is coupled to the UI
rewrite (#29).** When the UI is rewritten on the typed API client (Stream D), each
endpoint's real usage becomes knowable, and dead/duplicate routes can be removed
safely then (and `compat.ts` retired). Until then, removing routes risks breaking
the current UI at runtime (the UI has no tests). This matches the owner's original
"API + UI last, together" intent.

## Headline

**~219 endpoints today → ~145 after cleanup.** The debt concentrates in **one
file**: `src/server/routes/compat.ts` (43 endpoints, **27 of them direct
duplicates** of canonical routes in their own files). Plus **~35 dead** endpoints
with no UI caller and no internal caller.

| Bucket | Count | Safe to remove? |
|---|---|---|
| Dead (no UI/internal caller) | ~35 | Yes — no caller |
| Duplicate (compat.ts shadows canonical) | ~27 | Yes — after UI points at canonical |
| Alias duplicates (e.g. `/api/cron/presets` → `/api/delivery-presets`) | ~5 | Yes |
| **Total removable** | **~67** | |

## The core problem: `compat.ts`

It's a legacy shim that re-implements, with slightly different response shapes,
endpoints that already exist canonically. For each resource below, the canonical
file is authoritative and the compat copy should go (UI repointed):

- **cron** — compat L95-199 duplicates `cron.ts` (jobs CRUD + runs); compat
  `/api/cron/presets*` aliases `deliveryPresets.ts`.
- **tasks** — compat L288-310 duplicates `tasks.ts`.
- **goals** — compat L397-432 duplicates `goals.ts` (compat uses `PUT`, canonical
  uses `PATCH`).
- **watchers** — compat L348-394 duplicates `watchers.ts` (PUT vs PATCH again).
- **mcp** — compat L441-471 duplicates `mcp.ts` GET/POST/DELETE.
- **channels** — compat L635-685 duplicates `channels.ts`.
- **costs / memory / skills** — compat L60-80, L313-323 duplicate canonical.

**Keep (unique, no canonical equivalent — migrate into the proper file, then
delete compat.ts):**
`POST /api/cron/jobs/:id/run` (manual fire), `GET /api/setup/status`,
`POST /api/goals/:id/check`, `POST /api/mcp/:name/activate|deactivate|:action`
(credential/lifecycle flow), `GET /api/channels/destinations`,
`GET /api/mcp/:name/config`, `GET /api/channels/:id/status` (merge into
`channels.ts`).

## Dead endpoints (no UI caller, no internal caller — removal candidates)

Safe to delete without touching the UI. Verify any non-UI caller (channels,
webhooks, cron, external/OAuth) before removing — those are NOT dead.

- `profiles.ts` — `GET /api/profiles/:id`
- `channels.ts` — `POST /api/channels/reload`, `DELETE /api/channels/:id`
- `costs.ts` — `GET /api/costs/tasks/:id`, `GET /api/costs/summary`
- `chat.ts` — `GET /api/sessions/:id/stream` (placeholder, emits nothing)
- `voice.ts` — `POST /api/voice/wake/stop`, `GET /api/voice/wake/status`, `GET /api/voices`
- `providers.ts` — `GET /api/providers/:id/models`, `GET /api/models`, `GET /api/models/all`
- `browser.ts` — `GET`/`PUT /api/browser/profile` (whole file; Tauri-only, unfinished)
- `tunnel.ts` — `GET /api/tunnel` (whole file; external-only — confirm first)
- `watchers.ts` — `POST`/`DELETE /api/watchers/:id/token`
- `memory.ts` — `GET /api/memory/:id`, `POST /api/memory`, `DELETE /api/memory/:id`, `POST /api/brain/:target`
- `skills.ts` — `GET /api/skills/:id`, `GET /api/skills/:id/file`
- `config.ts` — `GET /api/config`, `DELETE /api/settings/:key`
- `tasks.ts` — `DELETE /api/tasks/:id`, `GET /api/tasks/:id/inflight`
- `files.ts` — `GET /api/file-projects/:slug/files/:fileId/filer`
- `compat.ts` — `GET /api/tools`, `GET /api/audit`, `GET /api/profile`, `PUT /api/profile`, `GET /api/cron/status`, `GET /api/cron/runs`

> Caveat: `delivery-presets`, `memory` (GET/search), `voice/wake-event`,
> `GET /api/file`, and the OAuth callbacks have **no UI caller but real internal/
> external callers** — keep them.

## Recommended sequence (when Stream D runs — LAST, per owner)

1. **Delete the ~35 dead endpoints** — zero UI impact.
2. **Build the typed API client** (Stream D), repoint UI off compat → canonical,
   switch `PUT`→`PATCH` for goals/watchers, `GET`→`POST` for voice token.
3. **Migrate the 7 unique compat endpoints** into their canonical files, then
   **delete `compat.ts` entirely.**
4. End state: ~145 endpoints, one canonical route per resource, a single typed
   client (no 90 hardcoded URL strings — see REFACTOR_PLAN.md Stream D).

## Open product decisions (dead features — finish or delete?)

- **Browser profile switching** (`browser.ts`) — Tauri desktop feature, unfinished.
- **Watcher token rotation** (`watchers.ts`) — never exposed in UI.
- **Voice wake-word** (`voice.ts /wake/*`) — placeholder no-ops.
