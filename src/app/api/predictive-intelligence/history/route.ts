import { NextResponse } from 'next/server';

import { getAudit, getFatigueMetrics } from '@/server/alertStateStore';
import { GET_LIMIT_PER_MINUTE } from '@/server/rateLimit';
import {
  NO_STORE_HEADERS,
  enforceRateLimit,
  errorToResponse,
} from '@/server/predictiveRouteSupport';
import type {
  PredictiveHistoryResponse,
  PredictiveIntelligenceErrorBody,
} from '@/types/predictive-intelligence';

/**
 * `GET /api/predictive-intelligence/history`
 *
 * The activity log and the alert-fatigue readout.
 *
 * Both come from a process-local ring buffer that resets on server restart. It is
 * **not a compliance audit trail**, and the history view says so on screen.
 *
 * @returns 200 with the log and fatigue metrics, 429 when rate limited, or 500.
 */
export async function GET(
  request: Request
): Promise<NextResponse<PredictiveHistoryResponse | PredictiveIntelligenceErrorBody>> {
  const limited = enforceRateLimit(request, GET_LIMIT_PER_MINUTE);
  if (limited !== null) {
    return limited;
  }

  try {
    const nowMs = Date.now();

    return NextResponse.json(
      {
        audit: [...getAudit()],
        fatigue: getFatigueMetrics(nowMs),
        generatedAt: new Date(nowMs).toISOString(),
      },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    return errorToResponse(error, 'history');
  }
}
