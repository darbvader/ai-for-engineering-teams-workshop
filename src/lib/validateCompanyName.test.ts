import { describe, expect, it } from 'vitest';

import { MAX_COMPANY_NAME_LENGTH, validateCompanyName } from './validateCompanyName';

describe('validateCompanyName', () => {
  describe('accepted names', () => {
    it.each([
      'Acme Corp',
      'TechStart Inc',
      "O'Brien & Sons",
      'Smith, Jones (Holdings)',
      'Société Générale',
      '3M',
      'Data-Flow Analytics',
    ])('accepts %j', (input) => {
      expect(validateCompanyName(input).ok).toBe(true);
    });

    it('returns the normalized value', () => {
      const result = validateCompanyName('  Acme   Corp  ');
      expect(result).toEqual({ ok: true, value: 'Acme Corp' });
    });

    it('accepts exactly the maximum length', () => {
      expect(validateCompanyName('a'.repeat(MAX_COMPANY_NAME_LENGTH)).ok).toBe(true);
    });
  });

  describe('rejected names', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   \t\n '],
      ['script payload', '<script>alert(1)</script>'],
      ['angle brackets', 'Acme <b>Corp</b>'],
      ['forward slash', 'Acme/Corp'],
      ['backslash', 'Acme\\Corp'],
      ['backtick', 'Acme`Corp'],
      ['control character', 'AcmeCorp'],
    ])('rejects %s', (_label, input) => {
      expect(validateCompanyName(input).ok).toBe(false);
    });

    it('rejects a name longer than the maximum', () => {
      const result = validateCompanyName('a'.repeat(MAX_COMPANY_NAME_LENGTH + 1));
      expect(result.ok).toBe(false);
    });

    it.each([[undefined], [null], [42], [{}], [[]]])('rejects the non-string %j', (input) => {
      expect(validateCompanyName(input).ok).toBe(false);
    });

    it('returns a user-safe reason with no internal detail', () => {
      const result = validateCompanyName('<script>');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toMatch(/src\/|node_modules|Error:/);
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe('normalization', () => {
    it('collapses internal whitespace runs to a single space', () => {
      const result = validateCompanyName('Global\t\tSolutions   Ltd');
      expect(result).toEqual({ ok: true, value: 'Global Solutions Ltd' });
    });

    it('measures length after trimming', () => {
      const padded = `   ${'a'.repeat(MAX_COMPANY_NAME_LENGTH)}   `;
      expect(validateCompanyName(padded).ok).toBe(true);
    });
  });
});
