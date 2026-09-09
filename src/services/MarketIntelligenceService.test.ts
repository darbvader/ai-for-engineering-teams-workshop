import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  MarketIntelligenceService,
} from './MarketIntelligenceService';
import { MarketIntelligenceError } from './errors';

/** A controllable clock, so TTL is asserted by advancing time rather than sleeping. */
function createTestClock(startMs = 1_700_000_000_000) {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advanceBy: (deltaMs: number) => {
      currentMs += deltaMs;
    },
  };
}

/** Builds a service with a controllable clock and no simulated delay by default. */
function createService(overrides: { now?: () => number; delayMs?: () => number } = {}) {
  return new MarketIntelligenceService({
    now: overrides.now,
    delayMs: overrides.delayMs ?? (() => 0),
  });
}

describe('MarketIntelligenceService', () => {
  let clock: ReturnType<typeof createTestClock>;

  beforeEach(() => {
    clock = createTestClock();
  });

  describe('validation and errors', () => {
    it('throws MarketIntelligenceError, not a bare Error, for an invalid name', async () => {
      const service = createService({ now: clock.now });
      await expect(service.getMarketIntelligence('<script>')).rejects.toBeInstanceOf(
        MarketIntelligenceError
      );
    });

    it('tags an invalid name with INVALID_COMPANY', async () => {
      const service = createService({ now: clock.now });
      await expect(service.getMarketIntelligence('   ')).rejects.toMatchObject({
        code: 'INVALID_COMPANY',
      });
    });

    it('never emits a NOT_FOUND code — a valid name always generates data', async () => {
      const service = createService({ now: clock.now });
      const result = await service.getMarketIntelligence('A Company Nobody Has Heard Of');
      expect(result.company).toBe('A Company Nobody Has Heard Of');
      expect(result.headlines.length).toBeGreaterThan(0);
    });

    it('does not generate data for an invalid name', async () => {
      const service = createService({ now: clock.now });
      await expect(service.getMarketIntelligence('Acme/Corp')).rejects.toBeInstanceOf(
        MarketIntelligenceError
      );
      expect(service.cacheSize).toBe(0);
    });

    it('rejects a name longer than 100 characters', async () => {
      const service = createService({ now: clock.now });
      await expect(service.getMarketIntelligence('a'.repeat(101))).rejects.toMatchObject({
        code: 'INVALID_COMPANY',
      });
    });
  });

  describe('payload shape', () => {
    it('returns at most three headlines and an article count that covers them', async () => {
      const service = createService({ now: clock.now });
      const result = await service.getMarketIntelligence('Acme Corp');

      expect(result.headlines.length).toBeLessThanOrEqual(3);
      expect(result.articleCount).toBeGreaterThanOrEqual(result.headlines.length);
      expect(new Date(result.lastUpdated).toISOString()).toBe(result.lastUpdated);
      expect(result.sentiment.score).toBeGreaterThanOrEqual(-1);
      expect(result.sentiment.score).toBeLessThanOrEqual(1);
    });

    it('echoes the normalized name rather than the raw input', async () => {
      const service = createService({ now: clock.now });
      const result = await service.getMarketIntelligence('  Acme    Corp  ');
      expect(result.company).toBe('Acme Corp');
    });

    it('records lastUpdated from the injected clock', async () => {
      const service = createService({ now: clock.now });
      const result = await service.getMarketIntelligence('Acme Corp');
      expect(result.lastUpdated).toBe(new Date(clock.now()).toISOString());
    });
  });

  describe('caching', () => {
    it('returns an identical payload inside the TTL, lastUpdated included', async () => {
      const service = createService({ now: clock.now });
      const first = await service.getMarketIntelligence('Acme Corp');

      clock.advanceBy(DEFAULT_CACHE_TTL_MS - 1);
      const second = await service.getMarketIntelligence('Acme Corp');

      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(second.lastUpdated).toBe(first.lastUpdated);
    });

    it('skips the simulated delay on a cache hit', async () => {
      let delayCallCount = 0;
      const service = new MarketIntelligenceService({
        now: clock.now,
        delayMs: () => {
          delayCallCount += 1;
          return 0;
        },
      });

      await service.getMarketIntelligence('Acme Corp');
      expect(delayCallCount).toBe(1);

      await service.getMarketIntelligence('Acme Corp');
      expect(delayCallCount).toBe(1);
    });

    it('regenerates with a newer lastUpdated once the clock passes the TTL', async () => {
      const service = createService({ now: clock.now });
      const first = await service.getMarketIntelligence('Acme Corp');

      clock.advanceBy(DEFAULT_CACHE_TTL_MS + 1);
      const second = await service.getMarketIntelligence('Acme Corp');

      expect(second.lastUpdated).not.toBe(first.lastUpdated);
      expect(Date.parse(second.lastUpdated)).toBeGreaterThan(Date.parse(first.lastUpdated));
    });

    it('treats an entry expiring exactly at now() as a miss', async () => {
      const service = createService({ now: clock.now });
      const first = await service.getMarketIntelligence('Acme Corp');

      clock.advanceBy(DEFAULT_CACHE_TTL_MS);
      const second = await service.getMarketIntelligence('Acme Corp');

      expect(second.lastUpdated).not.toBe(first.lastUpdated);
    });

    it('honours a custom ttlMs', async () => {
      const service = new MarketIntelligenceService({
        now: clock.now,
        ttlMs: 1_000,
        delayMs: () => 0,
      });
      const first = await service.getMarketIntelligence('Acme Corp');

      clock.advanceBy(1_001);
      const second = await service.getMarketIntelligence('Acme Corp');

      expect(second.lastUpdated).not.toBe(first.lastUpdated);
    });

    it('treats differently-cased names as one entry', async () => {
      const service = createService({ now: clock.now });
      await service.getMarketIntelligence('Acme Corp');
      await service.getMarketIntelligence('acme corp');

      expect(service.cacheSize).toBe(1);
    });

    it('clearCache empties the cache', async () => {
      const service = createService({ now: clock.now });
      await service.getMarketIntelligence('Acme Corp');
      expect(service.cacheSize).toBe(1);

      service.clearCache();
      expect(service.cacheSize).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    it('caps the cache at MAX_CACHE_ENTRIES', async () => {
      const service = createService({ now: clock.now });
      for (let index = 0; index < MAX_CACHE_ENTRIES + 20; index += 1) {
        await service.getMarketIntelligence(`Company ${index}`);
      }
      expect(service.cacheSize).toBe(MAX_CACHE_ENTRIES);
    });

    it('evicts the least-recently-accessed entry, not the oldest-inserted', async () => {
      let delayCallCount = 0;
      const service = new MarketIntelligenceService({
        now: clock.now,
        delayMs: () => {
          delayCallCount += 1;
          return 0;
        },
      });

      // Fill the cache. "Company 0" is the oldest *inserted*.
      for (let index = 0; index < MAX_CACHE_ENTRIES; index += 1) {
        await service.getMarketIntelligence(`Company ${index}`);
      }

      // Read it, making it the most recently *accessed*.
      await service.getMarketIntelligence('Company 0');
      const missesBeforeOverflow = delayCallCount;

      // Overflow by one, which must evict "Company 1" rather than "Company 0".
      await service.getMarketIntelligence('Overflow Company');
      expect(delayCallCount).toBe(missesBeforeOverflow + 1);

      // "Company 0" survived: still a hit, so no extra delay call.
      await service.getMarketIntelligence('Company 0');
      expect(delayCallCount).toBe(missesBeforeOverflow + 1);

      // "Company 1" was evicted: a miss, so the delay runs again.
      await service.getMarketIntelligence('Company 1');
      expect(delayCallCount).toBe(missesBeforeOverflow + 2);
    });
  });
});
