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

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteLine`. */
export interface QuoteLine {
  readonly productId: string;
  readonly name: string;
  readonly amount: number;
}

/** Web.Bff/Endpoints/QuoteResponse.cs — `QuoteResponse`. */
export interface QuoteResponse {
  readonly currency: string;
  readonly lines: readonly QuoteLine[];
  /**
   * The BFF's own sum. Spec §5.2: shown as sent, never recomputed — two places
   * computing a total is two places to get rounding wrong, which is the reason
   * QuoteResponse.cs gives for computing it there at all.
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

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
