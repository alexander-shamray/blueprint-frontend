/**
 * At or below this many left, the listing says how many rather than "In
 * stock". A presentation choice of this client's, not a platform number —
 * Inventory has no notion of "low" — which is why it is named here and
 * nowhere else.
 */
export const LOW_STOCK_THRESHOLD = 5;

export type Stock =
  | { readonly kind: 'unreported' }
  | { readonly kind: 'in' }
  | { readonly kind: 'low'; readonly left: number }
  | { readonly kind: 'out' };

/**
 * `ProductSummary.quantityAvailable` read as one of four states. Null is
 * `unreported` and renders nothing: "never reported" is not "none", and the
 * reason is on the wire type. Zero or below is `out` — a level is a count, and
 * a negative one is still nothing to sell.
 */
export function stockOf(quantityAvailable: number | null): Stock {
  if (quantityAvailable === null) return { kind: 'unreported' };
  if (quantityAvailable <= 0) return { kind: 'out' };
  if (quantityAvailable <= LOW_STOCK_THRESHOLD) return { kind: 'low', left: quantityAvailable };
  return { kind: 'in' };
}

/** The words for a state, or null where the listing says nothing. */
export function stockLabel(stock: Stock): string | null {
  switch (stock.kind) {
    case 'unreported':
      return null;
    case 'in':
      return 'In stock';
    case 'low':
      return `Only ${stock.left} left`;
    case 'out':
      return 'Out of stock';
  }
}
