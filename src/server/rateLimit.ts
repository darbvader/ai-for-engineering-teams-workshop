/**
 * In-memory fixed-window rate limiter for this feature's route handlers.
 *
 * **Process-local and trivially bypassed by a distributed client.** It runs in
 * one Next server process, holds its counters in a module-level `Map`, and keys
 * on `x-forwarded-for`, a header a client controls. It is a courtesy brake on
 * accidental request storms — a misbehaving poll loop, a held-down refresh key —
 * and it is *not* a security control. Durable, multi-instance limiting is out of
 * scope.
 */

/** Requests permitted per window, per key. */
export const GET_LIMIT_PER_MINUTE = 60;
export const POST_LIMIT_PER_MINUTE = 30;

/** Window length. Fixed, not sliding: simple to reason about and to test. */
export const WINDOW_MS = 60_000;

/** Ceiling on tracked keys, so a spoofed-header flood cannot grow the map forever. */
export const MAX_TRACKED_KEYS = 10_000;

/** Used when no client key can be derived, so every such caller shares one bucket. */
export const SHARED_BUCKET_KEY = 'shared';

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Buckets hung off `globalThis`.
 *
 * Next.js bundles each route handler separately, so a plain module-level `Map`
 * would give the read route and the action route independent limiters keyed on
 * the same client. One shared map keeps the per-key isolation the limiter
 * promises. Still process-local, and still not a security control.
 */
const BUCKETS_SYMBOL = Symbol.for('predictive-intelligence.rateLimitBuckets');

function getBuckets(): Map<string, Bucket> {
  const host = globalThis as typeof globalThis & { [BUCKETS_SYMBOL]?: Map<string, Bucket> };
  host[BUCKETS_SYMBOL] ??= new Map<string, Bucket>();
  return host[BUCKETS_SYMBOL];
}

/** Outcome of one limiter consultation. */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Whole seconds until the window resets. At least 1, so `Retry-After` is never `0`. */
  retryAfterSeconds: number;
}

/**
 * Derives the bucket key for a request.
 *
 * Falls back to a single shared bucket when no forwarding header is present,
 * which is the common case in local development.
 *
 * @param request - The incoming request.
 * @returns The bucket key.
 */
export function clientKeyFor(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) {
    return SHARED_BUCKET_KEY;
  }

  const first = forwarded.split(',')[0]?.trim() ?? '';
  return first.length > 0 && first.length <= 64 ? first : SHARED_BUCKET_KEY;
}

/**
 * Consumes one token for a key.
 *
 * @param key - Bucket key, from {@link clientKeyFor}.
 * @param limit - Requests permitted per window.
 * @param now - Epoch milliseconds; injected so the window boundary is testable.
 * @returns Whether the request is allowed, and when to retry if not.
 */
export function consume(key: string, limit: number, now: number): RateLimitResult {
  const buckets = getBuckets();
  const existing = buckets.get(key);

  if (existing === undefined || now - existing.windowStart >= WINDOW_MS) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      evictExpired(now);
    }
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: WINDOW_MS / 1000 };
  }

  const elapsed = now - existing.windowStart;
  const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000));

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds };
}

/** Drops every window that has already closed. Called only when the map is full. */
function evictExpired(now: number): void {
  const buckets = getBuckets();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) {
      buckets.delete(key);
    }
  }
}

/** Clears every bucket. Tests only. */
export function resetRateLimits(): void {
  getBuckets().clear();
}

/** Number of tracked keys. Tests and diagnostics only. */
export function trackedKeyCount(): number {
  return getBuckets().size;
}
