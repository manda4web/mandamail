import { describe, it, expect } from 'vitest';

// Regression for the webhook CHECK-constraint crash: raw Stripe statuses
// (trialing, unpaid, incomplete...) were written straight to subscriptions,
// whose CHECK only allows trial/active/canceled/past_due/expired.

import { mapStripeStatus } from '../../api/routes/stripe.js';

describe('mapStripeStatus — Stripe → app subscription status', () => {
  it('maps every known Stripe status to a CHECK-valid app status', () => {
    expect(mapStripeStatus('active')).toBe('active');
    expect(mapStripeStatus('trialing')).toBe('trial');
    expect(mapStripeStatus('past_due')).toBe('past_due');
    expect(mapStripeStatus('unpaid')).toBe('past_due');
    expect(mapStripeStatus('incomplete')).toBe('past_due');
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
    expect(mapStripeStatus('canceled')).toBe('canceled');
    expect(mapStripeStatus('paused')).toBe('past_due');
  });

  it('degrades unknown statuses to past_due (7-day grace) instead of crashing the UPDATE', () => {
    expect(mapStripeStatus('some_new_stripe_status')).toBe('past_due');
  });
});
