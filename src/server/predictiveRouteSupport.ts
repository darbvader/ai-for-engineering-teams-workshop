/**
 * Shared plumbing for the Predictive Intelligence route handlers.
 *
 * Kept out of the handlers themselves so the three routes cannot drift on status
 * mapping, headers, or how much detail an error body carries.
 */

import { NextResponse } from 'next/server';

import { clientKeyFor, consume } from '@/server/rateLimit';
import { isPredictiveIntelligenceError } from '@/services/errors';
import type { PredictiveIntelligenceErrorBody } from '@/types/predictive-intelligence';

/** Body returned for anything the client cannot act on. Deliberately uninformative. */
export const INTERNAL_ERROR_MESSAGE =
  'Predictive intelligence is temporarily unavailable. Please try again.';

/** Body returned when the limiter refuses a request. */
export const RATE_LIMITED_MESSAGE = 'Too many requests. Please retry shortly.';

/**
 * Headers on every response.
 *
 * `no-store` keeps HTTP caching from masking the service-level TTL; a cached
 * response would also freeze `priorityScore`, whose recency term decays with
 * wall-clock time.
 */
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Builds an error response.
 *
 * @param message - User-safe message. Never a stack trace or an internal path.
 * @param status - HTTP status.
 * @param extraHeaders - Additional headers, e.g. `Retry-After`.
 */
export function errorResponse(
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {}
): NextResponse<PredictiveIntelligenceErrorBody> {
  return NextResponse.json(
    { error: message },
    { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } }
  );
}

/**
 * Applies the rate limiter to a request.
 *
 * @param request - The incoming request.
 * @param limit - Requests permitted per window for this method.
 * @param nowMs - Epoch milliseconds.
 * @returns A `429` response when the limit is exceeded, otherwise `null`.
 */
export function enforceRateLimit(
  request: Request,
  limit: number,
  nowMs: number = Date.now()
): NextResponse<PredictiveIntelligenceErrorBody> | null {
  const outcome = consume(clientKeyFor(request), limit, nowMs);
  if (outcome.allowed) {
    return null;
  }

  return errorResponse(RATE_LIMITED_MESSAGE, 429, {
    'Retry-After': String(outcome.retryAfterSeconds),
  });
}

/**
 * Maps a thrown value to a response.
 *
 * The real error is logged server-side; the body stays generic so no internal
 * detail reaches the client.
 *
 * @param error - The caught value.
 * @param context - Log prefix, never sent to the client.
 */
export function errorToResponse(
  error: unknown,
  context: string
): NextResponse<PredictiveIntelligenceErrorBody> {
  if (isPredictiveIntelligenceError(error)) {
    if (error.code === 'INVALID_INPUT') {
      return errorResponse(error.message, 400);
    }
    if (error.code === 'RATE_LIMITED') {
      return errorResponse(error.message, 429);
    }
  }

  console.error(`[predictive-intelligence] ${context} failed`, error);
  return errorResponse(INTERNAL_ERROR_MESSAGE, 500);
}
