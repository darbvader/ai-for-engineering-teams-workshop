/**
 * Pure search helpers for customer filtering.
 *
 * Deliberately free of React and of props: every function here is a plain
 * input/output transform, so it can be called and asserted in isolation. That
 * is what makes these the first things to gain real tests when a test runner
 * arrives, and it keeps the matching rules in one readable place instead of
 * spread through a component body.
 *
 * The rules implemented here are, in order: normalize both sides with the same
 * function, split the query into terms, and require *every* term to appear as a
 * substring of the customer's `name` + `company` haystack.
 */

import type { Customer } from '@/data/mock-customers';

/**
 * Combining diacritical marks, stripped after NFD decomposition so that `José`
 * and `Jose` compare equal.
 *
 * Written as an explicit code-point range rather than `/\p{Diacritic}/gu` on
 * purpose: Unicode property escapes need an ES2018 target and `tsconfig.json`
 * pins `"target": "ES2017"`, so the property-escape form fails type-checking.
 */
const COMBINING_DIACRITICAL_MARKS = /[\u0300-\u036f]/g;

/** Any run of whitespace, collapsed to a single space during normalization. */
const WHITESPACE_RUN = /\s+/g;

/** Separator between search terms once the query has been normalized. */
const SEARCH_TERM_SEPARATOR = ' ';

/**
 * Reduces arbitrary text to the canonical form used on both sides of a match.
 *
 * Steps, in order: trim, lowercase, collapse internal whitespace runs to single
 * spaces, decompose to Unicode NFD, then remove combining diacritical marks.
 * Applying one function to both the query and the customer text is what makes
 * matching symmetric — two normalization paths are the classic source of "it
 * matches one way but not the other".
 *
 * Not locale collation: `ß`/`ss`, `æ`/`ae`, and Turkish dotless `ı` are not
 * folded, and no `Intl.Collator` is involved.
 *
 * @param value Raw text from a search input or a customer record.
 * @returns The normalized, diacritic-free, single-spaced lowercase form.
 */
export function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(WHITESPACE_RUN, SEARCH_TERM_SEPARATOR)
    .normalize('NFD')
    .replace(COMBINING_DIACRITICAL_MARKS, '');
}

/**
 * Builds the single normalized string a customer is matched against.
 *
 * Only `name` and `company` are included. `email` and `domains` are excluded
 * even though they contain company-like text: matching on a field the card does
 * not display leaves the user unable to see why a result appeared.
 *
 * Callers should compute this once per customer and cache it — recomputing a
 * haystack per keystroke is the work this function exists to let you avoid.
 *
 * @param customer Any object carrying the customer's `name` and `company`.
 * @returns The normalized `"name company"` haystack.
 */
export function buildCustomerSearchHaystack(
  customer: Pick<Customer, 'name' | 'company'>
): string {
  return normalizeSearchText(`${customer.name} ${customer.company}`);
}

/**
 * Splits an already-normalized query into its search terms.
 *
 * @param normalizedQuery Output of {@link normalizeSearchText}.
 * @returns One entry per whitespace-separated term; an empty array for an empty
 * query, which callers read as "no filtering applied".
 */
export function splitSearchQueryIntoTerms(normalizedQuery: string): string[] {
  if (normalizedQuery === '') {
    return [];
  }

  return normalizedQuery.split(SEARCH_TERM_SEPARATOR);
}

/**
 * The match predicate: AND across terms, substring within each term.
 *
 * An empty `searchTerms` array matches everything, which is how an empty query
 * shows the full list. Terms are compared with `String.prototype.includes`, so
 * the query is never compiled into a regular expression — input like `(` cannot
 * throw and `(a+)+$` cannot degrade catastrophically.
 *
 * @param haystack Output of {@link buildCustomerSearchHaystack}.
 * @param searchTerms Output of {@link splitSearchQueryIntoTerms}.
 * @returns `true` when every term appears somewhere in the haystack.
 */
export function haystackMatchesSearchTerms(haystack: string, searchTerms: string[]): boolean {
  return searchTerms.every((searchTerm) => haystack.includes(searchTerm));
}

/**
 * Convenience predicate matching one customer against one raw query.
 *
 * Normalizes both sides on every call, so it is meant for one-off checks and
 * assertions rather than for filtering a large list per keystroke; for that,
 * cache haystacks and use {@link haystackMatchesSearchTerms} directly.
 *
 * @param customer The customer to test.
 * @param searchQuery Raw, un-normalized query text.
 * @returns `true` when the customer matches the query.
 */
export function customerMatchesSearchQuery(
  customer: Pick<Customer, 'name' | 'company'>,
  searchQuery: string
): boolean {
  return haystackMatchesSearchTerms(
    buildCustomerSearchHaystack(customer),
    splitSearchQueryIntoTerms(normalizeSearchText(searchQuery))
  );
}
