/**
 * Request validation for the Predictive Intelligence routes.
 *
 * The single source of truth for what a well-formed request looks like, shared
 * by the read route, the action route, and the widget. Validation and
 * normalization happen **here, on the server**; anything the client checks is a
 * convenience, never the enforcement point.
 */

import { isSupportedTimeZone } from '@/server/businessHours';
import { PredictiveIntelligenceError } from '@/services/errors';
import type { AlertPriority } from '@/types/predictive-intelligence';

/** Ceiling on ids per request, so one call cannot ask for unbounded work. */
export const MAX_CUSTOMER_IDS = 50;

/** A customer id: url-safe, bounded. */
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** An alert id: `${customerId}:${ruleId}`, with the shipped kebab-case rule ids. */
const ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}:[a-z][a-z-]{1,40}$/;

const PRIORITIES: readonly AlertPriority[] = Object.freeze(['high', 'medium']);

/** A validated read request. */
export interface IntelligenceRequest {
  /** `undefined` means "every mock customer". */
  customerIds?: string[];
  priority?: AlertPriority;
  /** A supported IANA zone, when the client supplied one. */
  timezone?: string;
}

function invalid(message: string): never {
  throw new PredictiveIntelligenceError('INVALID_INPUT', message);
}

/**
 * Validates and normalizes `GET /api/predictive-intelligence` query parameters.
 *
 * A *malformed* id fails the whole request; a well-formed id that simply does not
 * exist does not — the service reports it in `unknownIds`, because asking about a
 * customer who has been removed is a legitimate thing for a client to do.
 *
 * @param searchParams - Raw query parameters.
 * @returns The validated request.
 * @throws {PredictiveIntelligenceError} `INVALID_INPUT` for anything malformed.
 */
export function validateIntelligenceRequest(searchParams: URLSearchParams): IntelligenceRequest {
  const request: IntelligenceRequest = {};

  const rawCustomerIds = searchParams.get('customerIds');
  if (rawCustomerIds !== null) {
    const ids = rawCustomerIds
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (ids.length === 0) {
      invalid('customerIds must list at least one customer id.');
    }
    if (ids.length > MAX_CUSTOMER_IDS) {
      invalid(`customerIds accepts at most ${MAX_CUSTOMER_IDS} ids per request.`);
    }
    for (const id of ids) {
      if (!CUSTOMER_ID_PATTERN.test(id)) {
        invalid('customerIds must contain only letters, numbers, hyphens, and underscores.');
      }
    }

    request.customerIds = ids;
  }

  const rawPriority = searchParams.get('priority');
  if (rawPriority !== null) {
    if (!PRIORITIES.includes(rawPriority as AlertPriority)) {
      invalid('priority must be "high" or "medium".');
    }
    request.priority = rawPriority as AlertPriority;
  }

  const rawTimezone = searchParams.get('timezone');
  if (rawTimezone !== null) {
    // A silent fallback to the server's zone would decide a user-facing question
    // in the wrong place, so an unusable zone is a client error.
    if (!isSupportedTimeZone(rawTimezone)) {
      invalid('timezone must be a supported IANA time zone identifier.');
    }
    request.timezone = rawTimezone;
  }

  return request;
}

/** A validated action request. */
export interface AlertActionRequest {
  alertId: string;
  action: 'dismiss' | 'action';
}

/**
 * Validates a `POST /api/predictive-intelligence/actions` body.
 *
 * Shape only. Whether the `alertId` names an alert the store knows about is the
 * store's question, and its answer is a 404 rather than a 400.
 *
 * @param body - Parsed JSON body, untrusted.
 * @returns The validated action request.
 * @throws {PredictiveIntelligenceError} `INVALID_INPUT` for anything malformed.
 */
export function validateAlertActionRequest(body: unknown): AlertActionRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('Request body must be a JSON object.');
  }

  const { alertId, action } = body as Record<string, unknown>;

  if (typeof alertId !== 'string' || !ALERT_ID_PATTERN.test(alertId)) {
    invalid('alertId must be of the form "customerId:rule-id".');
  }
  if (action !== 'dismiss' && action !== 'action') {
    invalid('action must be "dismiss" or "action".');
  }

  return { alertId, action };
}
