/**
 * The wire shapes, hand-written, one interface per backend record, each citing
 * the file and symbol it mirrors (spec §1, property 2; spec §3, "Types").
 * Generation from the OpenAPI documents was considered and deferred: the BFF
 * publishes no document, six endpoints do not pay for the tooling, and a
 * citing comment is what lets grep find drift in either direction.
 *
 * Field names are camelCase because that is what ASP.NET Core's default
 * JsonSerializerOptions produces, not because the client prefers it.
 */

/** Common.Application/CursorPage.cs — `CursorPage<T>`. Null `nextCursor` is the last page. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Catalog.Application/Products/GetProducts/ProductSummaryDto.cs — `ProductSummaryDto`. */
export interface ProductSummary {
  readonly productId: string;
  readonly name: string;
  readonly thumbnailUrl: string | null;
  readonly amount: number;
  readonly currency: string;
  /** DateTimeOffset on the wire; the client only ever displays it. */
  readonly publishedAt: string;
}

/** Catalog.Application/Products/PublishProduct/PublishProductCommand.cs — `PublishProductCommand`. */
export interface PublishProductCommand {
  readonly commandId: string;
  readonly name: string;
  readonly thumbnailUrl: string | null;
  /**
   * `decimal?` on the backend, and the nullability is load-bearing there: an
   * omitted amount would bind as 0 and publish a free product. The client
   * always sends a number, so the type is not optional here — but it must
   * never send `null` to mean "the user left it blank", because the backend's
   * validator turns that into a field-keyed 400 which is exactly right.
   */
  readonly amount: number;
  readonly currency: string;
}

/** Web.Bff/Endpoints/QuoteRequest.cs — `QuoteRequestLine`. */
export interface QuoteRequestLine {
  readonly productId: string;
  readonly quantity: number;
}

/**
 * Web.Bff/Endpoints/QuoteRequest.cs — `QuoteRequest`. A body rather than a
 * query string because the request is a list of records, and the endpoint is
 * therefore a POST: the record's own comment argues both, and adds that
 * nothing caches a quote keyed to one customer's basket.
 *
 * The lines are sent as the cart holds them. A product named by more than one
 * line is merged by the endpoint — `Order.AddLine` merges the same basket one
 * service over — so the client must not drop a repeated line to tidy the
 * request: under the old contract a repeated id carried no information, and
 * now it carries a quantity.
 *
 * `QuoteRequestValidator` bounds this against `OrderLimits` — `MinQuantity` 1,
 * `MaxQuantity` 999 summed per product, `MaxLines` 100 — deliberately the same
 * numbers `PlaceOrderValidator` enforces, so a quote never prices a basket the
 * order would refuse. Those numbers are not repeated here: past them the
 * platform answers a field-keyed 400 that `mapError()` already surfaces, and a
 * second copy in the client is a copy that drifts from the one enforced.
 */
export interface QuoteRequest {
  readonly currency: string;
  readonly lines: readonly QuoteRequestLine[];
}

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteLine`. */
export interface QuoteLine {
  readonly productId: string;
  readonly name: string;
  /**
   * The price of ONE of it, which is a thing the screen needs rather than an
   * intermediate value: a cart renders "2 × 12.50 = 25.00", and `amount` is
   * the first of those three numbers.
   */
  readonly amount: number;
  /** Echoed from the request, so the reply stands on its own. */
  readonly quantity: number;
  /**
   * `amount * quantity`, computed by the BFF. Supplying the unit price and the
   * quantity but not this would leave every line total computed in the client,
   * which is the same defect `total` exists to prevent, one level down.
   */
  readonly lineTotal: number;
}

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteResponse`. */
export interface QuoteResponse {
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  /**
   * The basket: the sum of every line's `lineTotal`, quantities included.
   * Spec §5.2: shown as sent, never recomputed — two places computing a total
   * is two places to get rounding wrong, which is the reason QuoteResponse.cs
   * gives for computing it there at all.
   */
  readonly total: number;
  /** Products asked about that Catalog returned no price for. Named, not omitted. */
  readonly unpriced: readonly string[];
}

/** Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `PlaceOrderItem`. */
export interface PlaceOrderItem {
  readonly productId: string;
  readonly quantity: number;
}

/** Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `AddressDto`. */
export interface Address {
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * Ordering.Application/Orders/PlaceOrder/PlaceOrderCommand.cs — `PlaceOrderCommand`.
 * There is no customerId, and the omission is the backend's control: the
 * subject of a write is bound from the principal and never from the request.
 * A client that added one would be handing the platform a field it refuses.
 */
export interface PlaceOrderCommand {
  readonly commandId: string;
  readonly items: readonly PlaceOrderItem[];
  readonly shippingAddress: Address;
  readonly currency: string;
}

/** Ordering.Api/Endpoints/OrderEndpoints.cs — `CancelOrderRequest`. */
export interface CancelOrderRequest {
  readonly reason: CancelReason;
}

/**
 * Common.Contracts/Ordering/V1/Commands.cs — `CancelReasons`. A frozen list,
 * in the backend's declaration order. The backend refuses a code it does not
 * know rather than defaulting, so a client inventing a sixth would get a
 * field-keyed 400 naming `Reason` — which is the right answer and still a bug
 * on this side.
 */
export const CANCEL_REASONS = [
  'out_of_stock',
  'stock_timeout',
  'payment_declined',
  'payment_timeout',
  'customer_request',
] as const;

export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Catalog.Api/CatalogPermissions.cs and Ordering.Api/OrderingPermissions.cs.
 * Claims, not roles: the `commerce-api` client scope maps a multivalued
 * `permission` claim and `RequireClaim` reads it. There is no `catalog:read`
 * and no `orders:read` — a permission nothing requires is a dead name in the
 * realm, and both files say so explicitly.
 */
export const PERMISSIONS = {
  catalogWrite: 'catalog:write',
  ordersWrite: 'orders:write',
  ordersCancel: 'orders:cancel',
} as const;
