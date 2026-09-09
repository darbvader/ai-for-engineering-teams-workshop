import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CustomerSignals, DailySignals } from '@/lib/alerts';
import type { Customer } from '@/data/mock-customers';
import { mockCustomers } from '@/data/mock-customers';
import { getSignalsForCustomer } from '@/data/mock-customer-signals';
import { reset as resetAlertState, recordAction } from '@/server/alertStateStore';
import { MarketIntelligenceService } from '@/services/MarketIntelligenceService';
import { PredictiveIntelligenceError } from '@/services/errors';
import type { MarketIntelligence } from '@/types/market-intelligence';

import {
  MAX_INPUT_CACHE_ENTRIES,
  PredictiveIntelligenceService,
} from './PredictiveIntelligenceService';

/** Wednesday 10:00 UTC, matching the reference date the mock signals are built for. */
const BASE_MS = Date.parse('2026-09-09T10:00:00Z');
const AS_OF = '2026-09-09';
const HOUR_MS = 3_600_000;

/** A clock the tests advance, so TTL and recency are never asserted by waiting. */
function createTestClock(startMs = BASE_MS) {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advanceBy: (deltaMs: number) => {
      currentMs += deltaMs;
    },
  };
}

/** A market service that never touches the real generator. */
class StubMarketService extends MarketIntelligenceService {
  readonly calls: string[] = [];

  constructor(
    private readonly respond: (company: string) => MarketIntelligence | Promise<MarketIntelligence>
  ) {
    super({ delayMs: () => 0 });
  }

  override async getMarketIntelligence(company: string): Promise<MarketIntelligence> {
    this.calls.push(company);
    return this.respond(company);
  }
}

function marketPayload(
  company: string,
  overrides: Partial<MarketIntelligence['sentiment']> = {}
): MarketIntelligence {
  return {
    company,
    sentiment: { score: 0.4, label: 'positive', confidence: 0.7, ...overrides },
    articleCount: 5,
    headlines: [],
    lastUpdated: new Date(BASE_MS).toISOString(),
  };
}

/** Minimal valid signals for a synthetic customer, used for the cache tests. */
function syntheticSignals(customerId: string): CustomerSignals {
  const history: DailySignals[] = [
    {
      date: AS_OF,
      logins: 1,
      featuresUsed: ['reports'],
      supportTicketsOpened: 0,
      supportTicketsEscalated: 0,
      csatResponses: [],
      resolutionHours: [],
    },
  ];

  return {
    customerId,
    payment: {
      lastPaymentDate: '2026-09-01',
      averagePaymentDelayDays: 0,
      overdueAmount: 0,
      overdueSince: null,
    },
    contract: { renewalDate: '2027-06-01', annualRecurringRevenue: 25_000, lastUpgradeDate: null },
    history,
  };
}

function syntheticCustomers(count: number): Customer[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `syn-${index}`,
    name: `Customer ${index}`,
    company: `Company ${index}`,
    healthScore: 60,
  }));
}

