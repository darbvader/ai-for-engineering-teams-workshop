/**
 * Mock market intelligence data for workshop demonstration
 * Provides realistic company news and sentiment data without external API dependencies
 *
 * Everything here is fabricated. No news or sentiment API is called, so there is
 * no API key, no outbound request, and no third-party trust boundary. The UI is
 * required to label the output as sample data.
 *
 * Generation is fully deterministic: the same company name always yields the
 * same headlines, timestamps and sentiment, across repeated calls and across
 * process restarts. That predictability is what makes the workshop demo and the
 * unit tests possible.
 */

export interface MockHeadline {
  title: string;
  source: string;
  publishedAt: string;
  url?: string;
}

export interface MockMarketData {
  articleCount: number;
  headlines: MockHeadline[];
}

/** The three sentiment bands. */
export type MockSentimentLabel = 'positive' | 'neutral' | 'negative';

export interface MockSentiment {
  score: number;
  label: MockSentimentLabel;
  confidence: number;
}

/**
 * Score above which sentiment reads as positive (green).
 * Single source of truth for both the label and the UI colour.
 */
export const POSITIVE_SENTIMENT_THRESHOLD = 0.15;

/** Score below which sentiment reads as negative (red). */
export const NEGATIVE_SENTIMENT_THRESHOLD = -0.15;

/** Floor applied to confidence, so a perfectly neutral read still reports 0.3. */
export const MINIMUM_CONFIDENCE = 0.3;

/** Ceiling applied to confidence — mock data never claims certainty. */
export const MAXIMUM_CONFIDENCE = 0.95;

/** Number of headlines surfaced to the UI, out of the larger `articleCount`. */
export const DISPLAYED_HEADLINE_COUNT = 3;

/** Largest number of unlisted extra articles the generator will claim to have found. */
const MAXIMUM_EXTRA_ARTICLES = 5;

/**
 * Fixed reference instant that all `publishedAt` values are offset backwards from.
 *
 * Deliberately a constant rather than `Date.now()`: determinism across process
 * restarts is an acceptance criterion, and a wall-clock anchor would break it.
 */
const PUBLICATION_ANCHOR_MS = Date.parse('2025-06-02T09:00:00.000Z');

const HOUR_IN_MS = 60 * 60 * 1000;

/** Widest backdating applied to a generated headline. */
const MAXIMUM_PUBLICATION_AGE_HOURS = 168;

/**
 * Sentiment analysis keywords for mock sentiment calculation
 */
export const sentimentKeywords = {
  positive: [
    'growth', 'profit', 'success', 'innovative', 'breakthrough', 'expansion',
    'achievement', 'award', 'milestone', 'partnership', 'investment', 'launch',
    'record', 'strong', 'increase', 'boost', 'win', 'leading', 'excellent',
    'surge', 'soar', 'beat', 'exceed', 'outperform', 'momentum'
  ],
  negative: [
    'loss', 'decline', 'problem', 'issue', 'crisis', 'failure', 'bankruptcy',
    'lawsuit', 'investigation', 'scandal', 'hack', 'breach', 'layoff', 'cut',
    'drop', 'fall', 'weak', 'concern', 'risk', 'warning', 'delay', 'recall',
    'plunge', 'crash', 'struggle', 'disappointing', 'underperform'
  ]
};

/** A headline before the company name has been interpolated into it. */
interface HeadlineTemplate {
  /** `{company}` is replaced with the normalized company name. */
  titleTemplate: string;
  source: string;
  url: string;
}

/**
 * Sentiment profiles.
 *
 * Each profile's templates are tuned so the keyword arithmetic in
 * `calculateMockSentiment` lands the set squarely in one band: the positive set
 * nets +3, the negative set nets -3, and the mixed set nets exactly 0 so it
 * reads neutral. Editing these strings can move a set across a band boundary —
 * `mock-market-intelligence.test.ts` guards that.
 */
const SENTIMENT_PROFILES: Record<MockSentimentLabel, HeadlineTemplate[]> = {
  positive: [
    {
      titleTemplate: '{company} Reports Record Quarterly Revenue',
      source: 'Financial News Today',
      url: 'https://financialnewstoday.com/markets/record-quarterly-revenue'
    },
    {
      titleTemplate: '{company} Announces Strategic Partnership With Regional Distributors',
      source: 'Tech Business Weekly',
      url: 'https://techbusinessweekly.com/deals/regional-distribution-agreement'
    },
    {
      titleTemplate: 'Analysts Note Steady Momentum Behind {company} Regional Plans',
      source: 'Investment Daily',
      url: 'https://investmentdaily.com/analysis/steady-regional-momentum'
    }
  ],
  neutral: [
    {
      titleTemplate: '{company} Posts Record Revenue While Costs Rise',
      source: 'Market Wire',
      url: 'https://marketwire.com/reports/revenue-and-costs'
    },
    {
      titleTemplate: '{company} Delays Regional Product Rollout',
      source: 'Industry Briefing',
      url: 'https://industrybriefing.com/products/regional-rollout-timing'
    },
    {
      titleTemplate: '{company} Names New Chief Operating Officer',
      source: 'Business Register',
      url: 'https://businessregister.com/people/new-chief-operating-officer'
    }
  ],
  negative: [
    {
      titleTemplate: '{company} Confirms Layoff Across Two Regional Offices',
      source: 'Labour Report',
      url: 'https://labourreport.com/employment/regional-office-reductions'
    },
    {
      titleTemplate: 'Regulators Open Investigation Into {company} Billing Practices',
      source: 'Compliance Journal',
      url: 'https://compliancejournal.com/regulatory/billing-practices-review'
    },
    {
      titleTemplate: '{company} Faces Lawsuit Over Product Rollout Terms',
      source: 'Legal Business Daily',
      url: 'https://legalbusinessdaily.com/litigation/product-rollout-terms'
    }
  ]
};

