'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { validateCompanyName } from '@/lib/validateCompanyName';
import type { MarketIntelligence, SentimentLabel } from '@/types/market-intelligence';

/**
 * Card surface. Copied from `CustomerCard`'s shell — same `rounded-lg`, 1px
 * neutral border, white surface, `p-4` (`sm:p-5`) and `shadow-sm` — so this
 * widget sits flush beside a customer card in the dashboard grid.
 */
const CARD_CLASS_NAME =
  'flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-sm sm:p-5 dark:border-neutral-700 dark:bg-neutral-900';

/** Request timeout. A hung request must surface as retryable, not as a forever-spinner. */
const REQUEST_TIMEOUT_MS = 8_000;

/** How many headlines the widget will render, however many the payload carries. */
const MAX_HEADLINES_SHOWN = 3;

const TIMEOUT_ERROR_MESSAGE = 'Request timed out. Please try again.';
const NETWORK_ERROR_MESSAGE = 'Could not load market intelligence. Please try again.';

/**
 * Indicator colours keyed by sentiment label.
 *
 * Keyed by label rather than re-comparing the score, so the band thresholds stay
 * defined once — in `calculateMockSentiment` — and cannot drift between the data
 * layer and the UI.
 */
const SENTIMENT_STYLES: Record<SentimentLabel, { dot: string; text: string }> = {
  positive: { dot: 'bg-green-500', text: 'text-green-800 dark:text-green-300' },
  neutral: { dot: 'bg-yellow-500', text: 'text-yellow-800 dark:text-yellow-300' },
  negative: { dot: 'bg-red-500', text: 'text-red-800 dark:text-red-300' },
};

const SENTIMENT_LABEL_TEXT: Record<SentimentLabel, string> = {
  positive: 'Positive',
  neutral: 'Neutral',
  negative: 'Negative',
};

type WidgetStatus = 'idle' | 'loading' | 'success' | 'error';

/** Bookkeeping for one in-flight request, so an abort can be attributed. */
interface ActiveRequest {
  controller: AbortController;
  /** Set when a newer request replaced this one. A superseded abort renders no error. */
  superseded: boolean;
  /** Set when the 8-second timer fired. Surfaces a retryable timeout error. */
  timedOut: boolean;
}

export interface MarketIntelligenceWidgetProps {
  /** Company of the dashboard's currently selected customer. */
  company?: string;
  /** Extra classes for the card root, so the dashboard grid can size the widget. */
  className?: string;
}

/**
 * Formats an ISO 8601 timestamp for display, falling back to the raw string if
 * it cannot be parsed.
 *
 * @param isoTimestamp - ISO 8601 timestamp.
 * @returns Human-readable date and time.
 */
