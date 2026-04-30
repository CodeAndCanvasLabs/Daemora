/**
 * Pre-configured watcher templates. Each entry pre-fills the "create
 * watcher" flow with a sensible name, pattern, cooldown, and action
 * prompt for a common source.
 *
 * `pattern` is AND-matched against incoming event top-level keys.
 * String values ending between `/.../flags` are treated as regex.
 */

export interface WatcherTemplate {
  readonly id: string;
  readonly category: "DevOps" | "Business" | "General";
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly pattern: Readonly<Record<string, string>>;
  readonly cooldownSeconds: number;
  readonly action: string;
  readonly contextHint: string;
}

export const WATCHER_TEMPLATES: readonly WatcherTemplate[] = [
  {
    id: "github-new-issue",
    category: "DevOps",
    name: "github-new-issue",
    label: "GitHub — New Issue Opened",
    description: "Triage new GitHub issues: priority, labels, summary, next steps.",
    pattern: { action: "opened" },
    cooldownSeconds: 10,
    action: `A new GitHub issue was opened. Read the webhook payload below.

Extract: title, number, author, body, existing labels.

Then:
1. Assess priority — critical (prod down / security), high (broken feature), medium (bug / regression), low (enhancement / question).
2. Summarise the issue in 2–3 sentences.
3. Recommend labels (bug, feature, docs, question, good-first-issue).
4. Suggest next steps: who should look, what to investigate.

Keep it concise and actionable.`,
    contextHint: "Add repo details: stack, main branch, team members, label conventions.",
  },
  {
    id: "github-pr-review",
    category: "DevOps",
    name: "github-pr-review",
    label: "GitHub — PR Opened",
    description: "Summarise new pull requests and flag concerns.",
    pattern: { action: "opened" },
    cooldownSeconds: 10,
    action: `A new pull request was opened. Read the payload.

Extract: title, number, author, body, changed files, additions, deletions, base + head branches.

Then:
1. Summarise what the PR does in 2–3 sentences.
2. Flag concerns — large PR (>500 lines), missing description, targeting main directly, breaking changes.
3. Note whether tests are included or missing.
4. Suggest reviewers based on changed files (use context below).

Keep it short — this goes to the team channel.`,
    contextHint: "Add: repo stack, team members and areas, PR conventions, required reviewers.",
  },
  {
    id: "deploy-notification",
    category: "DevOps",
    name: "deploy-notification",
    label: "Deployment Notification",
    description: "Track deployments — what was deployed, where, by whom.",
    pattern: {},
    cooldownSeconds: 10,
    action: `A deployment event arrived. Read the payload.

Extract what's present: environment, version / commit, author, status, service name.

Summarise: what was deployed, where, by whom, success or failure. On failure, extract the error reason.`,
    contextHint: "Add: environments (staging + prod URLs), pipeline, rollback steps.",
  },
  {
    id: "uptime-alert",
    category: "DevOps",
    name: "uptime-alert",
    label: "Uptime Monitor — Service Down",
    description: "Investigate downtime alerts and summarise findings.",
    pattern: {},
    cooldownSeconds: 300,
    action: `A health alert arrived. Read the payload.

Extract: service name + URL, status, error type, downtime duration, region.

Then:
1. Summarise the incident in 2–3 sentences.
2. Suggest likely causes based on the error type.
3. If recovered, note total downtime.
4. Flag if this is a recurring issue.`,
    contextHint: "Add: service architecture, common failure modes, on-call contacts, status page.",
  },
  {
    id: "stripe-payment-failed",
    category: "Business",
    name: "stripe-payment-failed",
    label: "Stripe — Payment Failed",
    description: "Alert on failed payments with customer + recovery suggestions.",
    pattern: { type: "payment_intent.payment_failed" },
    cooldownSeconds: 60,
    action: `A Stripe payment failed. Read the event payload.

Extract: customer email / id, amount + currency, failure reason, payment method, invoice or subscription id.

Then:
1. Summarise plainly.
2. Suggest recovery based on failure reason:
   - card declined → customer updates payment method
   - insufficient funds → retry in a few days
   - expired card → notify to update
   - processing error → automatic retry
3. Note prior failures for this customer.`,
    contextHint: "Add: product name, support email, retry policy, dunning flow.",
  },
  {
    id: "stripe-subscription-canceled",
    category: "Business",
    name: "stripe-subscription-canceled",
    label: "Stripe — Subscription Canceled",
    description: "Track cancellations for churn monitoring.",
    pattern: { type: "customer.subscription.deleted" },
    cooldownSeconds: 60,
    action: `A subscription was canceled. Read the payload.

Extract: customer, plan + price, cancellation reason (if in metadata), subscription duration, immediate vs end-of-period.

Then:
1. Summarise the cancellation.
2. Compute subscription length.
3. Categorise the reason (price / features / competitor / not using).
4. Suggest retention action for long-term customers (> 3 months).`,
    contextHint: "Add: product tiers + pricing, retention offers, win-back templates.",
  },
  {
    id: "form-submission",
    category: "Business",
    name: "form-submission",
    label: "Form Submission",
    description: "Categorise and route incoming form submissions.",
    pattern: {},
    cooldownSeconds: 0,
    action: `A form was submitted. Read the payload.

Extract: submitter name + email, subject / topic, message body, form type.

Then:
1. Categorise — inquiry / support / feedback / sales lead / spam.
2. Summarise the key message in 1–2 sentences.
3. Suggest routing (who handles this).
4. Flag clearly if it looks like spam.`,
    contextHint: "Add: product / service, routing rules, form source URL.",
  },
  {
    id: "generic-alert",
    category: "General",
    name: "generic-alert",
    label: "Generic Alert / Notification",
    description: "Process any webhook and summarise the event.",
    pattern: {},
    cooldownSeconds: 30,
    action: `A webhook notification arrived. Read the entire payload.

1. Identify the sending service (look for service-specific fields / headers).
2. Determine what happened (event type, status change, alert).
3. Extract the most important details — who, what, when, severity.
4. Summarise in 2–3 actionable sentences.
5. Recommend whether this needs immediate attention or is informational.`,
    contextHint: "Add: what service sends here, and what actions different event types require.",
  },
];
