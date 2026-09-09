/**
 * Shared response types for the Market Intelligence feature.
 *
 * Imported by the route handler, the service, and the widget so all three agree
 * on one shape. The data behind these types is entirely mock — see
 * `src/data/mock-market-intelligence.ts`.
 */

/** The three sentiment bands, mirroring the dashboard's red/yellow/green language. */
export type SentimentLabel = 'positive' | 'neutral' | 'negative';

/** Sentiment summary derived from the generated headlines. */
export interface MarketSentiment {
  /** Net sentiment in the range -1..1. Deliberately non-saturating. */
  score: number;
  /** Band the score falls into. Always rendered as text so colour is never the only channel. */
  label: SentimentLabel;
  /** Derived confidence in the range 0..1. */
  confidence: number;
}

/** A single news headline. */
export interface MarketHeadline {
  title: string;
  source: string;
  /** ISO 8601 timestamp. */
  publishedAt: string;
  /** Absolute https URL on the source's domain, when the template supplies one. */
  url?: string;
}

/** Successful `GET /api/market-intelligence/[company]` payload. */
export interface MarketIntelligence {
  /** The normalized company name echoed back — never the raw input. */
  company: string;
  sentiment: MarketSentiment;
  /** Total articles found. May exceed `headlines.length`. */
  articleCount: number;
  /** The top 3 of `articleCount`. */
  headlines: MarketHeadline[];
  /** ISO 8601 timestamp of when the payload was generated, not when it was served. */
  lastUpdated: string;
}

/** Error body returned by the route for every non-200 response. */
export interface MarketIntelligenceErrorBody {
  error: string;
}
