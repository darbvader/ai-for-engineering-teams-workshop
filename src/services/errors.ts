/**
 * Error types for the Market Intelligence service.
 */

/**
 * Failure codes the service can raise.
 *
 * There is deliberately no `NOT_FOUND`: mock generation always succeeds for a
 * valid name, so a 404 path would be unreachable code.
 */
export type MarketIntelligenceErrorCode = 'INVALID_COMPANY' | 'INTERNAL';

/**
 * Error thrown by `MarketIntelligenceService`.
 *
 * The `message` is user-safe by contract — the route echoes it straight into the
 * response body, so it must never carry a stack trace, an internal path, or
 * upstream detail.
 */
export class MarketIntelligenceError extends Error {
  readonly code: MarketIntelligenceErrorCode;

  /**
   * @param code - Failure category, used by the route to pick a status.
   * @param message - User-safe explanation.
   */
  constructor(code: MarketIntelligenceErrorCode, message: string) {
    super(message);
    this.name = 'MarketIntelligenceError';
    this.code = code;

    // Keeps `instanceof` working when the class is down-levelled to ES5.
    Object.setPrototypeOf(this, MarketIntelligenceError.prototype);
  }
}

/**
 * Narrows an unknown thrown value to a `MarketIntelligenceError`.
 *
 * @param candidate - Value caught in a `catch` block.
 * @returns Whether the value is a `MarketIntelligenceError`.
 */
export function isMarketIntelligenceError(
  candidate: unknown
): candidate is MarketIntelligenceError {
  return candidate instanceof MarketIntelligenceError;
}
