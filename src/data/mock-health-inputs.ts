import type { HealthScoreInput } from '@/lib/healthCalculator';

/**
 * Mock health-score inputs, keyed by `Customer.id` so every entry in
 * `mockCustomers` resolves.
 *
 * These are the *raw relationship signals* the calculator consumes — payment
 * behaviour, engagement, contract posture, support experience — and they are
 * deliberately **not** reverse-engineered from `Customer.healthScore`.
 * Reconciling that stored field with the computed score is out of scope for this
 * feature, so a computed score may differ from the number on the customer
 * record. The signals are shaped to be plausible for each account and, between
 * them, to exercise every presentation state of `CustomerHealthDisplay`:
 *
 * | Id | Scenario |
 * |---|---|
 * | `1` | Complete data, healthy |
 * | `2` | Complete data, warning — late payments and thin engagement |
 * | `3` | Complete data, critical — overdue, disengaged, lapsed contract |
 * | `4` | Annually billed: `billingCycleDays: 365`, so recency is not penalised |
 * | `5` | Support data absent — confidence `0.9`, still banded |
 * | `6` | New customer, `tenureDays: 12` — provisional but banded |
 * | `7` | Carries a `previous` score, so a trend is reported |
 * | `8` | Support only, with `null` signals — confidence `0.1`, deliberately unbanded |
 *
 * No entry for a customer is a legitimate state: the widget renders the no-data
 * presentation rather than crashing.
 */
export const mockHealthInputs: Record<string, HealthScoreInput> = {
  // Acme Corp — punctual, embedded, renewing comfortably.
  '1': {
    payment: { daysSinceLastPayment: 8, averagePaymentDelayDays: 1, overdueAmount: 0 },
    engagement: { loginsLast30Days: 18, featureUsageCount: 7, supportTicketsLast30Days: 2 },
    contract: {
      daysUntilRenewal: 140,
      contractValue: 48000,
      previousContractValue: 42000,
      recentUpgradeCount: 1,
      recentDowngradeCount: 0
    },
    support: { satisfactionScore: 5, averageResolutionTimeHours: 6, escalationCount: 0 },
    tenureDays: 620,
    billingCycleDays: 30
  },

  // TechStart Inc — paying late, using little, renewal close.
  '2': {
    payment: { daysSinceLastPayment: 41, averagePaymentDelayDays: 12, overdueAmount: 1800 },
    engagement: { loginsLast30Days: 6, featureUsageCount: 2, supportTicketsLast30Days: 5 },
    contract: {
      daysUntilRenewal: 24,
      contractValue: 12000,
      previousContractValue: 12000,
      recentUpgradeCount: 0,
      recentDowngradeCount: 0
    },
    support: { satisfactionScore: 3, averageResolutionTimeHours: 30, escalationCount: 1 },
    tenureDays: 410,
    billingCycleDays: 30
  },

  // Global Solutions — overdue, silent, contract already lapsed.
  '3': {
    payment: { daysSinceLastPayment: 96, averagePaymentDelayDays: 27, overdueAmount: 9500 },
    engagement: { loginsLast30Days: 1, featureUsageCount: 1, supportTicketsLast30Days: 12 },
    contract: {
      daysUntilRenewal: -10,
      contractValue: 9000,
      previousContractValue: 24000,
      recentUpgradeCount: 0,
      recentDowngradeCount: 2
    },
    support: { satisfactionScore: 1, averageResolutionTimeHours: 68, escalationCount: 4 },
    tenureDays: 900,
    billingCycleDays: 30
  },

  // Innovation Labs — annual contract; 210 days since payment is normal here.
  '4': {
    payment: { daysSinceLastPayment: 210, averagePaymentDelayDays: 0, overdueAmount: 0 },
    engagement: { loginsLast30Days: 22, featureUsageCount: 8, supportTicketsLast30Days: 1 },
    contract: {
      daysUntilRenewal: 155,
      contractValue: 180000,
      previousContractValue: 150000,
      recentUpgradeCount: 2,
      recentDowngradeCount: 0
    },
    support: { satisfactionScore: 5, averageResolutionTimeHours: 3, escalationCount: 0 },
    tenureDays: 1100,
    billingCycleDays: 365
  },

  // Future Systems — no support data at all, so the factor is excluded.
  '5': {
    payment: { daysSinceLastPayment: 22, averagePaymentDelayDays: 6, overdueAmount: 0 },
    engagement: { loginsLast30Days: 9, featureUsageCount: 4, supportTicketsLast30Days: 3 },
    contract: {
      daysUntilRenewal: 60,
      contractValue: 30000,
      previousContractValue: 32000,
      recentUpgradeCount: 0,
      recentDowngradeCount: 0
    },
    tenureDays: 300,
    billingCycleDays: 30
  },

  // Smart Ventures — twelve days old, so the score is provisional by tenure.
  '6': {
    payment: { daysSinceLastPayment: 5, averagePaymentDelayDays: 0, overdueAmount: 0 },
    engagement: { loginsLast30Days: 11, featureUsageCount: 5, supportTicketsLast30Days: 3 },
    contract: { daysUntilRenewal: 353, contractValue: 18000, recentUpgradeCount: 0 },
    support: { satisfactionScore: 4, averageResolutionTimeHours: 12, escalationCount: 0 },
    tenureDays: 12,
    billingCycleDays: 30
  },

  // DataFlow Analytics — carries a previous score, so a trend is reported.
  '7': {
    payment: { daysSinceLastPayment: 14, averagePaymentDelayDays: 2, overdueAmount: 0 },
    engagement: { loginsLast30Days: 16, featureUsageCount: 7, supportTicketsLast30Days: 2 },
    contract: {
      daysUntilRenewal: 200,
      contractValue: 96000,
      previousContractValue: 88000,
      recentUpgradeCount: 1,
      recentDowngradeCount: 0
    },
    support: { satisfactionScore: 4, averageResolutionTimeHours: 18, escalationCount: 0 },
    tenureDays: 750,
    billingCycleDays: 30,
    previous: { score: 79 }
  },

  // CloudFirst Solutions — support signals only, the rest genuinely unknown.
  // Confidence lands at 0.1, so the score is reported but deliberately unbanded.
  '8': {
    payment: { daysSinceLastPayment: null, averagePaymentDelayDays: null, overdueAmount: null },
    support: { satisfactionScore: 2, averageResolutionTimeHours: 50, escalationCount: 3 },
    tenureDays: 240,
    billingCycleDays: 30
  }
};
