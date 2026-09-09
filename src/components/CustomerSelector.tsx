'use client';

import { type FocusEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { CustomerCard } from '@/components/CustomerCard';
import type { Customer } from '@/data/mock-customers';
import {
  buildCustomerSearchHaystack,
  haystackMatchesSearchTerms,
  normalizeSearchText,
  splitSearchQueryIntoTerms
} from '@/lib/customer-search';

/**
 * How long the result-count live region waits for typing to settle.
 *
 * Only the *announcement* is delayed; the visible count updates on every
 * keystroke. Without this, a five-character query produces five interruptions
 * in a screen reader. Filtering itself is never debounced — synchronous O(n)
 * matching is faster than any delay would be.
 */
export const SEARCH_ANNOUNCEMENT_DEBOUNCE_MS = 500;

export interface CustomerSelectorProps {
  /**
   * Customers to render, in the order they should appear. Treated as
   * immutable — never sorted, spliced, or mutated — and `id` is assumed unique.
   * The component performs no data fetching; the caller chooses between mock
   * data, fixtures, and the API.
   */
  customers: Customer[];
  /**
   * Id of the currently selected customer, or `null` for no selection.
   * Required, not optional: this component is controlled-only and holds no
   * selection state, so that the selection can outlive it.
   */
  selectedCustomerId: string | null;
  /**
   * Called with the whole customer on select, and with `null` when the
   * selected card is activated again (deselect). The full object rather than an
   * id spares every consumer of a selection event a lookup.
   */
  onSelectCustomer: (customer: Customer | null) => void;
  /**
   * Heading level for the customer name inside each card. Forwarded so the page
   * heading hierarchy has no skipped levels: the grid sits under a section
   * heading, so cards belong one level below it.
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * Searchable grid of customer cards that reports selection changes upward.
 *
 * Owns the **search query** and nothing else. It deliberately owns no
 * selection state: `selectedCustomerId` and `onSelectCustomer` are required
 * props, supplied by `useSelectedCustomer`, which is what lets a selection
 * survive unmount, view navigation, and a page reload. There is no uncontrolled
 * mode.
 *
 * `'use client'` is required for the search state and click handling, which
 * places the client boundary above `CustomerCard` — cards rendered here run as
 * Client Components regardless of their own default.
 *
 * Search matches every whitespace-separated term against a normalized
 * `name` + `company` haystack, so `john acme` finds John Smith at Acme Corp.
 * The query is only ever used for substring matching, never compiled into a
 * regular expression, and is rendered as JSX text so React escapes it.
 */
export function CustomerSelector({
  customers,
  selectedCustomerId,
  onSelectCustomer,
  headingLevel = 3
}: CustomerSelectorProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [resultAnnouncement, setResultAnnouncement] = useState('');

  const searchInputId = useId();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const customerGridRef = useRef<HTMLUListElement | null>(null);
  const hadFocusInsideGridRef = useRef(false);

  // One haystack per customer, rebuilt only when the array identity changes, so
  // a keystroke never re-normalizes every customer's fields.
  const searchableCustomers = useMemo(
    () =>
      customers.map((customer) => ({
        customer,
        haystack: buildCustomerSearchHaystack(customer)
      })),
    [customers]
  );

  const normalizedSearchQuery = useMemo(() => normalizeSearchText(searchQuery), [searchQuery]);
  const hasActiveSearchQuery = normalizedSearchQuery !== '';

  // Filtering is memoized on the pair that determines it. Input order is
  // preserved and `customers` is never mutated: `filter` returns a new array.
  const visibleCustomers = useMemo(() => {
    if (normalizedSearchQuery === '') {
      return customers;
    }

    const searchTerms = splitSearchQueryIntoTerms(normalizedSearchQuery);

    return searchableCustomers
      .filter(({ haystack }) => haystackMatchesSearchTerms(haystack, searchTerms))
      .map(({ customer }) => customer);
  }, [customers, searchableCustomers, normalizedSearchQuery]);

  const totalCustomerCount = customers.length;
  const visibleCustomerCount = visibleCustomers.length;
  const resultCountLabel = `${visibleCustomerCount} of ${totalCustomerCount} customers`;

  // Debounced announcement: one per settled query rather than one per keystroke.
  useEffect(() => {
    if (!hasActiveSearchQuery) {
      setResultAnnouncement('');
      return;
    }

    const announcementTimer = window.setTimeout(() => {
      setResultAnnouncement(`${visibleCustomerCount} of ${totalCustomerCount} customers match`);
    }, SEARCH_ANNOUNCEMENT_DEBOUNCE_MS);

    return () => window.clearTimeout(announcementTimer);
  }, [hasActiveSearchQuery, searchQuery, visibleCustomerCount, totalCustomerCount]);

  // Focus rescue: when a `customers` change unmounts the focused card, the
  // browser drops focus to <body>, which silently sends a keyboard user to the
  // top of the document. Move it to the declared fallback instead.
  useEffect(() => {
    if (!hadFocusInsideGridRef.current) {
      return;
    }

    const focusedElement = document.activeElement;
    const focusIsOrphaned = focusedElement === null || focusedElement === document.body;

    if (focusIsOrphaned) {
      hadFocusInsideGridRef.current = false;
      customerGridRef.current?.focus();
    }
  }, [customers]);

  const handleGridFocus = useCallback(() => {
    hadFocusInsideGridRef.current = true;
  }, []);

  const handleGridBlur = useCallback((event: FocusEvent<HTMLUListElement>) => {
    const nextFocusTarget = event.relatedTarget;

    // A null `relatedTarget` also happens when the focused card is removed from
    // the DOM, so only a real move to an element outside the grid counts as
    // leaving it — otherwise the rescue effect above would never fire.
    if (nextFocusTarget instanceof Node && !event.currentTarget.contains(nextFocusTarget)) {
      hadFocusInsideGridRef.current = false;
    }
  }, []);

  const handleSelectCustomer = useCallback(
    (customer: Customer) => {
      const isAlreadySelected = customer.id === selectedCustomerId;

      onSelectCustomer(isAlreadySelected ? null : customer);
    },
    [onSelectCustomer, selectedCustomerId]
  );

  // Clearing the search is a view operation: it never clears the selection.
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    // The clear control unmounts as soon as the query empties, so focus is
    // handed back to the input rather than left on a removed element.
    searchInputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor={searchInputId}
          className="text-sm font-medium text-neutral-800 dark:text-neutral-200"
        >
          Search customers by name or company
        </label>

        <div className="flex w-full flex-wrap items-center gap-2">
          <input
            id={searchInputId}
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="For example: acme"
            autoComplete="off"
            className="w-full flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 sm:w-auto dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-50 dark:focus-visible:outline-white"
          />

          {searchQuery !== '' && (
            <button
              type="button"
              onClick={handleClearSearch}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:outline-white"
            >
              Clear search
            </button>
          )}
        </div>

        {hasActiveSearchQuery && (
          <p className="text-sm text-neutral-700 dark:text-neutral-300">{resultCountLabel}</p>
        )}

        {/* Debounced, visually hidden: the visible count above updates instantly. */}
        <p aria-live="polite" className="sr-only">
          {resultAnnouncement}
        </p>
      </div>

      {totalCustomerCount === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-700 dark:border-neutral-600 dark:text-neutral-300">
          No customers available
        </p>
      ) : visibleCustomerCount === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 p-6 text-center dark:border-neutral-600">
          <p className="max-w-full text-sm break-words text-neutral-700 dark:text-neutral-300">
            No customers match &ldquo;{searchQuery}&rdquo;
          </p>
          <button
            type="button"
            onClick={handleClearSearch}
            className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-600 dark:text-neutral-100 dark:hover:bg-neutral-800 dark:focus-visible:outline-white"
          >
            Clear search
          </button>
        </div>
      ) : (
        <ul
          ref={customerGridRef}
          tabIndex={-1}
          onFocus={handleGridFocus}
          onBlur={handleGridBlur}
          className="grid grid-cols-1 items-stretch gap-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 sm:grid-cols-2 lg:grid-cols-3 dark:focus-visible:outline-white"
        >
          {visibleCustomers.map((customer) => (
            <li key={customer.id} className="flex min-w-0">
              <CustomerCard
                customer={customer}
                isSelected={customer.id === selectedCustomerId}
                onSelect={handleSelectCustomer}
                headingLevel={headingLevel}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
