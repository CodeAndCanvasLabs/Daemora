/**
 * Team Templates - pre-built team configurations for common workflows.
 *
 * Pattern: ClawTeam's TOML templates adapted for our JSON format.
 * Each template defines: leader context + worker roster with specific profiles, tasks, and skills.
 *
 * The main agent (or user via UI) picks a template, provides the goal,
 * and the system fills in the rest.
 */

export const TEAM_TEMPLATES = [

  // ── Software Development ──────────────────────────────────────────────────

  {
    id: "full-stack",
    name: "Full-Stack Development",
    description: "Backend + Frontend + Testing. For building complete features end-to-end.",
    workers: [
      {
        name: "backend-dev",
        profile: "backend",
        taskTemplate: "Implement the backend: API routes, database schema, middleware, validation. Write clean, tested code. Use existing patterns from the codebase.",
        skills: ["coding", "api-development", "debugging"],
      },
      {
        name: "frontend-dev",
        profile: "frontend",
        taskTemplate: "Implement the frontend: UI components, state management, API integration. Match existing design patterns. Responsive and accessible.",
        skills: ["coding", "frontend-design", "web-development"],
      },
      {
        name: "tester",
        profile: "tester",
        taskTemplate: "Write comprehensive tests: unit tests for backend logic, integration tests for API endpoints, e2e tests for critical flows. Cover edge cases.",
        skills: ["coding", "debugging", "webapp-testing"],
        blockedByWorkers: ["backend-dev", "frontend-dev"],
      },
    ],
  },

  {
    id: "backend-api",
    name: "Backend API Team",
    description: "API design + implementation + database. For building robust backend services.",
    workers: [
      {
        name: "api-architect",
        profile: "architect",
        taskTemplate: "Design the API: endpoints, request/response schemas, authentication, error handling. Document in OpenAPI format. Consider rate limiting and versioning.",
        skills: ["api-development", "planning"],
      },
      {
        name: "implementer",
        profile: "backend",
        taskTemplate: "Implement the API based on the architect's design. Routes, controllers, middleware, database queries. Follow RESTful conventions.",
        skills: ["coding", "api-development", "debugging"],
        blockedByWorkers: ["api-architect"],
      },
      {
        name: "db-specialist",
        profile: "database",
        taskTemplate: "Design and implement the database schema: tables, indexes, migrations, seed data. Optimize queries for the API endpoints.",
        skills: ["coding", "data-analysis"],
      },
    ],
  },

  // ── Research & Analysis ───────────────────────────────────────────────────

  {
    id: "research-report",
    name: "Research & Report",
    description: "Deep research + analysis + written report. For producing comprehensive deliverables.",
    workers: [
      {
        name: "researcher",
        profile: "researcher",
        taskTemplate: "Research the topic thoroughly. Search the web, read relevant pages, gather data from multiple sources. Save raw findings to files.",
        skills: ["research", "content-research-writer", "summarize"],
      },
      {
        name: "analyst",
        profile: "analyst",
        taskTemplate: "Analyze the research findings. Identify patterns, compare data points, draw conclusions. Create charts or tables if helpful.",
        skills: ["data-analysis", "research", "summarize"],
        blockedByWorkers: ["researcher"],
      },
      {
        name: "writer",
        profile: "writer",
        taskTemplate: "Write a polished report from the analysis. Executive summary, key findings, recommendations, appendix with data. Save as markdown or PDF.",
        skills: ["coding", "summarize"],
        blockedByWorkers: ["analyst"],
      },
    ],
  },

  // ── Code Review ───────────────────────────────────────────────────────────

  {
    id: "code-review",
    name: "Code Review Team",
    description: "Security review + code quality + test coverage. For thorough PR review.",
    workers: [
      {
        name: "security-reviewer",
        profile: "security",
        taskTemplate: "Review for security vulnerabilities: injection, XSS, CSRF, auth bypass, credential exposure, insecure dependencies. Report findings with severity levels.",
        skills: ["coding", "debugging"],
      },
      {
        name: "quality-reviewer",
        profile: "reviewer",
        taskTemplate: "Review code quality: naming, structure, duplication, error handling, edge cases, performance. Suggest specific improvements with examples.",
        skills: ["coding", "debugging"],
      },
      {
        name: "test-reviewer",
        profile: "tester",
        taskTemplate: "Review test coverage: are critical paths tested? Missing edge cases? Flaky tests? Suggest specific test cases that should be added.",
        skills: ["coding", "webapp-testing", "debugging"],
      },
    ],
  },

  // ── DevOps ────────────────────────────────────────────────────────────────

  {
    id: "devops-deploy",
    name: "DevOps Deployment",
    description: "Infrastructure + CI/CD + monitoring. For production deployment tasks.",
    workers: [
      {
        name: "infra-engineer",
        profile: "devops",
        taskTemplate: "Set up or update infrastructure: servers, containers, networking, DNS. Use existing IaC patterns. Document changes.",
        skills: ["devops", "system-admin", "coding"],
      },
      {
        name: "pipeline-engineer",
        profile: "backend",
        taskTemplate: "Build or update CI/CD pipeline: build, test, deploy stages. Handle environment variables, secrets, caching. Ensure rollback capability.",
        skills: ["devops", "coding"],
      },
      {
        name: "monitor-engineer",
        profile: "sysadmin",
        taskTemplate: "Set up monitoring and alerting: health checks, log aggregation, error tracking, performance metrics. Define alert thresholds.",
        skills: ["devops", "system-admin"],
        blockedByWorkers: ["infra-engineer"],
      },
    ],
  },
];

/**
 * Get a template by ID and fill in the goal.
 * Returns a ready-to-use team config for teamTask("createTeam", ...).
 */
export function applyTemplate(templateId, goal) {
  const template = TEAM_TEMPLATES.find(t => t.id === templateId);
  if (!template) return null;

  const workers = template.workers.map(w => ({
    name: w.name,
    profile: w.profile,
    task: `${w.taskTemplate}\n\nGoal: ${goal}`,
    skills: w.skills,
    // blockedByWorkers resolved later by the team lead (task IDs aren't known yet)
  }));

  return {
    name: template.name,
    task: goal,
    context: `Team template: ${template.name}. ${template.description}`,
    workers,
  };
}

export default TEAM_TEMPLATES;
