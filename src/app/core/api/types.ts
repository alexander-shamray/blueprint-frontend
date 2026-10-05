/**
 * The wire shapes, hand-written, one interface per backend record, each citing
 * the file and symbol it mirrors (spec §1, property 2; spec §3, "Types").
 * Generation from the OpenAPI documents was considered and deferred: the BFF
 * publishes no document, a handful of endpoints do not pay for the tooling, and a
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
  /**
   * Inventory's level as Catalog last projected it, and `null` where none was
   * ever reported: `GetProductsHandler.cs` LEFT JOINs `catalog.StockLevels`,
   * which `StockLevelProjection.cs` fills only on a `StockLevelChanged`. So
   * null is "never reported" and not "none", and a screen that rendered it as
   * out of stock would be refusing to sell a product nobody has counted.
   * A hint for the listing, not a reservation — `client-architecture.md` §12.
   */
  readonly quantityAvailable: number | null;
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

/** Web.Bff/Orders/OrderResponses.cs — `Money`. The server's numbers; the client formats, never computes. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/**
 * Web.Bff/Orders/BuyerStatuses.cs — §10.7's closed vocabulary, in rank order:
 * `placed` lowest, `delivered` highest, and the three cancellation members
 * sharing one rank because one `OrderCancelled` decides between them. These
 * are buyer statuses the BFF computes, not saga states, and the client maps
 * none of its own: the backend's §10.7 says neither the saga's states nor
 * `OrderStatus` reaches a client.
 */
export const BUYER_STATUSES = [
  'placed',
  'confirmed',
  'dispatched',
  'cancelled',
  'out_of_stock',
  'declined',
  'delivered',
] as const;

export type BuyerStatus = (typeof BUYER_STATUSES)[number];

/**
 * The members no later event moves an order off. `delivered` outranks a
 * cancellation and every cancellation member outranks `dispatched`
 * (`BuyerStatus.Of`), so nothing reaches past any of these four. What it
 * decides here is only when a poll stops asking; the timeline draws from the
 * timestamps, never from this list.
 */
export const TERMINAL_STATUSES: readonly BuyerStatus[] = [
  'cancelled',
  'out_of_stock',
  'declined',
  'delivered',
];

/** Web.Bff/Orders/OrderResponses.cs — `OrderTimeline`. Keyed by name, so a screen never draws by position. */
export interface OrderTimeline {
  /** DateTimeOffset on the wire, each one; the client displays them and does no arithmetic on them. */
  readonly placed: string | null;
  readonly confirmed: string | null;
  readonly dispatched: string | null;
  readonly delivered: string | null;
  readonly cancelled: string | null;
}

/**
 * Web.Bff/Orders/OrderResponses.cs — `OrderLineSummary`. `productName` is
 * null whenever the BFF never saw the product's Catalog event, which §10.7
 * names as ordinary rather than exotic.
 */
export interface OrderLineSummary {
  readonly productId: string;
  readonly productName: string | null;
  readonly lineTotal: Money;
}

/**
 * Web.Bff/Orders/OrderResponses.cs — `OrderSummary`, one row of
 * `GET /bff/v1/orders`.
 *
 * `status` is typed `string` rather than `BuyerStatus` on purpose: the set is
 * closed by contract, and a screen that meets a member outside it renders the
 * string as sent rather than trusting a type the wire never promised.
 */
export interface OrderSummary {
  readonly orderId: string;
  readonly status: string;
  readonly timeline: OrderTimeline;
  /** Beside the status, not a member of it: a refund follows a cancellation and must not hide which one. */
  readonly refunded: boolean;
  readonly refundedAt: string | null;
  /**
   * A hint and not an authority (§10.7): computed from a projection that lags
   * `Order.Cancel`, so it can read true while the command answers 422. It
   * chooses what to offer; the cancel's own answer is still handled.
   */
  readonly cancellable: boolean;
  /** Null, and `lines` empty, while no placed or confirmed event has priced the order. */
  readonly total: Money | null;
  readonly lines: readonly OrderLineSummary[];
  /** The BFF's clock at the row's last write: when it last learned, not that nothing followed. */
  readonly asOf: string;
}

/** Web.Bff/Orders/OrderResponses.cs — `OrderLineDetail`. */
export interface OrderLineDetail extends OrderLineSummary {
  readonly quantity: number;
  readonly unitPrice: Money;
}

/** Web.Bff/Orders/OrderResponses.cs — `PaymentFacts`. A decline has none; the status says so. */
export interface PaymentFacts {
  readonly authorisedAt: string | null;
  readonly amount: Money | null;
  readonly refundedAmount: Money | null;
}

/** Web.Bff/Orders/OrderResponses.cs — `ShipmentFacts`. Two milestones and a number; there is no tracking feed. */
export interface ShipmentFacts {
  readonly trackingNumber: string | null;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
}

/** Web.Bff/Orders/OrderResponses.cs — `OrderDetail`, the answer to `GET /bff/v1/orders/{id}`. */
export interface OrderDetail extends Omit<OrderSummary, 'lines'> {
  readonly lines: readonly OrderLineDetail[];
  readonly payment: PaymentFacts | null;
  readonly shipment: ShipmentFacts | null;
}

/**
 * Catalog.Api/CatalogPermissions.cs and Ordering.Api/OrderingPermissions.cs.
 * Claims, not roles: the `commerce-api` client scope maps a multivalued
 * `permission` claim and `RequireClaim` reads it. There is no `catalog:read`
 * and no `orders:read` — a permission nothing requires is a dead name in the
 * realm, and both files say so explicitly.
 *
 * The order read still requires none of these. It is the BFF's, not
 * Ordering's, and `Web.Bff/Endpoints/OrderEndpoints.cs` requires an
 * authenticated principal and binds the subject from it — so being signed in
 * is the whole of what it asks, and `signedInGuard` is what the route checks.
 */
export const PERMISSIONS = {
  catalogWrite: 'catalog:write',
  ordersWrite: 'orders:write',
  ordersCancel: 'orders:cancel',
} as const;
