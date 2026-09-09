/**
 * Test fixtures for the CustomerSelector component.
 *
 * `mockCustomers` already covers multi-match queries (`solutions` matches both
 * `Global Solutions` and `CloudFirst Solutions`; `john` matches both `John
 * Smith` and `Sarah Johnson`), single- and multi-domain customers, and a spread
 * of health scores — none of that is rebuilt here.
 *
 * What eight customers cannot cover, and this module adds: volume (100 and 500
 * customers), a two-term cross-field query, casing and whitespace edge cases,
 * diacritics, overflow text, a guaranteed no-match token, and the empty list.
 *
 * Everything is deterministic — no `Math.random()`, no `Date.now()` — so a
 * manual observation reproduces run to run. All ids are unique, because
 * duplicate ids would break both React keys and single-selection.
 *
 * Not production data; intended for scratch pages and manual verification.
 */

import type { Customer } from '@/data/mock-customers';

/** Company names cycled through the generated volume fixtures. */
const VOLUME_COMPANY_NAMES = [
  'Northwind Traders',
  'Contoso Manufacturing',
  'Fabrikam Retail',
  'Litware Logistics',
  'Proseware Media',
  'Tailspin Toys',
  'Wingtip Advisory',
  'Adventure Works'
];

/** Surnames cycled through the generated volume fixtures. */
const VOLUME_FAMILY_NAMES = [
  'Abbott',
  'Bennett',
  'Castellano',
  'Delacroix',
  'Ellsworth',
  'Fairweather',
  'Grigoryan',
  'Halvorsen',
  'Iwasaki',
  'Jorgensen'
];

/** Given names cycled through the generated volume fixtures. */
const VOLUME_GIVEN_NAMES = [
  'Amara',
  'Bruno',
  'Camille',
  'Dmitri',
  'Elena',
  'Farid',
  'Greta'
];

/** Health scores cycled so every band is represented across any fixture size. */
const VOLUME_HEALTH_SCORES = [8, 22, 31, 44, 57, 69, 71, 83, 95, 100];

/**
 * Builds a deterministic list of distinct customers of the requested size.
 *
 * Every field is derived from the index by modular arithmetic, so
 * `generateCustomerFixtures(100)` returns byte-identical data on every call and
 * in every process. Ids embed the index and are therefore unique within a
 * generated list, and are prefixed so they cannot collide with the hand-written
 * fixtures below or with `mockCustomers`.
 *
 * @param count How many customers to generate. Zero or negative yields `[]`.
 * @returns A fresh array of `count` customers.
 */
export function generateCustomerFixtures(count: number): Customer[] {
  const customers: Customer[] = [];

  for (let index = 0; index < count; index += 1) {
    const givenName = VOLUME_GIVEN_NAMES[index % VOLUME_GIVEN_NAMES.length];
    const familyName = VOLUME_FAMILY_NAMES[index % VOLUME_FAMILY_NAMES.length];
    const company = VOLUME_COMPANY_NAMES[index % VOLUME_COMPANY_NAMES.length];
    const healthScore = VOLUME_HEALTH_SCORES[index % VOLUME_HEALTH_SCORES.length];
    const domainCount = (index % 3) + 1;

    customers.push({
      id: `volume-${index}`,
      name: `${givenName} ${familyName}`,
      company: `${company} ${index}`,
      healthScore,
      domains: Array.from(
        { length: domainCount },
        (_unused, domainIndex) => `site-${index}-${domainIndex}.example`
      )
    });
  }

  return customers;
}

/** The requirement's stated floor: "must handle 100+ customers efficiently". */
export const VOLUME_CONFORMANCE_SIZE = 100;

/** Headroom size, to confirm the approach does not fall off a cliff past 100. */
export const VOLUME_HEADROOM_SIZE = 500;

/** 100 customers — the size the performance budget is first checked at. */
export const hundredCustomerFixtures: Customer[] =
  generateCustomerFixtures(VOLUME_CONFORMANCE_SIZE);

/** 500 customers — the headroom size the performance budget is re-checked at. */
export const fiveHundredCustomerFixtures: Customer[] =
  generateCustomerFixtures(VOLUME_HEADROOM_SIZE);

/**
 * A token guaranteed absent from every fixture in this module, from
 * `mockCustomers`, and from the generated volume sets — type it to reach the
 * no-results state.
 */
export const NO_MATCH_SEARCH_QUERY = 'zzqqxv';

/**
 * The two-term query whose halves live in different fields, for AC-3.
 * Neither `name` nor `company` alone contains both terms.
 */
export const CROSS_FIELD_SEARCH_QUERY = 'john acme';

/**
 * Edge-case customers: cross-field matching, casing, whitespace, diacritics,
 * and overflow. Small enough to eyeball, so it doubles as the fixture to render
 * when checking the grid by hand.
 */
export const edgeCaseCustomers: Customer[] = [
  {
    // AC-3: `john acme` matches only once name and company are searched together.
    id: 'edge-cross-field',
    name: 'John Petersen',
    company: 'Acme Industrial Group',
    healthScore: 64,
    domains: ['acme-industrial.example']
  },
  {
    // AC-4: mixed case, matched by `mixedcase` in any casing.
    id: 'edge-mixed-case',
    name: 'MiXeDcAsE Nguyen',
    company: 'CamelCase Consulting',
    healthScore: 78,
    domains: ['camelcase.example']
  },
  {
    // AC-4: leading and trailing whitespace in the stored name.
    id: 'edge-padded-name',
    name: '   Padded Whitfield   ',
    company: 'Trimmed Trading',
    healthScore: 52,
    domains: ['trimmed-trading.example']
  },
  {
    // AC-4: a double space inside the company name.
    id: 'edge-double-space-company',
    name: 'Gapped Sorensen',
    company: 'Double  Space Ventures',
    healthScore: 27,
    domains: ['double-space.example']
  },
  {
    // AC-5: `jose alvarez` must match this accented record.
    id: 'edge-diacritics',
    name: 'José Álvarez',
    company: 'Peñafiel Exportaciones',
    healthScore: 89,
    domains: ['penafiel.example']
  },
  {
    // AC-5: the reverse direction — an accented query matching plain ASCII.
    id: 'edge-plain-ascii',
    name: 'Jose Alvarez',
    company: 'Penafiel Imports',
    healthScore: 41,
    domains: ['penafiel-imports.example']
  },
  {
    // AC-40: long, unbroken-ish text must not blow out the grid cell.
    id: 'edge-overflow',
    name: 'Bartholomew Fitzwilliam Montgomery-Featherstonehaugh III',
    company:
      'Intercontinental Conglomerated Manufacturing And Distribution Holdings Incorporated Worldwide',
    healthScore: 33,
    domains: [
      'extremely-long-subdomain-name-for-overflow-testing.intercontinental-conglomerated.example'
    ]
  }
];

/** AC-11: the distinct "no customers available" state. */
export const emptyCustomers: Customer[] = [];
