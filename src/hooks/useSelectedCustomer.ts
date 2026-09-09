'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Customer } from '@/data/mock-customers';

/**
 * `sessionStorage` key holding the selected customer's id.
 *
 * Declared once, here, so the dashboard and the selector cannot drift onto two
 * different keys. `sessionStorage` rather than `localStorage` is deliberate:
 * "which customer am I looking at" is a per-tab working context and should not
 * resurrect weeks later in an unrelated tab.
 */
export const SELECTED_CUSTOMER_STORAGE_KEY = 'customerIntelligenceDashboard.selectedCustomerId';

/** What {@link useSelectedCustomer} hands back to the dashboard. */
export interface UseSelectedCustomerResult {
  /** Id of the selected customer, or `null` when nothing is selected. */
  selectedCustomerId: string | null;
  /** The selected customer resolved against `customers`, or `null`. */
  selectedCustomer: Customer | null;
  /** Selects a customer, or clears the selection when passed `null`. */
  selectCustomer: (customer: Customer | null) => void;
}

/**
 * Reads the stored id, degrading to `null` when storage is unavailable.
 *
 * Private browsing and blocked-storage settings make every `sessionStorage`
 * access a potential `SecurityError`; a broken selection is a bug, a broken
 * dashboard is worse, so failures fall back to in-memory-only behaviour.
 */
function readStoredCustomerId(): string | null {
  try {
    return window.sessionStorage.getItem(SELECTED_CUSTOMER_STORAGE_KEY);
  } catch {
    // Storage unavailable (private browsing, blocked origin): stay in memory.
    return null;
  }
}

/**
 * Writes, or removes, the stored id, swallowing storage failures.
 *
 * Only the id is ever written — never a name, an email, or a whole customer
 * object. Storage is readable by any script on the origin, so it holds the
 * least identifying thing that still satisfies the persistence requirement.
 */
function writeStoredCustomerId(customerId: string | null): void {
  try {
    if (customerId === null) {
      window.sessionStorage.removeItem(SELECTED_CUSTOMER_STORAGE_KEY);
      return;
    }

    window.sessionStorage.setItem(SELECTED_CUSTOMER_STORAGE_KEY, customerId);
  } catch {
    // Storage unavailable or over quota: the in-memory selection still works.
  }
}

/**
 * Owns the dashboard's selected customer, above and outside `CustomerSelector`.
 *
 * The selection deliberately does not live in the selector: navigation between
 * the dashboard and customer management unmounts the selector, and local state
 * would drop the selection exactly when the persistence requirement matters.
 * Holding it here lets the selector stay controlled-only.
 *
 * Hydration safety: state starts as `null` on both server and client, and a
 * mount effect reads storage once. Storage is never touched during render or in
 * a `useState` initializer, which would desynchronize the server-rendered HTML
 * from the first client render. The first paint therefore shows no selection
 * even when one is stored — an accepted, brief flash.
 *
 * Stale ids are reconciled: an id matching no customer in `customers` is
 * cleared from both state and storage rather than left dangling, so a customer
 * deleted upstream clears the selection instead of pointing at nothing.
 *
 * @param customers The customers the selection is resolved against.
 * @returns The selected id, the resolved customer, and a setter.
 */
export function useSelectedCustomer(customers: Customer[]): UseSelectedCustomerResult {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  // Restore once, after mount, so server and client render the same first HTML.
  useEffect(() => {
    const storedCustomerId = readStoredCustomerId();

    if (storedCustomerId !== null) {
      setSelectedCustomerId(storedCustomerId);
    }
  }, []);

  // Reconcile whenever the customer list changes, or a restored id arrives.
  useEffect(() => {
    if (selectedCustomerId === null) {
      return;
    }

    const isStillPresent = customers.some((customer) => customer.id === selectedCustomerId);

    if (!isStillPresent) {
      setSelectedCustomerId(null);
      writeStoredCustomerId(null);
    }
  }, [customers, selectedCustomerId]);

  const selectCustomer = useCallback((customer: Customer | null) => {
    const nextSelectedCustomerId = customer === null ? null : customer.id;

    setSelectedCustomerId(nextSelectedCustomerId);
    writeStoredCustomerId(nextSelectedCustomerId);
  }, []);

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId]
  );

  return { selectedCustomerId, selectedCustomer, selectCustomer };
}
