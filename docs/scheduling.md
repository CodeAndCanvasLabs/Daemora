# Scheduling (Cron)

Daemora has a production-grade cron scheduler for running tasks autonomously on a schedule.

## Schedule Types

### Cron Expression
Standard cron syntax with timezone support:
```
0 9 * * *          — daily at 9am
*/30 * * * *       — every 30 minutes
0 9 * * 1-5        — weekdays at 9am
0 0 1 * *          — first day of month
```

### Fixed Interval
```
30s   — every 30 seconds
5m    — every 5 minutes
2h    — every 2 hours
1d    — every day
```

### One-Shot
Run once at a specific time:
```
2026-03-20T10:00:00Z
```

## Creating Jobs

### Via Chat
```
Schedule a daily sales report at 9am
```
The agent uses the `cron` tool to create the job.

### Via Dashboard
**Cron** → **New Job** → fill in:
- Name
- Schedule type + expression
- Task input (agent prompt)
- Model (optional)
- Max retries
- Timeout
- Delivery targets

### Via CLI
```bash
# Jobs are created via the agent or API, not CLI directly
```

## Delivery

When a cron job completes, results can be delivered to channels:

### Delivery Modes
- **None** — no delivery, results stored in run history
- **Preset** — deliver to a saved group (e.g. "engineers")
- **Multi-Target** — pick specific tenants and channels
- **Webhook** — POST results to a URL

### Delivery Presets

Named groups of tenant/channel targets, reusable across jobs:

```
"team-leads" → [Tenant A → slack, Tenant B → email]
"engineers"  → [Tenant C → discord, Tenant D → telegram]
"everyone"   → all tenants, all channels
```

Create via dashboard: **Cron** → **Presets** tab → **New Preset**.

### How Delivery Works
1. Job runs ONCE — produces result text
2. Result fans out to ALL targets via `channelRegistry.sendReply()`
3. Fresh channel metadata resolved at delivery time (no stale data)
4. Partial delivery tracked: "delivered 3/5"
5. Failed deliveries logged with error details

## Features

- **Overlap prevention** — skip if previous run still active
- **Retry with backoff** — exponential backoff on failure
- **Missed job catchup** — runs missed jobs on restart (max 5, staggered)
- **Stuck job detection** — kills jobs exceeding timeout
- **Run history** — full execution log with cost, duration, errors
- **Auto-pruning** — keeps 2000 run records per job
- **Failure alerts** — notify admin after N consecutive failures
- **Per-tenant isolation** — tenant crons use tenant API keys
- **Deterministic stagger** — prevents thundering herd on startup

## Admin vs Tenant Crons

**Admin crons** (via UI or HTTP chat):
- Can use delivery presets
- Can target multiple tenants
- Can use `deliveryPreset` param in agent tool

**Tenant crons** (via channel chat):
- Auto-deliver to the tenant's own channel
- Isolated — can't see other tenants' jobs
- Use tenant's own API keys
