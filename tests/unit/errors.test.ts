import { describe, expect, it } from 'vitest';
import { describeError } from '../../src/db.ts';

describe('describeError', () => {
  it('adds a plain-language hint for common Postgres error codes', () => {
    expect(
      describeError({ code: '42501', message: 'new row violates row-level security policy' }),
    ).toBe(
      'new row violates row-level security policy [42501: permission denied (row-level security or grants)]',
    );
    expect(describeError({ code: '57014', message: 'canceling statement' })).toMatch(
      /statement timeout/,
    );
  });
  it('falls back to the message for other errors', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError({ code: '99999', message: 'odd' })).toBe('odd [99999]');
    expect(describeError('text')).toBe('text');
  });
});
