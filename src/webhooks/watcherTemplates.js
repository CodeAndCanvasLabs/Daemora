/**
 * Watcher Templates — pre-configured watcher setups for common services.
 *
 * Each template pre-fills the watcher creation form:
 * - name, description, action (agent instructions), pattern, cooldown
 *
 * The action prompt is the critical part — it tells the agent exactly
 * what to extract from the payload and what to do with it.
 *
 * Pattern limitation: our matching only works on top-level JSON keys.
 * Templates use broad top-level patterns and rely on the action prompt
 * to handle nested payload structures.
 */

export const WATCHER_TEMPLATES = [
  // ── DevOps ──────────────────────────────────────────────────────────────────

  {
    id: "github-new-issue",
    category: "DevOps",
    name: "github-new-issue",
    label: "GitHub — New Issue Opened",
    description: "Triage new GitHub issues — assess priority, suggest labels, summarize",
    pattern: { action: "opened" },
    cooldownSeconds: 10,
    action: `A new GitHub issue was opened. Read the webhook payload below carefully.

Extract:
- Issue title and number
- Author (login)
- Issue body (the description)
- Any existing labels

Then:
1. Assess priority: critical (production down, security), high (broken feature, data loss), medium (bug, regression), low (enhancement, question, docs)
2. Summarize the issue in 2-3 sentences
3. Recommend labels (bug, feature, docs, question, good-first-issue)
4. Suggest next steps (who should look at this, what to investigate)

Keep the summary concise and actionable.`,
    contextHint: "Add your repo details: stack, main branch, team members, labeling conventions",
  },

  {
    id: "github-pr-review",
    category: "DevOps",
    name: "github-pr-review",
    label: "GitHub — PR Ready for Review",
    description: "Summarize new pull requests and flag potential concerns",
    pattern: { action: "opened" },
    cooldownSeconds: 10,
    action: `A new pull request was opened. Read the webhook payload below.

Extract:
- PR title, number, and author
- Description/body
- Changed files count, additions, deletions
- Base branch and head branch

Then:
1. Summarize what the PR does in 2-3 sentences
2. Flag concerns: large PR (>500 lines), missing description, targeting main directly, breaking changes mentioned
3. Note if tests are mentioned or missing
4. Suggest reviewers based on the files changed (if context provides team info)

Keep it concise — this goes to the team channel.`,
    contextHint: "Add: repo stack, team members and their areas, PR conventions, required reviewers",
  },

  {
    id: "deploy-notification",
    category: "DevOps",
    name: "deploy-notification",
    label: "Deployment Notification",
    description: "Track deployments — summarize what was deployed and where",
    pattern: {},
    cooldownSeconds: 10,
    action: `A deployment event was received. Read the webhook payload.

Extract whatever is available:
- Environment (staging, production, preview)
- Version, commit SHA, or tag
- Who triggered the deploy
- Status (success, failed, in progress)
- Service/app name

Summarize: what was deployed, where, by whom, and whether it succeeded. If the deployment failed, extract the error reason.`,
    contextHint: "Add: environments (staging URL, prod URL), deployment pipeline, rollback procedures",
  },

  {
    id: "uptime-alert",
    category: "DevOps",
    name: "uptime-alert",
    label: "Uptime Monitor — Service Down",
    description: "Investigate service downtime alerts and report findings",
    pattern: {},
    cooldownSeconds: 300,
    action: `A service health alert was received. Read the webhook payload.

Extract whatever is available:
- Service/monitor name and URL
- Status (down, degraded, recovered)
- Error type (timeout, DNS, 5xx, connection refused, SSL)
- Downtime duration (if provided)
- Region/location (if provided)

Then:
1. Summarize the incident in 2-3 sentences
2. Suggest likely causes based on the error type
3. If status is "recovered", note the total downtime
4. Flag if this is a recurring issue (check if similar alerts fired recently)

Use a 5-minute cooldown to avoid alert fatigue from flapping services.`,
    contextHint: "Add: service architecture, common failure modes, on-call contacts, status page URL",
  },

  // ── Business ────────────────────────────────────────────────────────────────

  {
    id: "stripe-payment-failed",
    category: "Business",
    name: "stripe-payment-failed",
    label: "Stripe — Payment Failed",
    description: "Alert on failed payments with customer details and recovery suggestions",
    pattern: { type: "payment_intent.payment_failed" },
    cooldownSeconds: 60,
    action: `A Stripe payment has failed. Read the webhook payload.

Extract from the event data:
- Customer email or ID
- Payment amount and currency
- Failure reason (card declined, insufficient funds, expired, etc.)
- Payment method type (card, bank transfer, etc.)
- Invoice or subscription ID (if applicable)

Then:
1. Summarize what happened in plain language
2. Suggest recovery action based on the failure reason:
   - Card declined → suggest customer update payment method
   - Insufficient funds → suggest retry in a few days
   - Expired card → notify customer to update card
   - Processing error → suggest automatic retry
3. Note if this customer has had previous payment failures`,
    contextHint: "Add: your product name, support email, payment retry policy, dunning process",
  },

  {
    id: "stripe-subscription-canceled",
    category: "Business",
    name: "stripe-subscription-canceled",
    label: "Stripe — Subscription Canceled",
    description: "Track subscription cancellations for churn monitoring",
    pattern: { type: "customer.subscription.deleted" },
    cooldownSeconds: 60,
    action: `A subscription was canceled on Stripe. Read the webhook payload.

Extract:
- Customer email or ID
- Plan/product name and price
- Cancellation reason (if available in metadata)
- Subscription duration (created date to now)
- Whether it was immediate or end-of-period

Then:
1. Summarize the cancellation
2. Calculate how long the customer was subscribed
3. If cancellation reason is available, categorize it (price, features, competitor, not using)
4. Suggest a retention action if the customer was long-term (>3 months)`,
    contextHint: "Add: product tiers and pricing, retention offers, win-back email templates",
  },

  {
    id: "form-submission",
    category: "Business",
    name: "form-submission",
    label: "Form Submission",
    description: "Process incoming form submissions — categorize and route",
    pattern: {},
    cooldownSeconds: 0,
    action: `A form was submitted via webhook. Read the payload.

Extract whatever fields are available:
- Submitter name and email
- Subject or topic
- Message body
- Form type (contact, support, feedback, demo request, etc.)

Then:
1. Categorize the submission: inquiry, support request, feedback, sales lead, spam
2. Summarize the key message in 1-2 sentences
3. Suggest routing (who should handle this)
4. If it looks like spam, flag it clearly`,
    contextHint: "Add: your product/service, team routing rules (support → X, sales → Y), form source URL",
  },

  // ── General ─────────────────────────────────────────────────────────────────

  {
    id: "generic-alert",
    category: "General",
    name: "generic-alert",
    label: "Generic Alert / Notification",
    description: "Process any webhook and summarize the event",
    pattern: {},
    cooldownSeconds: 30,
    action: `A webhook notification was received. Read the entire payload.

1. Identify what service sent it (look for service-specific fields, headers, or metadata)
2. Determine what happened (event type, status change, alert, notification)
3. Extract the most important details (who, what, when, severity)
4. Summarize in 2-3 actionable sentences
5. Recommend whether this needs immediate attention or is informational only`,
    contextHint: "Add: what service sends to this webhook, what actions to take for different event types",
  },
];

export default WATCHER_TEMPLATES;
