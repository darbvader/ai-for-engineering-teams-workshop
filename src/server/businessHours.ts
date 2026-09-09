/**
 * Delivery-window helpers for alert notifications.
 *
 * Pure: every function takes the instant and the zone as arguments and reads no
 * clock of its own.
 *
 * **The timezone is the viewer's, not the server's.** Deciding when a human is at
 * work is a user-facing judgement, so the client sends its IANA zone and the
 * server's own resolved zone is only a fallback. Local parts are computed with
 * `Intl.DateTimeFormat`, never `Date#getHours()` on a UTC-parsed value and never
 * a fixed offset, so DST transitions are handled by the platform's tz database
 * rather than by arithmetic that is wrong twice a year.
 *
 * Holiday calendars are out of scope.
 */

/** Monday–Friday, 09:00–17:00 local. `endHour` is exclusive. */
export const BUSINESS_WINDOW = Object.freeze({ startHour: 9, endHour: 17 });

/** Days on which notifications are delivered, as `Date#getUTCDay`-style indices. */
const BUSINESS_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

/** Upper bound on the forward search for the next open window. */
const MAX_DEFERRAL_DAYS = 8;

const MINUTE_MS = 60_000;
const COARSE_STEP_MS = 30 * MINUTE_MS;

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

/** One formatter per zone; constructing them is the expensive part. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Whether the runtime recognises an IANA zone identifier.
 *
 * Uses `Intl.supportedValuesOf` where available and falls back to asking
 * `Intl.DateTimeFormat` to construct, which throws a `RangeError` for an unknown
 * zone. The fallback matters because `supportedValuesOf` is not present on every
 * runtime this may execute on.
 *
 * @param candidate - Untrusted zone identifier.
 * @returns Whether the zone can be used for formatting.
 */
export function isSupportedTimeZone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 64) {
    return false;
  }

  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;

  if (typeof supportedValuesOf === 'function') {
    try {
      if (supportedValuesOf('timeZone').includes(candidate)) {
        return true;
      }
    } catch {
      // Fall through to the constructor probe.
    }
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/** The server's own zone, used only when the client supplies none. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Local weekday and wall-clock time for an instant in a zone. */
export interface LocalParts {
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * Resolves an instant to local weekday and wall-clock time.
 *
 * @param epochMs - The instant.
 * @param timeZone - A supported IANA zone.
 * @returns Local parts in that zone.
 */
export function getLocalParts(epochMs: number, timeZone: string): LocalParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  let weekday = 0;
  let hour = 0;
  let minute = 0;

  for (const part of parts) {
    if (part.type === 'weekday') {
      weekday = WEEKDAY_INDEX[part.value] ?? 0;
    } else if (part.type === 'hour') {
      // `hour12: false` renders midnight as "24" in some ICU versions.
      hour = Number.parseInt(part.value, 10) % 24;
    } else if (part.type === 'minute') {
      minute = Number.parseInt(part.value, 10);
    }
  }

  return { weekday, hour, minute };
}

/**
 * Whether an instant falls inside the delivery window in a zone.
 *
 * @param epochMs - The instant.
 * @param timeZone - A supported IANA zone.
 */
export function isWithinBusinessHours(epochMs: number, timeZone: string): boolean {
  const { weekday, hour } = getLocalParts(epochMs, timeZone);
  return (
    BUSINESS_WEEKDAYS.includes(weekday) &&
    hour >= BUSINESS_WINDOW.startHour &&
    hour < BUSINESS_WINDOW.endHour
  );
}

/**
 * The first instant at or after `epochMs` that falls inside the delivery window.
 *
 * Searches forward rather than computing a local calendar date, because the
 * offset between the two can change mid-search on a DST transition day. A coarse
 * 30-minute sweep finds the containing half hour, then a one-minute sweep finds
 * the exact boundary — bounded, and correct across a transition.
 *
 * @param epochMs - The instant to defer from.
 * @param timeZone - A supported IANA zone.
 * @returns The window-open instant, or `epochMs` when already inside.
 */
export function nextBusinessWindowOpen(epochMs: number, timeZone: string): number {
  if (isWithinBusinessHours(epochMs, timeZone)) {
    return epochMs;
  }

  const limit = epochMs + MAX_DEFERRAL_DAYS * 24 * 60 * MINUTE_MS;

  for (let coarse = epochMs + COARSE_STEP_MS; coarse <= limit; coarse += COARSE_STEP_MS) {
    if (!isWithinBusinessHours(coarse, timeZone)) {
      continue;
    }

    // Walk back to the first minute that is still inside this window.
    let candidate = coarse;
    for (let step = 1; step <= COARSE_STEP_MS / MINUTE_MS; step += 1) {
      const earlier = coarse - step * MINUTE_MS;
      if (earlier < epochMs || !isWithinBusinessHours(earlier, timeZone)) {
        break;
      }
      candidate = earlier;
    }
    return candidate;
  }

  // Unreachable for a Mon–Fri window, but a bounded loop needs a defined exit.
  return limit;
}
