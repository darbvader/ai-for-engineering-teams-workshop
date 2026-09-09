import { describe, expect, it } from 'vitest';

import { PredictiveIntelligenceError } from '@/services/errors';

import {
  MAX_CUSTOMER_IDS,
  validateAlertActionRequest,
  validateIntelligenceRequest,
} from './validateIntelligenceRequest';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('validateIntelligenceRequest', () => {
  it('accepts an empty query, meaning every customer', () => {
    expect(validateIntelligenceRequest(params(''))).toEqual({});
  });

  it('parses and trims a comma-separated id list', () => {
    expect(validateIntelligenceRequest(params('customerIds=1, 2 ,3')).customerIds).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('rejects a malformed id', () => {
    expect(() => validateIntelligenceRequest(params('customerIds=1,<script>'))).toThrow(
      PredictiveIntelligenceError
    );
  });

  it('tags a malformed id with INVALID_INPUT', () => {
    expect(() => validateIntelligenceRequest(params('customerIds=a/b'))).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' })
    );
  });

  it('accepts a well-formed unknown id, which the service reports separately', () => {
    expect(validateIntelligenceRequest(params('customerIds=nope-999')).customerIds).toEqual([
      'nope-999',
    ]);
  });

  it('accepts exactly the maximum number of ids and rejects one more', () => {
    const atLimit = Array.from({ length: MAX_CUSTOMER_IDS }, (_, index) => index + 1).join(',');
    const overLimit = `${atLimit},51`;

    expect(validateIntelligenceRequest(params(`customerIds=${atLimit}`)).customerIds).toHaveLength(
      MAX_CUSTOMER_IDS
    );
    expect(() => validateIntelligenceRequest(params(`customerIds=${overLimit}`))).toThrow(
      PredictiveIntelligenceError
    );
  });

  it('rejects an empty id list', () => {
    expect(() => validateIntelligenceRequest(params('customerIds=,,'))).toThrow(
      PredictiveIntelligenceError
    );
  });

  it('accepts the two priority literals and rejects anything else', () => {
    expect(validateIntelligenceRequest(params('priority=high')).priority).toBe('high');
    expect(validateIntelligenceRequest(params('priority=medium')).priority).toBe('medium');
    expect(() => validateIntelligenceRequest(params('priority=urgent'))).toThrow(
      PredictiveIntelligenceError
    );
  });

  it('accepts a supported IANA zone', () => {
    expect(validateIntelligenceRequest(params('timezone=Europe%2FLondon')).timezone).toBe(
      'Europe/London'
    );
  });

  it('rejects an unsupported zone rather than falling back silently', () => {
    expect(() => validateIntelligenceRequest(params('timezone=Mars%2FOlympus'))).toThrow(
      PredictiveIntelligenceError
    );
  });
});

describe('validateAlertActionRequest', () => {
  it('accepts a well-formed body', () => {
    expect(validateAlertActionRequest({ alertId: '1:payment-risk', action: 'dismiss' })).toEqual({
      alertId: '1:payment-risk',
      action: 'dismiss',
    });
  });

  it('rejects a non-object body', () => {
    expect(() => validateAlertActionRequest('dismiss everything')).toThrow(
      PredictiveIntelligenceError
    );
    expect(() => validateAlertActionRequest([])).toThrow(PredictiveIntelligenceError);
  });

  it('rejects a malformed alert id', () => {
    expect(() => validateAlertActionRequest({ alertId: 'payment-risk', action: 'dismiss' })).toThrow(
      PredictiveIntelligenceError
    );
  });

  it('rejects an unknown action', () => {
    expect(() =>
      validateAlertActionRequest({ alertId: '1:payment-risk', action: 'delete' })
    ).toThrow(PredictiveIntelligenceError);
  });

  it('never echoes the offending value back in the message', () => {
    try {
      validateAlertActionRequest({ alertId: '1:<script>alert(1)</script>', action: 'dismiss' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('<script>');
    }
  });
});
