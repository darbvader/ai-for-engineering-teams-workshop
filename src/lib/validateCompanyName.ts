/**
 * Single source of truth for company-name validation.
 *
 * Imported by the API route, the service, and the widget so the rule cannot
 * drift between the three. The client copy is a convenience that surfaces the
 * failure early; the server copy is the enforcement point.
 */

/** Maximum accepted length, measured after trimming. */
export const MAX_COMPANY_NAME_LENGTH = 100;

/** Minimum accepted length, measured after trimming. */
export const MIN_COMPANY_NAME_LENGTH = 1;

/**
 * Letters, digits, spaces and a small punctuation set.
 *
 * Anything else is rejected — notably `<`, `>`, `/`, `\`, backticks and control
 * characters. Rejecting `/` is defence in depth: a name containing one changes
 * the URL path and would otherwise produce Next's own 404 before this ever ran.
 */
export const COMPANY_NAME_PATTERN = /^[\p{L}\p{N} .,&'()-]+$/u;

/** Result of validating a candidate company name. */
export type CompanyNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Validates and normalizes a company name.
 *
 * Normalization is trim, then collapse internal whitespace runs to one space.
 * Only `value` — never the raw input — should be interpolated into generated
 * headlines or echoed back in a response.
 *
 * @param input - Untrusted candidate, of unknown type.
 * @returns `{ ok: true, value }` with the normalized name, or `{ ok: false, reason }`
 *          carrying user-safe text with no internal detail.
 */
export function validateCompanyName(input: unknown): CompanyNameResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'Company name is required.' };
  }

  const normalized = input.trim().replace(/\s+/g, ' ');

  if (normalized.length < MIN_COMPANY_NAME_LENGTH) {
    return { ok: false, reason: 'Company name is required.' };
  }

  if (normalized.length > MAX_COMPANY_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Company name must be ${MAX_COMPANY_NAME_LENGTH} characters or fewer.`,
    };
  }

  if (!COMPANY_NAME_PATTERN.test(normalized)) {
    return {
      ok: false,
      reason: "Company name may contain only letters, numbers, spaces and . , & ' ( ) -",
    };
  }

  return { ok: true, value: normalized };
}
