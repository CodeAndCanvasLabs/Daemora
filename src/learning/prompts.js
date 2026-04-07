/**
 * Prompts for the automatic learning extraction pipeline.
 * Used by ExtractionPipeline.js — direct generateText() calls, no agent/tools.
 */

export const FACT_EXTRACTION_PROMPT = `You analyze completed conversations and extract facts worth remembering long-term.

Output a JSON array. Each element:
{
  "content": "atomic fact in 1-2 sentences",
  "layer": "semantic" | "episodic" | "procedural",
  "category": "<see categories below>",
  "confidence": 0.0-1.0,
  "project": "<project name or null if global>"
}

LAYERS:
- semantic: Permanent facts — user preferences, corrections, environment details, project tech stacks
- episodic: What happened — task summaries, decisions made, errors encountered (will decay over time)
- procedural: How-to knowledge — approaches that worked, error fixes, tool patterns, recipes (permanent, grows with reuse)

CATEGORIES:
- preference: "User prefers X over Y" (always semantic)
- correction: "User corrected agent: do X not Y" (always semantic, confidence >= 0.9)
- fact: "User's name is X", "Project uses PostgreSQL" (semantic)
- environment: "User's Mac uses pnpm", "Server runs on port 3000" (semantic)
- approach: "Built OAuth with passport.js: install, configure, add routes" (procedural)
- error-fix: "CORS error fixed by adding Access-Control-Allow-Origin header" (procedural)
- tool-pattern: "For file uploads use form-data not fetch" (procedural)
- task-summary: "Debugged auth module, found expired JWT tokens" (episodic)

RULES:
- Extract ONLY genuinely useful, reusable facts. Not pleasantries or task minutiae.
- User corrections and preferences are HIGH priority (confidence >= 0.9).
- Be atomic: one fact per entry. Split compound facts.
- Skip greetings, thanks, acknowledgments, yes/no responses.
- If nothing worth extracting, return empty array: []
- Maximum 5 facts per conversation.
- For project detection: if conversation mentions a specific project name or codebase, tag it. Otherwise null (global).
- Output ONLY the JSON array, no other text or markdown.`;

export const MEMORY_MANAGEMENT_PROMPT = `You manage a memory database. For each NEW FACT, compare against EXISTING MEMORIES and decide what action to take.

Output a JSON array of decisions:
{
  "fact_index": 0,
  "action": "ADD" | "UPDATE" | "SUPERSEDE" | "SKIP",
  "reason": "brief explanation",
  "existing_id": null | "<id of existing memory to update/supersede>"
}

ACTIONS:
- ADD: Fact is genuinely new — no existing memory covers this information.
- UPDATE: Fact adds detail to an existing memory without contradicting it. Merges content.
- SUPERSEDE: Fact contradicts an existing memory (user changed preference, moved cities, switched tech). The old memory is marked as superseded.
- SKIP: Fact is already captured by an existing memory (duplicate or subset). No action needed.

RULES:
- When in doubt, prefer SKIP over ADD (avoid memory bloat).
- User corrections ALWAYS supersede: "actually, use spaces" supersedes "prefers tabs".
- Temporal changes supersede: "moved to London" supersedes "lives in NYC".
- Preference changes supersede: "switched to Vue" supersedes "uses React".
- For SUPERSEDE/UPDATE, you MUST include the existing_id.
- Output ONLY the JSON array, no other text.`;

export const SKILL_EXTRACTION_PROMPT = `You analyze task execution trajectories to identify reusable procedures worth saving as skills.

A skill is worth saving when:
- The task required trial-and-error or changing approach
- A non-obvious tool combination was discovered
- The user corrected the approach and the correction is generalizable
- The workflow has 3+ distinct steps that would be useful for similar future tasks

Output JSON:
{
  "should_save": true | false,
  "skill_name": "kebab-case-name",
  "description": "One-line description for matching",
  "triggers": "comma, separated, trigger, words",
  "content": "Full skill markdown content with steps"
}

If the task was routine and nothing novel was learned, output: {"should_save": false}

RULES:
- Skill names must be kebab-case, descriptive, 2-4 words
- Content should be actionable step-by-step instructions
- Include specific tool names, commands, file paths that were used
- Include warnings about what DIDN'T work (so the agent avoids it next time)
- Output ONLY the JSON, no other text.`;
