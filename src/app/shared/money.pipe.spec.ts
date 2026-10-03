import { LOCALE_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MoneyPipe } from './money.pipe';

describe('MoneyPipe', () => {
  let pipe: MoneyPipe;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MoneyPipe, { provide: LOCALE_ID, useValue: 'en-US' }],
    });
    pipe = TestBed.inject(MoneyPipe);
  });

  it('writes the amount in the currency the server named', () => {
    expect(pipe.transform(12.5, 'EUR')).toBe('€12.50');
    expect(pipe.transform(12.5, 'GBP')).toBe('£12.50');
  });

  it('pads to the minor unit and never rounds past it', () => {
    // decimal(19,4) on the backend: four places are a real price, and the
    // currency's two-place default would round this one to 12.35.
    expect(pipe.transform(12.3456, 'USD')).toBe('$12.3456');
  });

  it('renders a free product as zero rather than as nothing', () => {
    expect(pipe.transform(0, 'EUR')).toBe('€0.00');
  });

  it('writes a three-letter code Intl has no symbol for as the code', () => {
    expect(pipe.transform(3, 'XYZ')).toContain('XYZ');
    expect(pipe.transform(3, 'XYZ')).toContain('3.00');
  });

  it('falls back to the sent values when the code is not a currency code at all', () => {
    expect(pipe.transform(12.5, 'EU')).toBe('12.5 EU');
  });
});
