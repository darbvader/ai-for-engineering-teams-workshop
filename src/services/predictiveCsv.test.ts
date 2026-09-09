import { describe, expect, it } from 'vitest';

import { escapeCsvCell, toCsv } from './predictiveCsv';

describe('escapeCsvCell', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'prefixes a cell beginning with %j so a spreadsheet cannot execute it',
    (prefix) => {
      expect(escapeCsvCell(`${prefix}cmd|'/c calc'!A1`)).toBe(`"'${prefix}cmd|'/c calc'!A1"`);
    }
  );

  it('leaves an ordinary cell unprefixed', () => {
    expect(escapeCsvCell('payment-risk')).toBe('"payment-risk"');
  });

  it('doubles embedded quotes so the column layout cannot shift', () => {
    expect(escapeCsvCell('say "hello"')).toBe('"say ""hello"""');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it('quotes a cell containing a comma or a newline', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"');
  });

  it('guards a negative number, which reads as a formula prefix', () => {
    expect(escapeCsvCell(-5)).toBe(`"'-5"`);
  });
});

describe('toCsv', () => {
  it('writes a header row followed by the body', () => {
    const csv = toCsv(['at', 'event'], [['2026-09-09T10:00:00Z', 'dismissed']]);

    expect(csv).toBe('"at","event"\n"2026-09-09T10:00:00Z","dismissed"');
  });

  it('writes only the header for an empty body', () => {
    expect(toCsv(['at'], [])).toBe('"at"');
  });
});