/** Profile order used when mapping a company hash onto a sentiment profile. */
const PROFILE_ORDER: MockSentimentLabel[] = ['positive', 'neutral', 'negative'];

/**
 * FNV-1a 32-bit hash.
 *
 * Chosen over a cryptographic hash because the only requirement is a stable,
 * well-spread seed — this is demo data, not a security primitive.
 *
 * @param input - String to hash.
 * @returns Unsigned 32-bit hash value.
 */
function fnv1aHash(input: string): number {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Creates a seeded pseudo-random generator (mulberry32).
 *
 * Replaces `Math.random()` so that output is reproducible for a given company.
 *
 * @param seed - Unsigned 32-bit seed.
 * @returns A function yielding successive values in `[0, 1)`.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function nextRandomValue(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates mock news headlines based on company name
 *
 * Deterministic: the company name is hashed to pick one of three sentiment
 * profiles and to seed the publication timestamps and article count.
 *
 * @param company - Company name. Should already be normalized by
 *                  `validateCompanyName`; only the normalized value is
 *                  interpolated into headline text.
 * @returns Mock news data with realistic headlines
 */
export function generateMockMarketData(company: string): MockMarketData {
  const seed = fnv1aHash(company.trim().toLowerCase());
  const nextRandomValue = createSeededRandom(seed);
  const profile = PROFILE_ORDER[seed % PROFILE_ORDER.length];
  const templates = SENTIMENT_PROFILES[profile];

  const headlines: MockHeadline[] = templates.map((template, templateIndex) => {
    const ageWindowHours =
      ((templateIndex + 1) / templates.length) * MAXIMUM_PUBLICATION_AGE_HOURS;
    const ageHours = Math.floor(nextRandomValue() * ageWindowHours);

    return {
      title: template.titleTemplate.replace('{company}', company),
      source: template.source,
      publishedAt: new Date(PUBLICATION_ANCHOR_MS - ageHours * HOUR_IN_MS).toISOString(),
      url: template.url
    };
  });

  // Articles found can exceed the headlines shown; the UI reconciles the two
  // rather than printing a count that contradicts the list beneath it.
  const extraArticles = Math.floor(nextRandomValue() * (MAXIMUM_EXTRA_ARTICLES + 1));

  return {
    articleCount: headlines.length + extraArticles,
    headlines: headlines.slice(0, DISPLAYED_HEADLINE_COUNT)
  };
}

/**
 * Counts positive and negative keyword hits across a set of headlines.
 *
 * A word scores at most once, and positive matching wins over negative when a
 * word somehow matches both.
 *
 * @param headlines - Headlines to scan.
 * @returns The positive and negative hit totals.
 */
function countKeywordHits(headlines: MockHeadline[]): {
  positiveKeywordHits: number;
  negativeKeywordHits: number;
} {
  let positiveKeywordHits = 0;
  let negativeKeywordHits = 0;

  headlines.forEach((headline) => {
    headline.title
      .toLowerCase()
      .split(/\s+/)
      .forEach((word) => {
        if (sentimentKeywords.positive.some((keyword) => word.includes(keyword))) {
          positiveKeywordHits += 1;
        } else if (sentimentKeywords.negative.some((keyword) => word.includes(keyword))) {
          negativeKeywordHits += 1;
        }
      });
  });

  return { positiveKeywordHits, negativeKeywordHits };
}

/**
 * Maps a sentiment score onto its band.
 *
 * The single source of truth for the label, and therefore for the widget's
 * indicator colour — the widget must derive its colour from the label rather
 * than re-comparing the score against its own thresholds.
 *
 * @param score - Sentiment score in the range -1..1.
 * @returns The band the score falls into.
 */
export function classifySentimentScore(score: number): MockSentimentLabel {
  if (score > POSITIVE_SENTIMENT_THRESHOLD) {
    return 'positive';
  }
  if (score < NEGATIVE_SENTIMENT_THRESHOLD) {
    return 'negative';
  }
  return 'neutral';
}

/**
 * Calculates mock sentiment analysis from headlines
 *
 * The score is the net keyword balance spread over twice the headline count, so
 * an ordinary set never saturates at ±1 — a set of three all-positive headlines
 * lands near 0.5, leaving headroom that carries information.
 *
 * @param headlines - Array of news headlines
 * @returns Sentiment analysis object
 */
export function calculateMockSentiment(headlines: MockHeadline[]): MockSentiment {
  if (!headlines || headlines.length === 0) {
    return {
      score: 0,
      label: 'neutral',
      confidence: 0
    };
  }

  const { positiveKeywordHits, negativeKeywordHits } = countKeywordHits(headlines);
  const netKeywordBalance = positiveKeywordHits - negativeKeywordHits;
  const score = Math.max(-1, Math.min(1, netKeywordBalance / (2 * headlines.length)));

  return {
    score,
    label: classifySentimentScore(score),
    confidence: Math.min(MAXIMUM_CONFIDENCE, MINIMUM_CONFIDENCE + Math.abs(score) * 0.7)
  };
}
