import { beforeEach, describe, expect, it } from 'vitest';

import {
  GET_LIMIT_PER_MINUTE,
  POST_LIMIT_PER_MINUTE,
  SHARED_BUCKET_KEY,
  WINDOW_MS,
  clientKeyFor,
  consume,
  resetRateLimits,
  trackedKeyCount,
} from './rateLimit';

const START_MS = Date.parse('2026-09-09T10:00:00Z');

describe('rateLimit', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('allows requests up to the limit and refuses the next one', () => {
    for (let request = 0; request < GET_LIMIT_PER_MINUTE; request += 1) {
      expect(consume('client-a', GET_LIMIT_PER_MINUTE, START_MS).allowed).toBe(true);
    }

    expect(consume('client-a', GET_LIMIT_PER_MINUTE, START_MS).allowed).toBe(false);
  });

  it('reports a Retry-After of at least one second while refusing', () => {
    for (let request = 0; request < POST_LIMIT_PER_MINUTE; request += 1) {
      consume('client-b', POST_LIMIT_PER_MINUTE, START_MS);
    }

    const refused = consume('client-b', POST_LIMIT_PER_MINUTE, START_MS + WINDOW_MS - 1);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('opens a fresh window exactly at the boundary', () => {
    for (let request = 0; request < POST_LIMIT_PER_MINUTE; request += 1) {
      consume('client-c', POST_LIMIT_PER_MINUTE, START_MS);
    }

    expect(consume('client-c', POST_LIMIT_PER_MINUTE, START_MS + WINDOW_MS - 1).allowed).toBe(false);
    expect(consume('client-c', POST_LIMIT_PER_MINUTE, START_MS + WINDOW_MS).allowed).toBe(true);
  });

  it('isolates buckets per key, so one noisy client cannot silence another', () => {
    for (let request = 0; request < POST_LIMIT_PER_MINUTE; request += 1) {
      consume('noisy', POST_LIMIT_PER_MINUTE, START_MS);
    }

    expect(consume('noisy', POST_LIMIT_PER_MINUTE, START_MS).allowed).toBe(false);
    expect(consume('quiet', POST_LIMIT_PER_MINUTE, START_MS).allowed).toBe(true);
    expect(trackedKeyCount()).toBe(2);
  });

  describe('clientKeyFor', () => {
    it('uses the first entry of x-forwarded-for', () => {
      const request = new Request('https://example.test/', {
        headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.9' },
      });
      expect(clientKeyFor(request)).toBe('203.0.113.5');
    });

    it('falls back to one shared bucket when the header is absent', () => {
      expect(clientKeyFor(new Request('https://example.test/'))).toBe(SHARED_BUCKET_KEY);
    });
  });
});
