/**
 * Test fixtures for the CustomerCard component.
 *
 * `mockCustomers` alone cannot verify the card: its health scores (15, 35, 45, 60,
 * 73, 85, 88, 92) miss every band boundary, and all eight customers have a
 * non-empty `domains` array, so the empty and undefined domain paths are never
 * exercised. These fixtures cover the boundaries, out-of-range and fractional
 * scores, the non-finite score, each domain shape, and text overflow.
 *
 * Not production data — intended for scratch pages and manual verification.
 */

import type { Customer } from '@/data/mock-customers';

/** Customers sitting exactly on, or just past, each health band boundary. */
export const bandBoundaryCustomers: Customer[] = [
  {
    id: 'band-negative-one',
    name: 'Below Range',
    company: 'Clamp Test Co',
    healthScore: -1,
    domains: ['below-range.example']
  },
  {
    id: 'band-zero',
    name: 'Zero Score',
    company: 'Red Band Ltd',
    healthScore: 0,
    domains: ['zero-score.example']
  },
  {
    id: 'band-thirty',
    name: 'Poor Upper Bound',
    company: 'Red Band Ltd',
    healthScore: 30,
    domains: ['poor-upper.example']
  },
  {
    id: 'band-thirty-one',
    name: 'Moderate Lower Bound',
    company: 'Yellow Band Ltd',
    healthScore: 31,
    domains: ['moderate-lower.example']
  },
  {
    id: 'band-seventy',
    name: 'Moderate Upper Bound',
    company: 'Yellow Band Ltd',
    healthScore: 70,
    domains: ['moderate-upper.example']
  },
  {
    id: 'band-seventy-one',
    name: 'Good Lower Bound',
    company: 'Green Band Ltd',
    healthScore: 71,
    domains: ['good-lower.example']
  },
  {
    id: 'band-one-hundred',
    name: 'Perfect Score',
    company: 'Green Band Ltd',
    healthScore: 100,
    domains: ['perfect-score.example']
  },
  {
    id: 'band-one-hundred-one',
    name: 'Above Range',
    company: 'Clamp Test Co',
    healthScore: 101,
    domains: ['above-range.example']
  }
];

/**
 * Fractional scores that fall between the integer thresholds. Each must land in
 * exactly one band, and the displayed number must agree with that band.
 */
export const fractionalScoreCustomers: Customer[] = [
  {
    id: 'fractional-thirty-point-five',
    name: 'Thirty Point Five',
    company: 'Rounding Test Co',
    healthScore: 30.5,
    domains: ['thirty-point-five.example']
  },
  {
    id: 'fractional-seventy-point-five',
    name: 'Seventy Point Five',
    company: 'Rounding Test Co',
    healthScore: 70.5,
    domains: ['seventy-point-five.example']
  }
];

/** Non-finite score: must render the neutral unknown state and claim no band. */
export const unknownScoreCustomer: Customer = {
  id: 'score-not-a-number',
  name: 'Unknown Health',
  company: 'Missing Data Inc',
  healthScore: Number.NaN,
  domains: ['unknown-health.example']
};

/** One customer per domain shape: undefined, empty, single, and many. */
export const domainShapeCustomers: Customer[] = [
  {
    id: 'domains-undefined',
    name: 'No Domains Field',
    company: 'Undefined Domains Ltd',
    healthScore: 82
  },
  {
    id: 'domains-empty',
    name: 'Empty Domains Array',
    company: 'Empty Domains Ltd',
    healthScore: 54,
    domains: []
  },
  {
    id: 'domains-single',
    name: 'Single Domain',
    company: 'One Site Ltd',
    healthScore: 22,
    domains: ['single-domain.example']
  },
  {
    id: 'domains-many',
    name: 'Three Domains',
    company: 'Many Sites Ltd',
    healthScore: 91,
    domains: ['three-domains.example', 'api.three-domains.example', 'cdn.three-domains.example']
  }
];

/** Long strings in every text field, to prove the card layout holds together. */
export const overflowCustomer: Customer = {
  id: 'overflow-long-strings',
  name: 'Bartholomew Fitzgerald-Montgomery Wellingtonshire III',
  company: 'Extraordinarily Long Company Name Holdings International Consolidated Group',
  healthScore: 47,
  domains: [
    'an-extremely-long-subdomain-label-that-will-not-fit.another-very-long-segment.example',
    'short.example'
  ]
};

/** Every fixture above, flattened — convenient for rendering the whole set at once. */
export const customerCardFixtures: Customer[] = [
  ...bandBoundaryCustomers,
  ...fractionalScoreCustomers,
  unknownScoreCustomer,
  ...domainShapeCustomers,
  overflowCustomer
];
