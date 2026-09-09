import {
  calculateMockSentiment,
  generateMockMarketData,
  DISPLAYED_HEADLINE_COUNT,
} from '@/data/mock-market-intelligence';
import { validateCompanyName } from '@/lib/validateCompanyName';
import { MarketIntelligenceError } from '@/services/errors';
import type { MarketIntelligence } from '@/types/market-intelligence';

/** Cache lifetime for a generated payload. */
export const DEFAULT_CACHE_TTL_MS = 600_000;

/** Hard ceiling on cache size, evicted least-recently-*accessed* first. */
export const MAX_CACHE_ENTRIES = 100;

/** Bounds of the simulated network delay applied on a cache miss. */
const MINIMUM_SIMULATED_DELAY_MS = 300;
const MAXIMUM_SIMULATED_DELAY_MS = 800;

/** Constructor overrides. Every one exists so the service is testable. */
export interface MarketIntelligenceServiceOptions {
  /** Clock source. Injectable so TTL expiry can be tested by advancing it rather than waiting. */
  now?: () => number;
  /** Cache lifetime in milliseconds. */
  ttlMs?: number;
  /** Simulated delay, in milliseconds, applied on a cache miss only. */
  delayMs?: () => number;
}

interface CacheEntry {
  data: MarketIntelligence;
  expiresAt: number;
}

/**
 * Builds the payload for a company from the mock data module.
 *
 * A pure function: no cache, no clock beyond the timestamp handed in, no class
 * instance. Sentiment banding lives in `calculateMockSentiment`, which is the
 * single source of truth for the label.
 *
 * @param normalizedCompany - Already-validated, normalized company name.
 * @param generatedAtMs - Epoch milliseconds recorded as `lastUpdated`.
 * @returns The complete market intelligence payload.
 */
export function buildMarketIntelligence(
  normalizedCompany: string,
  generatedAtMs: number
): MarketIntelligence {
  const marketData = generateMockMarketData(normalizedCompany);
  const sentiment = calculateMockSentiment(marketData.headlines);

  return {
    company: normalizedCompany,
    sentiment,
    articleCount: marketData.articleCount,
    headlines: marketData.headlines.slice(0, DISPLAYED_HEADLINE_COUNT),
    lastUpdated: new Date(generatedAtMs).toISOString(),
  };
}

/**
 * Derives the cache key for a company name.
 *
 * Lowercased, so `"Acme Corp"` and `"acme corp"` share one entry.
 *
 * @param normalizedCompany - Validated, normalized company name.
 * @returns The cache key.
 */
function toCacheKey(normalizedCompany: string): string {
  return normalizedCompany.toLowerCase();
}

/**
 * Market intelligence lookups over mock data, with a bounded TTL cache.
 *
 * Nothing here reaches the network. The "delay" is a `setTimeout` that makes the
 * loading state visible in the workshop demo.
 */
export class MarketIntelligenceService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly delayMs: () => number;

  constructor(options: MarketIntelligenceServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.delayMs =
      options.delayMs ??
      (() =>
        MINIMUM_SIMULATED_DELAY_MS +
        Math.random() * (MAXIMUM_SIMULATED_DELAY_MS - MINIMUM_SIMULATED_DELAY_MS));
  }

  /**
   * Looks up market intelligence for a company.
   *
   * Validates first, so an invalid name never reaches data generation. On a
   * cache hit the simulated delay is skipped and the stored payload — including
   * its original `lastUpdated` — is returned unchanged.
   *
   * @param company - Untrusted company name.
   * @returns The market intelligence payload.
   * @throws {MarketIntelligenceError} `INVALID_COMPANY` for a name that fails
   *         validation; `INTERNAL` if generation itself fails.
   */
  async getMarketIntelligence(company: string): Promise<MarketIntelligence> {
    const validation = validateCompanyName(company);
    if (!validation.ok) {
      throw new MarketIntelligenceError('INVALID_COMPANY', validation.reason);
    }

    const normalizedCompany = validation.value;
    const cacheKey = toCacheKey(normalizedCompany);
    const cached = this.readFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    await this.simulateNetworkDelay();

    let generated: MarketIntelligence;
    try {
      generated = buildMarketIntelligence(normalizedCompany, this.now());
    } catch {
      throw new MarketIntelligenceError(
        'INTERNAL',
        'Market intelligence is temporarily unavailable. Please try again.'
      );
    }

    this.writeToCache(cacheKey, generated);
    return generated;
  }

  /** Empties the cache. Exposed for tests. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Current number of cached entries, including any not yet evicted on access. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Reads an entry, treating an expired one as a miss and evicting it.
   *
   * On a hit the entry is deleted and re-set. A `Map` preserves *insertion*
   * order, so without that step eviction would be FIFO rather than LRU.
   *
   * @param cacheKey - Lowercased company name.
   * @returns The cached payload, or `undefined` on a miss.
   */
  private readFromCache(cacheKey: string): MarketIntelligence | undefined {
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.cache.delete(cacheKey);
      return undefined;
    }

    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    return entry.data;
  }

  /**
   * Stores an entry, evicting the least-recently-accessed one past the cap.
   *
   * @param cacheKey - Lowercased company name.
   * @param data - Payload to store.
   */
  private writeToCache(cacheKey: string, data: MarketIntelligence): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { data, expiresAt: this.now() + this.ttlMs });

    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const leastRecentlyUsedKey = this.cache.keys().next().value;
      if (leastRecentlyUsedKey === undefined) {
        break;
      }
      this.cache.delete(leastRecentlyUsedKey);
    }
  }

  /** Waits out the simulated network delay. Called on a cache miss only. */
  private async simulateNetworkDelay(): Promise<void> {
    const delay = this.delayMs();
    if (delay <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay);
    });
  }
}

/**
 * Process-wide instance used by the route handler, so the cache survives across
 * requests instead of being rebuilt per invocation.
 */
export const marketIntelligenceService = new MarketIntelligenceService();