function formatTimestamp(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Market sentiment and news for a customer's company.
 *
 * The data is entirely mock, generated in-process — hence the permanent "Sample
 * data" badge, which exists so a demo audience is never left thinking this is a
 * live news feed.
 *
 * Fetching is driven either by the `company` prop (the dashboard's selection) or
 * by the widget's own input. Only one request is ever in flight: starting a new
 * one aborts the previous, so a slow response cannot overwrite a fresh one.
 */
export function MarketIntelligenceWidget({ company, className }: MarketIntelligenceWidgetProps) {
  const [companyInput, setCompanyInput] = useState<string>(company ?? '');
  const [status, setStatus] = useState<WidgetStatus>('idle');
  const [marketIntelligence, setMarketIntelligence] = useState<MarketIntelligence | null>(null);
  const [requestErrorMessage, setRequestErrorMessage] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);

  const activeRequestRef = useRef<ActiveRequest | null>(null);
  /** Last company the prop-driven effect fetched, so an unchanged prop never refetches. */
  const lastAutoFetchedCompanyRef = useRef<string | null>(null);

  const inputValidation = useMemo(() => validateCompanyName(companyInput), [companyInput]);
  const isLoading = status === 'loading';
  const canSubmit = inputValidation.ok && !isLoading;

  const fetchMarketIntelligence = useCallback(async (requestedCompany: string): Promise<void> => {
    const validation = validateCompanyName(requestedCompany);
    if (!validation.ok) {
      setValidationMessage(validation.reason);
      return;
    }
    setValidationMessage(null);

    // Supersede any in-flight request before starting a new one.
    const previousRequest = activeRequestRef.current;
    if (previousRequest) {
      previousRequest.superseded = true;
      previousRequest.controller.abort();
    }

    const request: ActiveRequest = {
      controller: new AbortController(),
      superseded: false,
      timedOut: false,
    };
    activeRequestRef.current = request;

    // Timeout is independent of supersession: both abort, but only one is an error.
    const timeoutId = setTimeout(() => {
      request.timedOut = true;
      request.controller.abort();
    }, REQUEST_TIMEOUT_MS);

    setStatus('loading');
    setRequestErrorMessage(null);

    try {
      // Encoded so a name with spaces or punctuation cannot reshape the URL path.
      const response = await fetch(
        `/api/market-intelligence/${encodeURIComponent(validation.value)}`,
        { signal: request.controller.signal, headers: { Accept: 'application/json' } }
      );

      const body: unknown = await response.json().catch(() => null);

      if (request.superseded) {
        return;
      }

      if (!response.ok) {
        const serverMessage =
          body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : NETWORK_ERROR_MESSAGE;
        setRequestErrorMessage(serverMessage);
        setStatus('error');
        return;
      }

      setMarketIntelligence(body as MarketIntelligence);
      setStatus('success');
    } catch {
      // A superseded request is expected and must render nothing.
      if (request.superseded) {
        return;
      }
      setRequestErrorMessage(request.timedOut ? TIMEOUT_ERROR_MESSAGE : NETWORK_ERROR_MESSAGE);
      setStatus('error');
    } finally {
      clearTimeout(timeoutId);
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
      }
    }
  }, []);

  // Prop-driven fetch. The ref guard means re-rendering with an unchanged
  // `company` never triggers a second request.
  useEffect(() => {
    const selectedCompany = company?.trim() ?? '';
    if (selectedCompany.length === 0) {
      return;
    }
    if (lastAutoFetchedCompanyRef.current === selectedCompany) {
      return;
    }
    lastAutoFetchedCompanyRef.current = selectedCompany;
    setCompanyInput(selectedCompany);
    void fetchMarketIntelligence(selectedCompany);
  }, [company, fetchMarketIntelligence]);

  // Abort whatever is in flight when the widget unmounts.
  useEffect(() => {
    return () => {
      const request = activeRequestRef.current;
      if (request) {
        request.superseded = true;
        request.controller.abort();
      }
    };
  }, []);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!inputValidation.ok) {
      setValidationMessage(inputValidation.reason);
      return;
    }
    lastAutoFetchedCompanyRef.current = inputValidation.value;
    void fetchMarketIntelligence(inputValidation.value);
  };

  const handleRetry = (): void => {
    void fetchMarketIntelligence(companyInput);
  };

  return (
    <section className={className ? `${CARD_CLASS_NAME} ${className}` : CARD_CLASS_NAME}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-neutral-50">
          Market Intelligence
        </h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
          Sample data
        </span>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <label
          htmlFor="market-intelligence-company"
          className="text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400"
        >
          Company name
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="market-intelligence-company"
            name="company"
            type="text"
            value={companyInput}
            onChange={(event) => {
              setCompanyInput(event.target.value);
              setValidationMessage(null);
            }}
            placeholder="Acme Corp"
            autoComplete="organization"
            aria-invalid={validationMessage !== null}
            aria-describedby={validationMessage ? 'market-intelligence-company-error' : undefined}
            className="min-h-11 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-50"
          />
          <button
            type="submit"
            disabled={!canSubmit}
            className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-600 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-400"
          >
            {isLoading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
        {validationMessage && (
          <p
            id="market-intelligence-company-error"
            className="text-sm text-red-700 dark:text-red-300"
          >
            {validationMessage}
          </p>
        )}
      </form>

      <div aria-live="polite" aria-busy={isLoading} className="flex flex-col gap-3">
        {status === 'idle' && (
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            Select a customer or enter a company name to see its market sentiment.
          </p>
        )}

        {isLoading && (
          <p className="text-sm text-gray-600 dark:text-neutral-400">
            Analyzing market sentiment…
          </p>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
            <p className="text-sm text-red-800 dark:text-red-200">
              {requestErrorMessage ?? NETWORK_ERROR_MESSAGE}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="min-h-11 rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-800 transition-colors hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900"
            >
              Retry
            </button>
          </div>
        )}

        {status === 'success' && marketIntelligence && (
          <MarketIntelligenceResults marketIntelligence={marketIntelligence} />
        )}
      </div>
    </section>
  );
}

/**
 * Results body: sentiment indicator, article reconciliation, timestamp and the
 * headline list. Split out so the widget's control flow stays readable.
 */
function MarketIntelligenceResults({
  marketIntelligence,
}: {
  marketIntelligence: MarketIntelligence;
}) {
  const { company, sentiment, articleCount, headlines, lastUpdated } = marketIntelligence;
  const shownHeadlines = headlines.slice(0, MAX_HEADLINES_SHOWN);
  const sentimentStyle = SENTIMENT_STYLES[sentiment.label];
  const confidencePercentage = Math.round(sentiment.confidence * 100);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium break-words text-neutral-700 dark:text-neutral-300">
        {company}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {/* Decorative: the label beside it carries the same information as text. */}
        <span aria-hidden="true" className={`h-3 w-3 rounded-full ${sentimentStyle.dot}`} />
        <span className={`text-sm font-semibold ${sentimentStyle.text}`}>
          {SENTIMENT_LABEL_TEXT[sentiment.label]}
        </span>
        <span className="text-sm text-gray-600 dark:text-neutral-400">
          score {sentiment.score.toFixed(2)} · {confidencePercentage}% confidence
        </span>
      </div>

      <p className="text-sm text-gray-600 dark:text-neutral-400">
        {articleCount > shownHeadlines.length
          ? `${articleCount} articles found · showing top ${shownHeadlines.length}`
          : `${articleCount} ${articleCount === 1 ? 'article' : 'articles'} found`}
      </p>

      <p className="text-xs text-gray-600 dark:text-neutral-400">
        Last updated {formatTimestamp(lastUpdated)}
      </p>

      {shownHeadlines.length > 0 && (
        <ul aria-label="Recent headlines" className="flex flex-col gap-2">
          {shownHeadlines.map((headline, headlineIndex) => (
            <li
              key={`${headlineIndex}-${headline.title}`}
              className="flex flex-col gap-0.5 border-t border-neutral-200 pt-2 dark:border-neutral-700"
            >
              {headline.url ? (
                <a
                  href={headline.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium break-words text-blue-800 underline underline-offset-2 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:text-blue-300"
                >
                  {headline.title}
                </a>
              ) : (
                <span className="text-sm font-medium break-words text-neutral-900 dark:text-neutral-50">
                  {headline.title}
                </span>
              )}
              <span className="text-xs break-words text-gray-600 dark:text-neutral-400">
                {headline.source} · {formatTimestamp(headline.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