describe('PredictiveIntelligenceService', () => {
  let clock: ReturnType<typeof createTestClock>;

  beforeEach(() => {
    clock = createTestClock();
    resetAlertState();
  });

  function createService(
    overrides: Partial<ConstructorParameters<typeof PredictiveIntelligenceService>[0]> = {}
  ) {
    return new PredictiveIntelligenceService({
      now: clock.now,
      delayMs: () => 0,
      marketService: new StubMarketService((company) => marketPayload(company)),
      ...overrides,
    });
  }

  describe('toHealthScoreInput', () => {
    it('derives every day-delta from the injected clock, not from the wall clock', () => {
      const service = createService();
      const signals = getSignalsForCustomer('1');
      expect(signals).toBeDefined();

      const atBase = service.toHealthScoreInput(signals!, BASE_MS);
      const tenDaysLater = service.toHealthScoreInput(signals!, BASE_MS + 10 * 24 * HOUR_MS);

      expect(tenDaysLater.payment?.daysSinceLastPayment).toBe(
        (atBase.payment?.daysSinceLastPayment ?? 0) + 10
      );
      expect(tenDaysLater.contract?.daysUntilRenewal).toBe(
        (atBase.contract?.daysUntilRenewal ?? 0) - 10
      );
    });

    it('passes money through in currency units, not cents', () => {
      const service = createService();
      const signals = getSignalsForCustomer('3');
      expect(signals).toBeDefined();

      const input = service.toHealthScoreInput(signals!, BASE_MS);

      // A cents-denominated value would be 100x the stored figure and would
      // inflate overdue severity to saturation while looking plausible.
      expect(input.contract?.contractValue).toBe(signals!.contract.annualRecurringRevenue);
      expect(input.payment?.overdueAmount).toBe(signals!.payment.overdueAmount);
      expect(input.contract?.contractValue).toBeLessThan(1_000_000);
    });
  });

  describe('response shape', () => {
    it('returns every documented field', async () => {
      const result = await createService().getIntelligence({ timezone: 'UTC' });

      expect(result).toHaveProperty('alerts');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('marketDataAvailable');
      expect(result).toHaveProperty('unknownIds');
      expect(result).toHaveProperty('skipped');
      expect(result.evaluatedAt).toBe(new Date(BASE_MS).toISOString());
    });

    it('populates every state field from the server store, with no placeholders', async () => {
      const result = await createService().getIntelligence({ timezone: 'UTC' });
      expect(result.alerts.length).toBeGreaterThan(0);

      for (const alert of result.alerts) {
        expect(alert.firstDetectedAt).toBe(new Date(BASE_MS).toISOString());
        expect(alert.lastTriggeredAt).toBe(new Date(BASE_MS).toISOString());
        expect(alert.occurrenceCount).toBe(1);
        expect(alert.status).toBe('active');
        expect(alert.id).toBe(`${alert.customerId}:${alert.ruleId}`);
      }
    });

    it('increments occurrenceCount across polls without duplicating an alert', async () => {
      const service = createService();
      const first = await service.getIntelligence({ timezone: 'UTC' });
      clock.advanceBy(2 * HOUR_MS);
      const second = await service.getIntelligence({ timezone: 'UTC' });

      expect(second.alerts).toHaveLength(first.alerts.length);
      expect(second.alerts[0]?.occurrenceCount).toBe(2);
      expect(second.alerts[0]?.firstDetectedAt).toBe(first.alerts[0]?.firstDetectedAt);
    });

    it('reports well-formed unknown ids without failing the request', async () => {
      const result = await createService().getIntelligence({
        customerIds: ['1', 'nope-999'],
        timezone: 'UTC',
      });

      expect(result.unknownIds).toEqual(['nope-999']);
      expect(result.summary.customersEvaluated).toBe(1);
    });

    it('filters by priority using the same field the summary counts', async () => {
      const result = await createService().getIntelligence({ priority: 'high', timezone: 'UTC' });

      expect(result.alerts.every((alert) => alert.priority === 'high')).toBe(true);
      expect(result.alerts).toHaveLength(result.summary.high);
    });
  });

  describe('compound escalation', () => {
    it('rewrites priority to high, sets the flag, and adds no extra alert', async () => {
      const service = createService({
        marketService: new StubMarketService((company) =>
          marketPayload(company, { label: 'negative', score: -0.65, confidence: 0.7 })
        ),
      });

      const result = await service.getIntelligence({ timezone: 'UTC' });
      const escalated = result.alerts.filter((alert) => alert.escalated);
      expect(escalated.length).toBeGreaterThan(0);

      for (const alert of escalated) {
        expect(alert.ruleId).toBe('market-sentiment-risk');
        expect(alert.priority).toBe('high');
        // The same customer carries at least one genuinely high alert.
        expect(
          result.alerts.some(
            (other) =>
              other.customerId === alert.customerId && other.priority === 'high' && !other.escalated
          )
        ).toBe(true);
      }

      // One alert per customer/rule pair, escalated or not.
      const ids = result.alerts.map((alert) => alert.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('counts an escalated alert as high in the summary and under the high filter', async () => {
      const service = createService({
        marketService: new StubMarketService((company) =>
          marketPayload(company, { label: 'negative', score: -0.65, confidence: 0.7 })
        ),
      });

      const all = await service.getIntelligence({ timezone: 'UTC' });
      const escalatedId = all.alerts.find((alert) => alert.escalated)?.id;
      expect(escalatedId).toBeDefined();

      const highOnly = await service.getIntelligence({ priority: 'high', timezone: 'UTC' });
      expect(highOnly.alerts.some((alert) => alert.id === escalatedId)).toBe(true);
    });
  });

  describe('input cache', () => {
    it('reuses cached signals and market data inside the TTL', async () => {
      const market = new StubMarketService((company) => marketPayload(company));
      const loadSignals = vi.fn(getSignalsForCustomer);
      const service = createService({ marketService: market, loadSignals });

      await service.getIntelligence({ timezone: 'UTC' });
      const signalCallsAfterFirst = loadSignals.mock.calls.length;
      const marketCallsAfterFirst = market.calls.length;

      clock.advanceBy(30_000);
      await service.getIntelligence({ timezone: 'UTC' });

      expect(loadSignals.mock.calls.length).toBe(signalCallsAfterFirst);
      expect(market.calls.length).toBe(marketCallsAfterFirst);
    });

    it('regenerates the inputs once the TTL has elapsed', async () => {
      const market = new StubMarketService((company) => marketPayload(company));
      const loadSignals = vi.fn(getSignalsForCustomer);
      const service = createService({ marketService: market, loadSignals, ttlMs: 60_000 });

      await service.getIntelligence({ timezone: 'UTC' });
      const firstCallCount = loadSignals.mock.calls.length;

      clock.advanceBy(60_001);
      await service.getIntelligence({ timezone: 'UTC' });

      expect(loadSignals.mock.calls.length).toBeGreaterThan(firstCallCount);
      expect(market.calls.length).toBeGreaterThan(mockCustomers.length - 1);
    });

    it('recomputes evaluatedAt and priorityScore even on a full cache hit', async () => {
      const service = createService({ ttlMs: 10 * 24 * HOUR_MS });

      const first = await service.getIntelligence({ timezone: 'UTC' });
      clock.advanceBy(3 * 24 * HOUR_MS);
      const later = await service.getIntelligence({ timezone: 'UTC' });

      expect(later.evaluatedAt).not.toBe(first.evaluatedAt);

      const firstAlert = first.alerts[0];
      const laterAlert = later.alerts.find((alert) => alert.id === firstAlert?.id);
      // Three days of recency decay on an otherwise unchanged alert.
      expect(laterAlert?.priorityScore).toBeLessThan(firstAlert?.priorityScore ?? 0);
    });

    it('evicts the least-recently-accessed entry, not the oldest-inserted', async () => {
      const customers = syntheticCustomers(MAX_INPUT_CACHE_ENTRIES + 1);
      const service = createService({
        loadCustomers: () => customers,
        loadSignals: (customerId) => syntheticSignals(customerId),
        ttlMs: 10 * 24 * HOUR_MS,
      });

      const early = customers[0]!.id;
      const secondInserted = customers[1]!.id;

      // Fill the cache to exactly the ceiling.
      await service.getIntelligence({
        customerIds: customers.slice(0, MAX_INPUT_CACHE_ENTRIES).map((c) => c.id),
        timezone: 'UTC',
      });
      expect(service.cacheSize).toBe(MAX_INPUT_CACHE_ENTRIES);

      // Touch the earliest-inserted entry so it becomes the most recently used.
      await service.getIntelligence({ customerIds: [early], timezone: 'UTC' });

      // Overflow by one; FIFO would drop `early`, true LRU drops the next-oldest.
      await service.getIntelligence({
        customerIds: [customers[MAX_INPUT_CACHE_ENTRIES]!.id],
        timezone: 'UTC',
      });

      expect(service.cacheSize).toBe(MAX_INPUT_CACHE_ENTRIES);

      // FIFO would have dropped `early`; true LRU drops the next-oldest instead.
      const inspectableCache = (service as unknown as { cache: Map<string, unknown> }).cache;
      expect(inspectableCache.has(early)).toBe(true);
      expect(inspectableCache.has(secondInserted)).toBe(false);
    });

    it('clearCache empties the cache', async () => {
      const service = createService();
      await service.getIntelligence({ timezone: 'UTC' });
      expect(service.cacheSize).toBeGreaterThan(0);

      service.clearCache();
      expect(service.cacheSize).toBe(0);
    });
  });

  describe('market degradation', () => {
    it('leaves other customers intact when one market fetch rejects', async () => {
      const failingCompany = mockCustomers[0]!.company;
      const market = new StubMarketService((company) => {
        if (company === failingCompany) {
          return Promise.reject(new Error('upstream unavailable'));
        }
        return marketPayload(company);
      });

      const result = await createService({ marketService: market }).getIntelligence({
        timezone: 'UTC',
      });

      expect(result.marketDataAvailable).toBe(true);
      expect(
        result.skipped.some(
          (entry) => entry.customerId === mockCustomers[0]!.id && entry.clause === 'market'
        )
      ).toBe(true);
    });

    it('keeps internal alerts when every market fetch rejects', async () => {
      const market = new StubMarketService(() => Promise.reject(new Error('upstream down')));
      const result = await createService({ marketService: market }).getIntelligence({
        timezone: 'UTC',
      });

      expect(result.marketDataAvailable).toBe(false);
      expect(result.alerts.length).toBeGreaterThan(0);
      expect(result.alerts.some((alert) => alert.ruleId === 'market-sentiment-risk')).toBe(false);
    });

    it('never substitutes a neutral-positive default for a failed fetch', async () => {
      const market = new StubMarketService(() => Promise.reject(new Error('upstream down')));
      const result = await createService({ marketService: market }).getIntelligence({
        timezone: 'UTC',
      });

      // "Unavailable" is reported as unavailable, not as "no market risk".
      expect(result.marketDataAvailable).toBe(false);
      expect(result.skipped.filter((entry) => entry.clause === 'market').length).toBeGreaterThan(0);
    });
  });

  describe('dismissal', () => {
    it('excludes a dismissed alert from every subsequent read', async () => {
      const service = createService();
      const first = await service.getIntelligence({ timezone: 'UTC' });
      const dismissedId = first.alerts[0]!.id;

      recordAction(dismissedId, 'dismiss', clock.now());
      clock.advanceBy(HOUR_MS);

      // Two concurrent sessions read the same server store.
      const [sessionA, sessionB] = await Promise.all([
        service.getIntelligence({ timezone: 'UTC' }),
        service.getIntelligence({ timezone: 'UTC' }),
      ]);

      expect(sessionA.alerts.some((alert) => alert.id === dismissedId)).toBe(false);
      expect(sessionB.alerts.some((alert) => alert.id === dismissedId)).toBe(false);
    });

    it('returns the alert once the dismissal TTL has elapsed, count preserved', async () => {
      // A short TTL keeps the advance inside the same simulated day, so the
      // dismissal timer is what is under test rather than the signal history.
      const shortTtl = { cooldown: { dismissalTtlHours: 2 } };
      const service = createService({ ttlMs: 30 * 24 * HOUR_MS });
      const first = await service.getIntelligence({ timezone: 'UTC', thresholds: shortTtl });
      const dismissedId = first.alerts[0]!.id;

      recordAction(dismissedId, 'dismiss', clock.now());
      clock.advanceBy(3 * HOUR_MS);

      const later = await service.getIntelligence({ timezone: 'UTC', thresholds: shortTtl });
      const returned = later.alerts.find((alert) => alert.id === dismissedId);

      expect(returned).toBeDefined();
      expect(returned?.occurrenceCount).toBeGreaterThan(1);
      expect(returned?.firstDetectedAt).toBe(first.alerts[0]?.firstDetectedAt);
    });
  });

  describe('caps', () => {
    it('keeps at most three alerts per customer and counts the rest', async () => {
      const service = createService({
        marketService: new StubMarketService((company) =>
          marketPayload(company, { label: 'negative', score: -0.9, confidence: 0.9 })
        ),
      });

      const result = await service.getIntelligence({ timezone: 'UTC' });
      const perCustomer = new Map<string, number>();

      for (const alert of result.alerts) {
        perCustomer.set(alert.customerId, (perCustomer.get(alert.customerId) ?? 0) + 1);
      }

      for (const count of perCustomer.values()) {
        expect(count).toBeLessThanOrEqual(3);
      }
      expect(result.summary.suppressedByCap).toBeGreaterThanOrEqual(0);
    });
  });

  describe('errors', () => {
    it('throws PredictiveIntelligenceError, not a bare Error, for bad thresholds', async () => {
      const service = createService();

      await expect(
        service.getIntelligence({ thresholds: { caps: { maxAlerts: 0 } }, timezone: 'UTC' })
      ).rejects.toBeInstanceOf(PredictiveIntelligenceError);
    });

    it('tags a bad threshold with INVALID_INPUT', async () => {
      const service = createService();

      await expect(
        service.getIntelligence({ thresholds: { market: { minConfidence: 5 } }, timezone: 'UTC' })
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });

  describe('security', () => {
    it('puts no email, domain, or exact monetary amount in any generated alert', async () => {
      const service = createService({
        marketService: new StubMarketService((company) =>
          marketPayload(company, { label: 'negative', score: -0.9, confidence: 0.9 })
        ),
      });

      const result = await service.getIntelligence({ timezone: 'UTC' });
      expect(result.alerts.length).toBeGreaterThan(0);

      const emails = mockCustomers.map((customer) => customer.email).filter(Boolean) as string[];
      const domains = mockCustomers.flatMap((customer) => customer.domains ?? []);

      for (const alert of result.alerts) {
        const text = [
          alert.title,
          alert.message,
          alert.triggeredClause,
          ...alert.recommendedActions,
          ...alert.evidence.map((row) => `${row.label} ${row.value}`),
        ].join(' | ');

        for (const email of emails) {
          expect(text).not.toContain(email);
        }
        for (const domain of domains) {
          expect(text).not.toContain(domain);
        }
        expect(text).not.toMatch(/\$\s?\d/);
      }
    });
  });

  describe('performance shape', () => {
    it('performs one market lookup per distinct company, not one per alert', async () => {
      const market = new StubMarketService((company) => marketPayload(company));
      await createService({ marketService: market }).getIntelligence({ timezone: 'UTC' });

      const distinctCompanies = new Set(mockCustomers.map((customer) => customer.company));
      expect(market.calls.length).toBe(distinctCompanies.size);
      expect(new Set(market.calls).size).toBe(market.calls.length);
    });
  });
});
