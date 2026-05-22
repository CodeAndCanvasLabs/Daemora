/**
 * Billing — pluggable provider abstraction. Today's provider is
 * Contra, which gives us hosted Stripe-backed subscription links
 * but (as of writing) no webhooks. So Flow B = "user pays via the
 * link, then claims via daemora.com/payment-claim with the transaction
 * id; operator reconciles against Contra's dashboard".
 *
 * If/when Contra adds webhooks, switch by filling `handleWebhook` —
 * everything else stays the same.
 */

import type { Plan } from "../db/schema.js";

export interface CheckoutSession {
  readonly url: string;                 // where to redirect the user
  readonly provider: "contra";
  readonly externalId?: string;         // optional — Contra doesn't pre-issue ids
}

export interface BillingEvent {
  readonly kind: "subscription.activated" | "subscription.canceled" | "invoice.paid" | "invoice.failed";
  readonly externalId: string;
  readonly userEmail?: string;
  readonly plan?: Plan;
}

export interface BillingProvider {
  /** Return a hosted-checkout URL for the user to pay. */
  createCheckoutSession(opts: { userId: string; userEmail: string; plan: Plan }): Promise<CheckoutSession>;

  /** Webhook handler — undefined when the provider doesn't expose webhooks. */
  handleWebhook?(payload: unknown, signature: string): Promise<BillingEvent>;
}

// ── Contra ────────────────────────────────────────────────────────

export interface ContraProviderOpts {
  /** Map of plan id → Contra payment link URL. */
  readonly links: Partial<Record<Plan, string>>;
  /** Optional webhook signing secret if Contra ever exposes webhooks. */
  readonly webhookSecret?: string;
}

export class ContraProvider implements BillingProvider {
  constructor(private readonly opts: ContraProviderOpts) {}

  async createCheckoutSession(args: {
    userId: string;
    userEmail: string;
    plan: Plan;
  }): Promise<CheckoutSession> {
    const url = this.opts.links[args.plan];
    if (!url) throw new Error(`No Contra payment link configured for plan: ${args.plan}`);
    return { url, provider: "contra" };
  }

  // No webhooks today. When Contra exposes them, populate this:
  // async handleWebhook(payload, signature) { ... verify sig + decode ... }
}

// ── In-memory test provider ───────────────────────────────────────

/** Always returns the same URL; useful for unit tests of routes/services. */
export class FakeBillingProvider implements BillingProvider {
  readonly created: Array<{ userId: string; userEmail: string; plan: Plan }> = [];
  async createCheckoutSession(args: { userId: string; userEmail: string; plan: Plan }): Promise<CheckoutSession> {
    this.created.push(args);
    return { url: `https://fake.local/pay/${args.userId}/${args.plan}`, provider: "contra" };
  }
}
