import { NextResponse } from 'next/server';

import { GET_LIMIT_PER_MINUTE } from '@/server/rateLimit';
import {
  NO_STORE_HEADERS,
  enforceRateLimit,
  errorToResponse,
} from '@/server/predictiveRouteSupport';
import { validateIntelligenceRequest } from '@/server/validateIntelligenceRequest';
import { predictiveIntelligenceService } from '@/services/PredictiveIntelligenceService';
import type {
  PredictiveIntelligenceErrorBody,
  PredictiveIntelligenceResponse,
} from '@/types/predictive-intelligence';

/**
 * `GET /api/predictive-intelligence`
 *
 * A **collection** route, not `[customerId]`: the widget needs a list ranked
 * *across* customers, and the per-customer caps and global ordering cannot be
 * computed correctly from one customer at a time.
 *
 * Query parameters: `customerIds` (optional, comma-separated, max 50), `priority`
 * (`high`|`medium`), `timezone` (IANA). Validation happens on the server; the
 * widget's own checks are a convenience only.
 *
 * @returns 200 with the ranked payload, 400 for a malformed parameter, 429 when
 *          rate limited, or 500 with a generic message.
 */
export async function GET(
  request: Request
): Promise<NextResponse<PredictiveIntelligenceResponse | PredictiveIntelligenceErrorBody>> {
  const limited = enforceRateLimit(request, GET_LIMIT_PER_MINUTE);
  if (limited !== null) {
    return limited;
  }

  try {
    const { searchParams } = new URL(request.url);
    const intelligenceRequest = validateIntelligenceRequest(searchParams);
    const payload = await predictiveIntelligenceService.getIntelligence(intelligenceRequest);

    return NextResponse.json(payload, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorToResponse(error, 'read');
  }
}
