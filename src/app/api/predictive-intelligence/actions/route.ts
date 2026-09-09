import { NextResponse } from 'next/server';

import { UnknownAlertKeyError, recordAction } from '@/server/alertStateStore';
import { POST_LIMIT_PER_MINUTE } from '@/server/rateLimit';
import {
  NO_STORE_HEADERS,
  enforceRateLimit,
  errorResponse,
  errorToResponse,
} from '@/server/predictiveRouteSupport';
import { validateAlertActionRequest } from '@/server/validateIntelligenceRequest';
import type {
  AlertStateEntry,
  PredictiveIntelligenceErrorBody,
} from '@/types/predictive-intelligence';

/** Returned when the body is not declared as JSON. */
const UNSUPPORTED_MEDIA_TYPE_MESSAGE = 'Request body must be sent as application/json.';

/** Returned when a well-formed alert id names nothing the store knows about. */
const UNKNOWN_ALERT_MESSAGE = 'That alert is no longer available.';

/** Returned when the body is not parseable JSON. */
const MALFORMED_JSON_MESSAGE = 'Request body must be valid JSON.';

/**
 * `POST /api/predictive-intelligence/actions`
 *
 * The write path, and the reason dismissal works at all: the server assembles the
 * list, so the server has to be told what the user dismissed. A client-only flag
 * could not filter a server-assembled response.
 *
 * Body: `{ alertId: "customerId:rule-id", action: "dismiss" | "action" }`.
 *
 * @returns 200 with the updated state entry, 400 for a malformed body, 404 for an
 *          unknown alert id — the one place a 404 is reachable, since a client can
 *          legitimately name an alert the server has since dropped — 415 for a
 *          non-JSON content type, 429 when rate limited, or 500.
 */
export async function POST(
  request: Request
): Promise<NextResponse<AlertStateEntry | PredictiveIntelligenceErrorBody>> {
  const limited = enforceRateLimit(request, POST_LIMIT_PER_MINUTE);
  if (limited !== null) {
    return limited;
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return errorResponse(UNSUPPORTED_MEDIA_TYPE_MESSAGE, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(MALFORMED_JSON_MESSAGE, 400);
  }

  try {
    const { alertId, action } = validateAlertActionRequest(body);
    const entry = recordAction(alertId, action, Date.now());

    return NextResponse.json(entry, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof UnknownAlertKeyError) {
      return errorResponse(UNKNOWN_ALERT_MESSAGE, 404);
    }
    return errorToResponse(error, 'action');
  }
}
