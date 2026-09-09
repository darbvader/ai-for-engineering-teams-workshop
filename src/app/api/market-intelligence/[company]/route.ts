import { NextResponse } from 'next/server';

import { marketIntelligenceService } from '@/services/MarketIntelligenceService';
import { isMarketIntelligenceError } from '@/services/errors';
import type {
  MarketIntelligence,
  MarketIntelligenceErrorBody,
} from '@/types/market-intelligence';

/** Generic body returned for anything the client cannot act on. */
const INTERNAL_ERROR_MESSAGE = 'Market intelligence is temporarily unavailable. Please try again.';

/** Sent when the path segment is not decodable as a percent-escaped string. */
const UNDECODABLE_SEGMENT_MESSAGE = 'Company name could not be read from the request.';

/**
 * Headers applied to every response.
 *
 * `no-store` keeps HTTP caching from masking the service-level TTL — otherwise a
 * stale intermediary could serve a payload the service has already regenerated.
 */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Decodes a URL path segment, treating a malformed percent-escape as a client
 * error rather than letting `decodeURIComponent` throw a 500.
 *
 * @param segment - Raw path segment.
 * @returns The decoded segment, or `null` if it is malformed.
 */
function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Builds an error response with the shared no-store headers.
 *
 * @param message - User-safe message. Never a stack trace or internal path.
 * @param status - HTTP status code.
 */
function errorResponse(message: string, status: number): NextResponse<MarketIntelligenceErrorBody> {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE_HEADERS });
}

/**
 * `GET /api/market-intelligence/[company]`
 *
 * Validates the request shape, delegates to the service, and maps errors to
 * statuses. No business logic lives here.
 *
 * A company name containing `/` changes the URL path and produces Next's own 404
 * before this handler runs, which is why callers must `encodeURIComponent` the
 * name and why the validator rejects `/` as defence in depth.
 *
 * @returns 200 with a `MarketIntelligence` payload, 400 for an unusable company
 *          name, or 500 with a generic message.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ company: string }> }
): Promise<NextResponse<MarketIntelligence | MarketIntelligenceErrorBody>> {
  const { company: rawCompanySegment } = await params;

  const decodedCompany = decodePathSegment(rawCompanySegment);
  if (decodedCompany === null) {
    return errorResponse(UNDECODABLE_SEGMENT_MESSAGE, 400);
  }

  try {
    const marketIntelligence = await marketIntelligenceService.getMarketIntelligence(decodedCompany);
    return NextResponse.json(marketIntelligence, { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (isMarketIntelligenceError(error) && error.code === 'INVALID_COMPANY') {
      return errorResponse(error.message, 400);
    }

    // The real error is logged server-side only; the body stays generic so no
    // internal detail reaches the client.
    console.error('[market-intelligence] request failed', error);
    return errorResponse(INTERNAL_ERROR_MESSAGE, 500);
  }
}
