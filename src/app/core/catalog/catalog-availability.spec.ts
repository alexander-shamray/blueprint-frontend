import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProductSummary } from '@core/api/types';
import { CatalogAvailability } from './catalog-availability';

const product = (productId: string, quantityAvailable: number | null): ProductSummary => ({
  productId, name: productId, thumbnailUrl: null, amount: 1, currency: 'EUR',
  publishedAt: '2026-09-10T00:00:00Z', quantityAvailable,
});

describe('CatalogAvailability', () => {
  let availability: CatalogAvailability;

  beforeEach(() => {
    availability = TestBed.inject(CatalogAvailability);
  });

  it('answers undefined for a product the listing has not shown', () => {
    expect(availability.of('p1')).toBeUndefined();
  });

  it('keeps null as the platform sent it rather than as unknown', () => {
    availability.record([product('p1', null)]);

    expect(availability.of('p1')).toBeNull();
  });

  it('takes a later page over an earlier one and keeps the rest', () => {
    availability.record([product('p1', 5), product('p2', 2)]);
    availability.record([product('p1', 0)]);

    expect(availability.of('p1')).toBe(0);
    expect(availability.of('p2')).toBe(2);
  });

  it('does not answer for an inherited key', () => {
    expect(availability.of('constructor')).toBeUndefined();
  });
});
