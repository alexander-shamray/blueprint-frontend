import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonNote, IonText, IonTitle,
  IonToolbar,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductSummary } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CatalogAvailability } from '@core/catalog/catalog-availability';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { EmptyStateComponent } from '@shared/empty-state.component';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { SkeletonListComponent } from '@shared/skeleton-list.component';
import { stockLabel, stockOf } from './stock';

/**
 * The form Catalog writes a product id in. `GetProduct` is mapped on
 * `{id:guid}`, so anything else is a route miss there; refusing it here sends
 * no request for an id that cannot name a product, and keeps a hand-typed
 * `..` out of the path the gateway resolves.
 */
const PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Product detail, `GET /api/v1/catalog/products/{id}`, pushed on the Products
 * tab's stack — the route #105 asked for, so a product has an address that
 * can be bookmarked, shared and opened from outside the app. It replaced the
 * sheet #83 drew over the listing's row (`docs/client-architecture.md` §12,
 * "Product detail is a route, because Catalog serves a product by id"): one
 * rendering of a product, reached from the row or from a link.
 *
 * Anonymous, as the listing is (§1), and on the same `catalogue` limiter
 * bucket. A 404 is the platform saying there is no such product — never
 * published, or withdrawn, which `GetProductHandler.cs` deliberately does not
 * distinguish — so it is a stated page with the way back, not a banner over
 * an empty screen. Any other failure is a banner and Try again.
 *
 * The stepper floors at one and has no ceiling, and a request above a
 * positive listed level is warned about rather than refused: the level is
 * Catalog's projection and the reservation is Inventory's (§12, "The listing
 * carries stock, and null is not none").
 */
@Component({
  selector: 'app-product',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonNote, IonText, IonTitle,
    IonToolbar, RouterLink, EmptyStateComponent, ErrorBannerComponent, MoneyPipe,
    SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/products"></ion-back-button></ion-buttons>
        <ion-title i18n="@@product.title">Product</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <app-error-banner [error]="error() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

      @if (error()) {
        <ion-button expand="block" fill="outline" [disabled]="rateLimit.blocked()"
          (click)="load()" i18n="@@action.tryAgain">Try again</ion-button>
      }

      @if (notAvailable()) {
        <app-empty-state heading="This product is not available"
          i18n-heading="@@product.unavailableHeading"
          message="It may have been withdrawn, or the link may be wrong."
          i18n-message="@@product.unavailableMessage">
          <ion-button routerLink="/tabs/products" fill="outline"
            i18n="@@product.browse">Browse products</ion-button>
        </app-empty-state>
      } @else if (product(); as p) {
        @if (p.thumbnailUrl; as url) {
          <img class="hero" [src]="url" [alt]="p.name" />
        }

        <ion-text><h2 data-testid="product-name">{{ p.name }}</h2></ion-text>
        <ion-text><p class="price" data-testid="product-price">{{ p.amount | money: p.currency }}</p></ion-text>

        @if (label(); as text) {
          <ion-note data-testid="product-stock" [color]="stock().kind === 'out' ? 'danger' : 'medium'">
            {{ text }}
          </ion-note>
        }

        <div class="stepper">
          <ion-button fill="outline" aria-label="One fewer" i18n-aria-label="@@product.fewer" [disabled]="quantity() <= 1"
            (click)="step(-1)">−</ion-button>
          <span data-testid="product-quantity" aria-live="polite">{{ quantity() }}</span>
          <ion-button fill="outline" aria-label="One more" i18n-aria-label="@@product.more" (click)="step(1)">+</ion-button>
        </div>

        @if (exceeds()) {
          <ion-note color="warning" data-testid="product-exceeds" i18n="@@product.exceeds">
            More than the {{ p.quantityAvailable }} listed. Inventory decides at checkout.
          </ion-note>
        }

        <ion-button expand="block" [disabled]="stock().kind === 'out'" (click)="addToCart()"
          i18n="@@product.addToCart">
          Add to cart
        </ion-button>

        <p role="status" class="added" data-testid="product-added">
          @if (added(); as n) {
            <ng-container i18n="@@product.added">Added {{ n }} to the cart.</ng-container>
          }
        </p>
      } @else if (loading()) {
        <app-skeleton-list [rows]="3" />
      }
    </ion-content>
  `,
  styles: `
    .hero { display: block; width: 100%; max-height: 50vh; object-fit: contain; }
    .price { font-size: 1.25rem; margin: .25rem 0; }
    .stepper { display: flex; align-items: center; gap: 1rem; margin: 1rem 0; }
    .added { color: var(--ion-color-medium); }
  `,
})
export class ProductPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private readonly availability = inject(CatalogAvailability);
  private readonly route = inject(ActivatedRoute);

  /** Reactive for the reason `OrderPlacedPage.orderId` gives: a reused route keeps emitting. */
  readonly productId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? '' },
  );

  private readonly productState = signal<ProductSummary | null>(null);
  private readonly loadingState = signal(false);
  private readonly errorState = signal<DisplayError | null>(null);
  private readonly notAvailableState = signal(false);
  private readonly quantityState = signal(1);
  private readonly addedState = signal<number | null>(null);

  readonly product = this.productState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly error = this.errorState.asReadonly();
  /** The platform has no such product to show: a 404, or an id that cannot name one. */
  readonly notAvailable = this.notAvailableState.asReadonly();
  readonly quantity = this.quantityState.asReadonly();
  /** The quantity the last Add to cart put in the cart, said once in a status line. */
  readonly added = this.addedState.asReadonly();

  protected readonly stock = computed(() => stockOf(this.productState()?.quantityAvailable ?? null));
  protected readonly label = computed(() => stockLabel(this.stock()));

  protected readonly exceeds = computed(() => {
    const available = this.productState()?.quantityAvailable ?? null;
    return available !== null && available > 0 && this.quantityState() > available;
  });

  /** Spec §6's 429 row: the anonymous bucket the listing draws on (`ProductsPage.rateLimit`). */
  readonly rateLimit = inject(RateLimitWindows).catalogue;

  /** Which read is the latest; a reply to any other is dropped, as `OrderDetailPage` drops its own. */
  private generation = 0;

  /** The id the last automatic read was issued for, so a window closing does not read it again. */
  private readFor: string | null = null;

  constructor() {
    // A link can arrive while the catalogue window is open — the listing may
    // have just been refused — and a read sent then is one the client
    // already expects to be refused, which reopens the window (#161). So
    // the first read for an id waits for the window to close, and the banner
    // says why meanwhile; a read that fails is retried by Try again, never
    // by this effect.
    effect(() => {
      const id = this.productId();
      if (this.rateLimit.blocked()) return;
      untracked(() => {
        if (id === this.readFor) return;
        this.readFor = id;
        this.productState.set(null);
        this.quantityState.set(1);
        this.addedState.set(null);
        this.load();
      });
    });
  }

  load(): void {
    const id = this.productId();
    const generation = ++this.generation;
    this.errorState.set(null);
    this.notAvailableState.set(false);

    if (!PRODUCT_ID.test(id)) {
      this.loadingState.set(false);
      this.notAvailableState.set(true);
      return;
    }

    this.loadingState.set(true);
    this.catalog.product(id).subscribe({
      next: (product) => {
        if (generation !== this.generation) return;
        this.loadingState.set(false);
        this.availability.record([product]);
        this.productState.set(product);
      },
      error: (failure: HttpErrorResponse) => {
        if (generation !== this.generation) return;
        this.loadingState.set(false);
        if (failure.status === 404) {
          this.productState.set(null);
          this.notAvailableState.set(true);
        } else {
          this.errorState.set(mapError(failure));
        }
      },
    });
  }

  step(by: number): void {
    this.quantityState.update((n) => Math.max(1, n + by));
  }

  addToCart(): void {
    // The button is disabled out of stock; this refuses too, because the
    // binding and the method are two paths to the same store.
    const product = this.productState();
    if (product === null || stockOf(product.quantityAvailable).kind === 'out') return;

    this.cart.add(product, this.quantityState());
    this.addedState.set(this.quantityState());
    this.quantityState.set(1);
  }
}
