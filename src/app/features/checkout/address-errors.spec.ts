import { describe, expect, it } from 'vitest';
import { splitAddressErrors } from './address-errors';

describe('splitAddressErrors', () => {
  it('puts each ShippingAddress key under the control that owns it', () => {
    const { byField, rest } = splitAddressErrors({
      'ShippingAddress.Line1': ['Line 1 is required.'],
      'ShippingAddress.PostalCode': ['Too long.'],
      'ShippingAddress.Country': ['Not a country code.'],
    });

    expect(byField).toEqual({
      line1: ['Line 1 is required.'],
      postalCode: ['Too long.'],
      country: ['Not a country code.'],
    });
    expect(rest).toEqual({});
  });

  it('matches regardless of case, since the key is a property path and not prose', () => {
    expect(splitAddressErrors({ 'shippingAddress.city': ['x'] }).byField).toEqual({ city: ['x'] });
  });

  it('leaves every key no control owns for the banner, as sent', () => {
    const { byField, rest } = splitAddressErrors({
      Items: ['An order cannot contain more than 100 items.'],
      ShippingAddress: ['Required.'],
      'Other.Line1': ['Not ours.'],
    });

    expect(byField).toEqual({});
    expect(rest).toEqual({
      Items: ['An order cannot contain more than 100 items.'],
      ShippingAddress: ['Required.'],
      'Other.Line1': ['Not ours.'],
    });
  });

  it('keeps a key named __proto__ as an own key, as sent', () => {
    // Parsed rather than written as a literal: in a literal, `__proto__` sets
    // the prototype, while JSON.parse — which is how the body arrives — makes
    // it an own key.
    const errors = JSON.parse('{"__proto__": ["Not ours."]}') as Record<string, readonly string[]>;
    const { rest } = splitAddressErrors(errors);

    expect(Object.keys(rest)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(rest, '__proto__')?.value).toEqual(['Not ours.']);
  });

  it('answers nothing for no errors', () => {
    expect(splitAddressErrors(undefined)).toEqual({ byField: {}, rest: {} });
  });
});
