/**
 * ContractBuilder - structured contract for sub-agent, team, and parallel agent task assignment.
 *
 * Produces a formatted string with clear sections. Sections with null/undefined values are omitted.
 * Simple spawns (task only) return just the task text - no overhead.
 */

/**
 * Build a structured contract string.
 * @param {object} opts
 * @param {string} opts.task - what to do (required)
 * @param {string} [opts.context] - background info, parent findings, prior work
 * @param {string} [opts.files] - relevant file paths or references
 * @param {string} [opts.spec] - detailed specification or requirements
 * @param {string} [opts.constraints] - rules, limits, things to avoid
 * @param {string} [opts.outputFormat] - expected output structure
 * @param {string} [opts.deadline] - time constraint or urgency
 * @param {string} [opts.skills] - injected skill instructions
 * @returns {string}
 */
export function buildContract({ task, context, files, spec, constraints, outputFormat, deadline, skills }) {
  if (!task) return "";

  const sections = [];

  // Skills go first - they define HOW to work
  if (skills) sections.push({ heading: "SKILLS", body: skills });

  sections.push({ heading: "TASK", body: task });

  if (context) sections.push({ heading: "CONTEXT", body: context });
  if (files) sections.push({ heading: "FILES", body: files });
  if (spec) sections.push({ heading: "SPEC", body: spec });
  if (constraints) sections.push({ heading: "CONSTRAINTS", body: constraints });
  if (outputFormat) sections.push({ heading: "OUTPUT FORMAT", body: outputFormat });
  if (deadline) sections.push({ heading: "DEADLINE", body: deadline });

  // Simple case - task only, no overhead
  if (sections.length === 1 && !skills) return task;

  return sections.map(s => `### ${s.heading}\n${s.body}`).join("\n\n");
}
