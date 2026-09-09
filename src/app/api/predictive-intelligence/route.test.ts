import { beforeEach, describe, expect, it } from 'vitest';

import { GET as historyRoute } from '@/app/api/predictive-intelligence/history/route';
import { POST as actionsRoute } from '@/app/api/predictive-intelligence/actions/route';
import { GET as readRoute } from '@/app/api/predictive-intelligence/route';
import { reset as resetAlertState } from '@/server/alertStateStore';
import {
  GET_LIMIT_PER_MINUTE,
  POST_LIMIT_PER_MINUTE,
  resetRateLimits,
} from '@/server/rateLimit';
import { predictiveIntelligenceService } from '@/services/PredictiveIntelligenceService';
import type {
  AlertStateEntry,
  PredictiveHistoryResponse,
  PredictiveIntelligenceErrorBody,
  PredictiveIntelligenceResponse,
} from '@/types/predictive-intelligence';

const ORIGIN = 'https://dashboard.test';

/** A request with a distinct forwarding key, so limiter buckets stay isolated. */
function readRequest(query = '', clientKey = 'test-client'): Request {
  return new Request(`${ORIGIN}/api/predictive-intelligence${query}`, {
    headers: { 'x-forwarded-for': clientKey },
  });
}

function actionRequest(
  body: unknown,
  { contentType = 'application/json', clientKey = 'test-client' } = {}
): Request {
  return new Request(`${ORIGIN}/api/predictive-intelligence/actions`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-forwarded-for': clientKey },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('predictive-intelligence routes', () => {
  beforeEach(() => {
    resetAlertState();
    resetRateLimits();
    predictiveIntelligenceService.clearCache();
  });

  describe('GET /api/predictive-intelligence', () => {
    it('returns 200 with the full payload', async () => {
      const response = await readRoute(readRequest('?timezone=UTC'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as PredictiveIntelligenceResponse;
      expect(Array.isArray(body.alerts)).toBe(true);
      expect(body.summary).toBeDefined();
      expect(typeof body.marketDataAvailable).toBe('boolean');
      expect(Array.isArray(body.unknownIds)).toBe(true);
      expect(Array.isArray(body.skipped)).toBe(true);
      expect(typeof body.evaluatedAt).toBe('string');
    }, 20_000);

    it('sets Cache-Control: no-store', async () => {
      const response = await readRoute(readRequest('?timezone=UTC'));
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }, 20_000);

    it('returns 400 with a sanitized body for a malformed customerIds value', async () => {
      const response = await readRoute(readRequest('?customerIds=1,<script>'));
      expect(response.status).toBe(400);

      const body = (await response.json()) as PredictiveIntelligenceErrorBody;
      expect(body.error).toBeTruthy();
      expect(body.error).not.toContain('<script>');
      expect(body.error).not.toContain('/workspaces');
      expect(body).not.toHaveProperty('stack');
    });

    it('returns 400 for an unknown priority literal', async () => {
      expect((await readRoute(readRequest('?priority=urgent'))).status).toBe(400);
    });

    it('returns 400 for more than 50 ids', async () => {
      const ids = Array.from({ length: 51 }, (_, index) => index + 1).join(',');
      expect((await readRoute(readRequest(`?customerIds=${ids}`))).status).toBe(400);
    });

    it('returns 400 for an unsupported timezone rather than falling back', async () => {
      expect((await readRoute(readRequest('?timezone=Mars%2FOlympus'))).status).toBe(400);
    });

    it('returns 200 and reports a well-formed unknown id', async () => {
      const response = await readRoute(readRequest('?customerIds=1,nope-999&timezone=UTC'));
      expect(response.status).toBe(200);

      const body = (await response.json()) as PredictiveIntelligenceResponse;
      expect(body.unknownIds).toEqual(['nope-999']);
    }, 20_000);

    it('returns 429 with Retry-After once the per-minute limit is exceeded', async () => {
      for (let request = 0; request < GET_LIMIT_PER_MINUTE; request += 1) {
        await readRoute(readRequest('?customerIds=1&timezone=UTC', 'burst-client'));
      }

      const limited = await readRoute(readRequest('?customerIds=1&timezone=UTC', 'burst-client'));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);

      // A different client key is unaffected.
      const other = await readRoute(readRequest('?customerIds=1&timezone=UTC', 'other-client'));
      expect(other.status).toBe(200);
    }, 60_000);
  });

  describe('POST /api/predictive-intelligence/actions', () => {
    async function seedAlert(): Promise<string> {
      const response = await readRoute(readRequest('?timezone=UTC', 'seed-client'));
      const body = (await response.json()) as PredictiveIntelligenceResponse;
      return body.alerts[0]!.id;
    }

    it('records a dismissal and returns the updated entry', async () => {
      const alertId = await seedAlert();
      const response = await actionsRoute(actionRequest({ alertId, action: 'dismiss' }));

      expect(response.status).toBe(200);
      const entry = (await response.json()) as AlertStateEntry;
      expect(entry.key).toBe(alertId);
      expect(entry.status).toBe('dismissed');
    }, 20_000);

    it('removes the dismissed alert from every subsequent read', async () => {
      const alertId = await seedAlert();
      await actionsRoute(actionRequest({ alertId, action: 'dismiss' }));
      predictiveIntelligenceService.clearCache();

      const response = await readRoute(readRequest('?timezone=UTC', 'seed-client'));
      const body = (await response.json()) as PredictiveIntelligenceResponse;
      expect(body.alerts.some((alert) => alert.id === alertId)).toBe(false);
    }, 30_000);

    it('returns 404 for a well-formed alert id the store has never seen', async () => {
      const response = await actionsRoute(
        actionRequest({ alertId: 'nope-999:payment-risk', action: 'dismiss' })
      );
      expect(response.status).toBe(404);
    });

    it('returns 415 for a non-JSON content type', async () => {
      const response = await actionsRoute(
        actionRequest({ alertId: '1:payment-risk', action: 'dismiss' }, { contentType: 'text/plain' })
      );
      expect(response.status).toBe(415);
    });

    it('returns 400 for an unparseable body', async () => {
      expect((await actionsRoute(actionRequest('{not json'))).status).toBe(400);
    });

    it('returns 400 for a malformed alertId', async () => {
      const response = await actionsRoute(actionRequest({ alertId: 'bogus', action: 'dismiss' }));
      expect(response.status).toBe(400);
    });

    it('returns 400 for an unknown action', async () => {
      const response = await actionsRoute(
        actionRequest({ alertId: '1:payment-risk', action: 'delete' })
      );
      expect(response.status).toBe(400);
    });

    it('returns 429 with Retry-After once the POST limit is exceeded', async () => {
      for (let request = 0; request < POST_LIMIT_PER_MINUTE; request += 1) {
        await actionsRoute(
          actionRequest({ alertId: 'nope-1:payment-risk', action: 'dismiss' }, { clientKey: 'post-burst' })
        );
      }

      const limited = await actionsRoute(
        actionRequest({ alertId: 'nope-1:payment-risk', action: 'dismiss' }, { clientKey: 'post-burst' })
      );
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    });
  });

  describe('GET /api/predictive-intelligence/history', () => {
    it('returns the audit log and fatigue metrics', async () => {
      await readRoute(readRequest('?timezone=UTC', 'history-seed'));

      const response = await historyRoute(
        new Request(`${ORIGIN}/api/predictive-intelligence/history`, {
          headers: { 'x-forwarded-for': 'history-client' },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');

      const body = (await response.json()) as PredictiveHistoryResponse;
      expect(body.audit.length).toBeGreaterThan(0);
      expect(body.fatigue.dismissalRateByRule.length).toBeGreaterThan(0);
      expect(Array.isArray(body.fatigue.recommendations)).toBe(true);
    }, 20_000);
  });
});
