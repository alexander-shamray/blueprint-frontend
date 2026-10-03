/** The form's five controls, which are `AddressDto`'s five members. */
export const ADDRESS_FIELDS = ['line1', 'line2', 'city', 'postalCode', 'country'] as const;

export type AddressField = (typeof ADDRESS_FIELDS)[number];

export interface AddressErrors {
  /** Messages the page can put under the control they concern. */
  readonly byField: Readonly<Partial<Record<AddressField, readonly string[]>>>;
  /** Everything else, keyed as sent, for the banner — `Items`, `Currency`, the address as a whole. */
  readonly rest: Readonly<Record<string, readonly string[]>>;
}

/**
 * `ValidationProblemDetails.errors` split by whether a control on this form
 * owns the key.
 *
 * `ValidationExceptionHandler.cs` keys by FluentValidation's `PropertyName`,
 * and `PlaceOrderValidator.cs` writes its address rules as
 * `x.ShippingAddress.Line1` and so on, so the keys arrive as
 * `ShippingAddress.Line1`. Matched case-insensitively on the whole key rather
 * than on its last segment: a `Line1` belonging to some other member is not
 * this form's to show, and a key nothing here recognises stays in the banner
 * exactly as sent, which is where every key went before this split existed.
 */
export function splitAddressErrors(
  errors: Readonly<Record<string, readonly string[]>> | undefined,
): AddressErrors {
  const byField: Partial<Record<AddressField, readonly string[]>> = {};
  const rest: Record<string, readonly string[]> = {};

  for (const [key, messages] of Object.entries(errors ?? {})) {
    const field = ADDRESS_FIELDS.find((f) => key.toLowerCase() === `shippingaddress.${f.toLowerCase()}`);
    if (field) byField[field] = [...(byField[field] ?? []), ...messages];
    else rest[key] = messages;
  }

  return { byField, rest };
}
