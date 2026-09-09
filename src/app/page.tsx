'use client';

import { useMemo } from 'react';

import { AlertsPanel } from '@/components/AlertsPanel';
import { CustomerHealthDisplay } from '@/components/CustomerHealthDisplay';
import { CustomerSelector } from '@/components/CustomerSelector';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MarketIntelligenceWidget } from '@/components/MarketIntelligenceWidget';
import { useSelectedCustomer } from '@/hooks/useSelectedCustomer';
import { scoreCustomerAt, type CustomerEvaluationInput } from '@/lib/alerts';
import { mockCustomers } from '@/data/mock-customers';
import {
  SIGNAL_REFERENCE_DATE,
  buildAllScoreHistories,
  mockCustomerSignals,
} from '@/data/mock-customer-signals';

// The dashboard is driven entirely by locally generated mock data, so the
// evaluation clock is a fixed date rather than `Date.now()`. Every widget below
// derives from this one instant, which keeps scores, alerts and history
// consistent with each other and makes the page deterministic across reloads.
const EVALUATION_DATE = SIGNAL_REFERENCE_DATE;

/**
 * Interim composition root.
 *
 * This wires the widgets built so far so they are visible in the running app.
 * `specs/dashboard-orchestrator-spec.md` replaces it with the real orchestrator
 * (shared context, per-widget error boundaries, export pipeline, performance
 * budget); this is deliberately the minimum needed to render, not that spec.
 */
export default function Home() {
  const { selectedCustomerId, selectedCustomer, selectCustomer } =
    useSelectedCustomer(mockCustomers);

  // Alert evaluation reads every customer's signal history, so it is derived
  // once for the whole page rather than per widget.
  const alertInputs = useMemo<CustomerEvaluationInput[]>(
    () =>
      mockCustomerSignals.map((signals) => ({
        customer: { id: signals.customerId },
        signals,
        health: scoreCustomerAt(signals, EVALUATION_DATE),
      })),
    []
  );

  const initialScoreHistory = useMemo(() => buildAllScoreHistories(EVALUATION_DATE), []);

  const selectedSignals = selectedCustomerId
    ? mockCustomerSignals.find((signals) => signals.customerId === selectedCustomerId)
    : undefined;

  const selectedHealth = selectedSignals
    ? scoreCustomerAt(selectedSignals, EVALUATION_DATE)
    : undefined;

  return (
    <div className="min-h-screen bg-gray-50 p-4 dark:bg-gray-950">
      <header className="mb-8">
        <h1 className="mb-2 text-4xl font-bold text-gray-900 dark:text-gray-50">
          Customer Intelligence Dashboard
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Sample data — every figure below is locally generated mock data, evaluated as of{' '}
          {EVALUATION_DATE}.
        </p>
      </header>

      <div className="space-y-8">
        <section className="rounded-lg bg-white p-6 shadow dark:bg-gray-900">
          <ErrorBoundary>
            <CustomerSelector
              customers={mockCustomers}
              selectedCustomerId={selectedCustomerId}
              onSelectCustomer={selectCustomer}
              headingLevel={2}
            />
          </ErrorBoundary>
        </section>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section className="rounded-lg bg-white p-6 shadow dark:bg-gray-900">
            <ErrorBoundary>
              <CustomerHealthDisplay
                result={selectedHealth}
                customer={selectedCustomer ?? undefined}
                customerId={selectedCustomerId ?? undefined}
                headingLevel={2}
              />
            </ErrorBoundary>
          </section>

          <section className="rounded-lg bg-white p-6 shadow dark:bg-gray-900">
            <ErrorBoundary>
              <MarketIntelligenceWidget company={selectedCustomer?.company} />
            </ErrorBoundary>
          </section>
        </div>

        <section className="rounded-lg bg-white p-6 shadow dark:bg-gray-900">
          <ErrorBoundary>
            <AlertsPanel
              inputs={alertInputs}
              customers={mockCustomers}
              initialScoreHistory={initialScoreHistory}
              asOf={EVALUATION_DATE}
              selectedCustomerId={selectedCustomerId ?? undefined}
              onSelectCustomer={(customerId) => {
                const customer = mockCustomers.find((candidate) => candidate.id === customerId);
                selectCustomer(customer ?? null);
              }}
              headingLevel={2}
            />
          </ErrorBoundary>
        </section>
      </div>
    </div>
  );
}
