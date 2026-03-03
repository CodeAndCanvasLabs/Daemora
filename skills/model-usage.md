---
name: model-usage
description: Track and report AI model API usage, costs, token counts, and spending across OpenAI, Anthropic, and Google. Use when the user asks how much they've spent, their API usage, token counts, cost breakdown, daily/monthly costs, or wants to optimize AI spending.
triggers: model usage, api cost, token usage, spending, how much spent, cost breakdown, openai usage, anthropic usage, api usage, cost report, ai spending, daily cost, monthly cost
metadata: {"daemora": {"emoji": "💰"}}
---

## Daemora built-in cost tracking

```bash
curl -s http://localhost:8081/costs/today
```

Cost logs: `data/costs/YYYY-MM-DD.jsonl` - each entry has `modelId`, `estimatedCost`, `inputTokens`, `outputTokens`, `tenantId`.

## Model cost reference (2026)

| Model | Input/1M | Output/1M | Best for |
|-------|---------|----------|---------|
| gpt-4.1-mini | $0.15 | $0.60 | Most tasks |
| gpt-4.1 | $2.00 | $8.00 | Complex reasoning |
| claude-sonnet-4-6 | $3.00 | $15.00 | Code, analysis |
| claude-opus-4-6 | $15.00 | $75.00 | Hard problems only |
| gemini-2.0-flash | $0.075 | $0.30 | Research, summaries |
| gemini-2.5-pro | $1.25 | $10.00 | Long context |

## Cost optimization tips

Always include these when a user asks about costs:

1. **Route by task type** - set `CODE_MODEL`, `RESEARCH_MODEL` in `.env` for automatic routing
2. **Sub-agent profiles** - `spawnAgent` with `profile="researcher"` uses `RESEARCH_MODEL` automatically
3. **Per-tenant limits** - `daemora tenant set <id> maxDailyCost 1.00`
4. **Global daily cap** - `MAX_DAILY_COST=5.00` in `.env`
5. **Per-task cap** - `MAX_COST_PER_TASK=0.25` to kill expensive tasks early
