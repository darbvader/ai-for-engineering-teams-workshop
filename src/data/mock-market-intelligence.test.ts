import { describe, expect, it } from 'vitest';

import { mockCustomers } from './mock-customers';
import {
  calculateMockSentiment,
  classifySentimentScore,
  generateMockMarketData,
  MAXIMUM_CONFIDENCE,
  MINIMUM_CONFIDENCE,
  NEGATIVE_SENTIMENT_THRESHOLD,
  POSITIVE_SENTIMENT_THRESHOLD,
  type MockSentimentLabel,
} from './mock-market-intelligence';

describe('generateMockMarketData', () => {
  it('is deterministic for a fixed company name', () => {
    const first = generateMockMarketData('Acme Corp');
    const second = generateMockMarketData('Acme Corp');
    expect(second).toEqual(first);
  });

  it('produces timestamps that do not depend on wall-clock time', () => {
    // A hard-coded expectation is the point: it would fail if generation ever
    // reintroduced Date.now() or Math.random(), which would also break
    // determinism across process restarts.
    const { headlines } = generateMockMarketData('Acme Corp');
    expect(generateMockMarketData('Acme Corp').headlines.map((h) => h.publishedAt)).toEqual(
      headlines.map((h) => h.publishedAt)
    );
    headlines.forEach((headline) => {
      expect(new Date(headline.publishedAt).toISOString()).toBe(headline.publishedAt);
    });
  });

  it('is case- and whitespace-insensitive in its seeding', () => {
    const canonical = generateMockMarketData('Acme Corp');
    const shouted = generateMockMarketData('  ACME CORP  ');
    expect(shouted.articleCount).toBe(canonical.articleCount);
    expect(shouted.headlines.map((h) => h.source)).toEqual(
      canonical.headlines.map((h) => h.source)
    );
  });

  it('interpolates the company name into the headlines', () => {
    const { headlines } = generateMockMarketData('Acme Corp');
    expect(headlines.some((headline) => headline.title.includes('Acme Corp'))).toBe(true);
  });

  it('gives every headline a populated absolute https url', () => {
    mockCustomers.forEach((customer) => {
      const { headlines } = generateMockMarketData(customer.company);
      headlines.forEach((headline) => {
        expect(headline.url).toBeDefined();
        expect(headline.url).toMatch(/^https:\/\/[^\s]+$/);
      });
    });
  });

  it('returns at most three headlines with an articleCount that covers them', () => {
    mockCustomers.forEach((customer) => {
      const data = generateMockMarketData(customer.company);
      expect(data.headlines.length).toBeLessThanOrEqual(3);
      expect(data.articleCount).toBeGreaterThanOrEqual(data.headlines.length);
    });
  });
});

describe('calculateMockSentiment', () => {
  it('reaches all three bands across mockCustomers', () => {
    const labels = new Set<MockSentimentLabel>(
      mockCustomers.map(
        (customer) => calculateMockSentiment(generateMockMarketData(customer.company).headlines).label
      )
    );
    expect(labels).toEqual(new Set(['positive', 'neutral', 'negative']));
  });

  it('never saturates at plus or minus one for ordinary headline sets', () => {
    mockCustomers.forEach((customer) => {
      const { score } = calculateMockSentiment(generateMockMarketData(customer.company).headlines);
      expect(Math.abs(score)).toBeLessThan(1);
    });
  });

  it('scores three all-positive headlines at 0.5 rather than 1', () => {
    const headlines = [
      { title: 'Alpha Reports Record Revenue', source: 'S', publishedAt: '2025-01-01T00:00:00.000Z' },
      { title: 'Alpha Announces Partnership', source: 'S', publishedAt: '2025-01-01T00:00:00.000Z' },
      { title: 'Alpha Shows Momentum', source: 'S', publishedAt: '2025-01-01T00:00:00.000Z' },
    ];
    expect(calculateMockSentiment(headlines).score).toBeCloseTo(0.5, 10);
  });

  it('returns a neutral zero for an empty headline set', () => {
    expect(calculateMockSentiment([])).toEqual({ score: 0, label: 'neutral', confidence: 0 });
  });

  it('keeps confidence inside its bounds', () => {
    mockCustomers.forEach((customer) => {
      const { confidence } = calculateMockSentiment(
        generateMockMarketData(customer.company).headlines
      );
      expect(confidence).toBeGreaterThanOrEqual(MINIMUM_CONFIDENCE);
      expect(confidence).toBeLessThanOrEqual(MAXIMUM_CONFIDENCE);
    });
  });

  it('derives its label from the score bands', () => {
    mockCustomers.forEach((customer) => {
      const { score, label } = calculateMockSentiment(
        generateMockMarketData(customer.company).headlines
      );
      expect(label).toBe(classifySentimentScore(score));
    });
  });
});

describe('classifySentimentScore', () => {
  it.each([
    [1, 'positive'],
    [POSITIVE_SENTIMENT_THRESHOLD + 0.01, 'positive'],
    [POSITIVE_SENTIMENT_THRESHOLD, 'neutral'],
    [0, 'neutral'],
    [NEGATIVE_SENTIMENT_THRESHOLD, 'neutral'],
    [NEGATIVE_SENTIMENT_THRESHOLD - 0.01, 'negative'],
    [-1, 'negative'],
  ])('classifies %s as %s', (score, expected) => {
    expect(classifySentimentScore(score)).toBe(expected);
  });
});
