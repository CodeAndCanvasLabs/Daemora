/**
 * Pre-built team templates. Each template defines a reusable worker
 * DAG that can be instantiated via `TeamStore.createTeam()` with a
 * user-supplied task description injected into each worker's task.
 */

import type { CreateWorkerOpts } from "./TeamStore.js";

export interface TeamTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly workers: readonly CreateWorkerOpts[];
}

export const teamTemplates: readonly TeamTemplate[] = [
  {
    id: "full-stack",
    name: "Full-Stack App",
    description: "Frontend + backend + tests — backend runs first, then frontend and tests in parallel",
    workers: [
      {
        name: "backend",
        crew: "backend",
        task: "Implement the backend: API routes, data models, and business logic.",
        blockedByWorkers: [],
      },
      {
        name: "frontend",
        crew: "frontend",
        task: "Implement the frontend UI and connect it to the backend API.",
        blockedByWorkers: ["backend"],
      },
      {
        name: "tests",
        crew: "backend",
        task: "Write comprehensive tests covering the backend API and integration points.",
        blockedByWorkers: ["backend"],
      },
    ],
  },
  {
    id: "research-report",
    name: "Research Report",
    description: "Research + analysis + document — parallel research, then synthesize",
    workers: [
      {
        name: "primary-research",
        crew: "researcher",
        task: "Conduct primary research: gather facts, data, and key findings on the topic.",
        blockedByWorkers: [],
      },
      {
        name: "competitive-analysis",
        crew: "researcher",
        task: "Perform competitive/comparative analysis: identify alternatives, trade-offs, and benchmarks.",
        blockedByWorkers: [],
      },
      {
        name: "synthesis",
        crew: "writer",
        task: "Synthesize all research into a structured report with executive summary, findings, and recommendations.",
        blockedByWorkers: ["primary-research", "competitive-analysis"],
      },
    ],
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Security audit + code quality review in parallel, then summary",
    workers: [
      {
        name: "security-audit",
        crew: "backend",
        task: "Perform a security audit: check for vulnerabilities, injection risks, auth issues, and data exposure.",
        blockedByWorkers: [],
      },
      {
        name: "quality-review",
        crew: "backend",
        task: "Review code quality: architecture, naming, DRY violations, error handling, and performance.",
        blockedByWorkers: [],
      },
      {
        name: "review-summary",
        crew: "writer",
        task: "Compile a final review report combining security findings and code quality issues, prioritized by severity.",
        blockedByWorkers: ["security-audit", "quality-review"],
      },
    ],
  },
];

/**
 * Look up a template by id. Returns undefined if not found.
 */
export function getTemplate(id: string): TeamTemplate | undefined {
  return teamTemplates.find((t) => t.id === id);
}
