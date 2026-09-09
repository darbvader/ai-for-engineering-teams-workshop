import Link from 'next/link';

import { HealthIndicator } from '@/components/HealthIndicator';
import type { Customer } from '@/data/mock-customers';

/**
 * Shared card surface. Applied to whichever root element the card renders, so
 * an inert card, a linked card, and a selectable card are visually identical at
 * rest and only the interactive ones grow the affordances below.
 *
 * The background is deliberately *not* part of this string: selection tints it,
 * and Tailwind emits colour utilities in its own order, so a later `bg-*` class
 * in the attribute would not reliably out-cascade `bg-white`. Choosing exactly
 * one background per state avoids that fight entirely.
 */
const CARD_CLASS_NAME =
  'flex min-h-[120px] max-w-[400px] flex-col gap-3 rounded-lg border border-neutral-200 bg-clip-padding p-4 shadow-sm sm:p-5 dark:border-neutral-700';

/** Resting background, used by every state except selected. */
const CARD_BACKGROUND_CLASS_NAME = 'bg-white dark:bg-neutral-900';

/**
 * Hover and keyboard-focus affordances, added only when the card is a link.
 * `transition-colors` is paired with a shadow change rather than a transform so
 * the card cannot shift the grid around it — the spec forbids layout shift.
 */
const CARD_INTERACTIVE_CLASS_NAME =
  'transition-colors hover:border-neutral-400 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:border-neutral-500 dark:focus-visible:outline-blue-400';

/**
 * Affordances for the selectable (button) card.
 *
 * The focus indicator is a neutral offset outline, not the blue accent used for
 * selection, so "focused" can never be misread as "selected" — the two, plus
 * hover, must stay mutually distinguishable when they coexist on one card.
 */
const CARD_SELECTABLE_CLASS_NAME =
  'w-full text-left transition-colors hover:border-neutral-400 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:hover:border-neutral-500 dark:focus-visible:outline-white';

/**
 * Selected treatment: an inset accent ring *and* a background tint.
 *
 * `ring` is used rather than a thicker border because a ring is drawn outside
 * the box model and cannot change the card's dimensions or reflow the grid.
 * Two cues rather than one hue change means selection survives a glance in a
 * dense grid, and it is never signalled by colour alone — `aria-pressed`
 * carries the programmatic state.
 *
 * `ring-blue-600` clears 3:1 against both the white card surface and the light
 * page background; `ring-blue-400` does the same on the dark surface.
 */
const CARD_SELECTED_CLASS_NAME =
  'bg-blue-50 ring-2 ring-blue-600 ring-inset dark:bg-blue-950 dark:ring-blue-400';

export interface CustomerCardProps {
  /**
   * The customer to display. The card renders only name, company, health
   * score, and domains — never the whole record. `id`, `email`,
   * `subscriptionTier`, and the timestamps are deliberately withheld.
   */
  customer: Customer;
  /**
   * Destination for the customer's detail profile. When supplied the entire
   * card becomes one link with a hover and focus state; when omitted the card
   * is inert, so a container that owns selection itself can still use it.
   *
   * Ignored when `onSelect` is supplied: a card cannot be both a link and a
   * toggle button without nesting interactive elements.
   */
  href?: string;
  /**
   * Called with this customer when a selectable card is activated. Supplying it
   * turns the card's root into a real `<button>`, so keyboard activation, focus
   * order, and `Enter`/`Space` come from the platform.
   *
   * The container decides what activation means — selecting, or toggling the
   * already-selected card off.
   */
  onSelect?: (customer: Customer) => void;
  /**
   * Whether this card is the selected one. Rendered as `aria-pressed` on the
   * button and as the ring-plus-tint treatment. Only meaningful alongside
   * `onSelect`.
   */
  isSelected?: boolean;
  /**
   * Heading level for the customer name. The card cannot know its surrounding
   * document structure, so the container chooses the level that keeps the page
   * hierarchy correct.
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * Card showing a single customer's name, company, health score, and domains.
 * Holds no state and fetches no data.
 *
 * Renders one of three roots, in precedence order:
 * - `onSelect` supplied → a `<button>` carrying `aria-pressed={isSelected}`,
 *   for containers that own an in-page selection.
 * - `href` supplied → a link to the customer's profile, which keeps the card
 *   usable as a Server Component with no client bundle cost.
 * - neither → an inert `<article>`.
 *
 * The component itself declares no `'use client'`: the link and inert variants
 * stay server-rendered, and the selectable variant inherits the client boundary
 * of the container that passes `onSelect` (which must itself be a Client
 * Component to hold the handler).
 *
 * Customer-supplied strings are rendered as JSX text children, so React escapes
 * them and no `dangerouslySetInnerHTML` path exists for injected markup.
 */
export function CustomerCard({
  customer,
  href,
  onSelect,
  isSelected = false,
  headingLevel = 3
}: CustomerCardProps) {
  const { name, company, healthScore, domains } = customer;
  const HeadingTag = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hasDomains = Array.isArray(domains) && domains.length > 0;

  const cardBody = (
    <>
      <header className="flex flex-col gap-1">
        <HeadingTag className="text-lg font-semibold break-words text-neutral-900 dark:text-neutral-50">
          {name}
        </HeadingTag>
        <p className="text-sm font-medium break-words text-neutral-700 dark:text-neutral-300">
          {company}
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
          Health
        </span>
        <HealthIndicator score={healthScore} />
      </div>

      {hasDomains && (
        <section className="flex flex-col gap-1">
          <p className="text-xs font-medium tracking-wide text-neutral-600 uppercase dark:text-neutral-400">
            Domains
            {domains.length > 1 && (
              <span className="ml-1 font-normal normal-case">({domains.length} domains)</span>
            )}
          </p>
          <ul
            aria-label="Customer domains"
            className="flex flex-col gap-0.5 text-xs text-neutral-700 dark:text-neutral-300"
          >
            {domains.map((domain, domainIndex) => (
              <li key={`${domainIndex}-${domain}`} className="break-all">
                {domain}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );

  // Selection takes precedence over navigation: a button inside a link, or a
  // link inside a button, is invalid and breaks keyboard activation.
  if (onSelect !== undefined) {
    const selectableClassName = isSelected
      ? `${CARD_CLASS_NAME} ${CARD_SELECTABLE_CLASS_NAME} ${CARD_SELECTED_CLASS_NAME}`
      : `${CARD_CLASS_NAME} ${CARD_BACKGROUND_CLASS_NAME} ${CARD_SELECTABLE_CLASS_NAME}`;

    return (
      <button
        type="button"
        aria-pressed={isSelected}
        onClick={() => onSelect(customer)}
        className={selectableClassName}
      >
        {cardBody}
      </button>
    );
  }

  if (href === undefined) {
    return (
      <article className={`${CARD_CLASS_NAME} ${CARD_BACKGROUND_CLASS_NAME}`}>{cardBody}</article>
    );
  }

  // The link is the root rather than a wrapper inside the article, so the whole
  // card surface is the hit target instead of only the text inside it.
  return (
    <Link
      href={href}
      aria-label={`View profile for ${name} at ${company}`}
      className={`${CARD_CLASS_NAME} ${CARD_BACKGROUND_CLASS_NAME} ${CARD_INTERACTIVE_CLASS_NAME}`}
    >
      {cardBody}
    </Link>
  );
}
