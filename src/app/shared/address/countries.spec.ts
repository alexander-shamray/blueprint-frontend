import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, countryOptions } from './countries';

describe('countries', () => {
  it('holds only codes the backend pattern admits, once each', () => {
    expect(COUNTRY_CODES.every((c) => /^[A-Za-z]{2}$/.test(c))).toBe(true);
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });

  it('names and sorts them for the locale', () => {
    const options = countryOptions('en-US');
    const names = options.map((o) => o.name);

    expect(options.find((o) => o.code === 'QA')?.name).toBe('Qatar');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-US')));
  });
});
