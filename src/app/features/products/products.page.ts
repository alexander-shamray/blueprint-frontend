import { ChangeDetectionStrategy, Component, Signal, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel,
  IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, IonButton,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductSummary } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.1. The landing tab, and it works before sign-in: the listing is
 * anonymous at the gateway and at the endpoint, so a client that demanded a
 * token here would be refusing to show what the platform publishes.
 */
@Component({
  selector: 'app-products',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem,
    IonLabel, IonList, IonNote, IonThumbnail, IonTitle, IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Products</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <ion-list>
        @for (product of products(); track product.productId) {
          <ion-item>
            @if (product.thumbnailUrl) {
              <ion-thumbnail slot="start">
                <img [src]="product.thumbnailUrl" [alt]="product.name" />
              </ion-thumbnail>
            }

            <ion-label>
              <h2>{{ product.name }}</h2>
              <ion-note>{{ product.amount }} {{ product.currency }}</ion-note>
            </ion-label>

            <ion-button slot="end" fill="clear" (click)="addToCart(product)">Add</ion-button>
          </ion-item>
        }
      </ion-list>

      <ion-infinite-scroll [disabled]="!hasMore()" (ionInfinite)="loadMore($event)">
        <ion-infinite-scroll-content></ion-infinite-scroll-content>
      </ion-infinite-scroll>
    </ion-content>
  `,
})
export class ProductsPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private readonly catalogRefresh = inject(CatalogRefresh);
  private cursor: string | null = null;

  /**
   * Bumped by `reload()`. `load()` captures the generation it was called
   * under and checks it again when the response lands; a response whose
   * generation no longer matches was superseded by a later `reload()` and is
   * dropped rather than applied. Without this, a `loadMore()` in flight when
   * Task 14's publish page calls `reload()` lands AFTER the fresh first page
   * and appends its items onto — and overwrites `cursor` from — a pagination
   * sequence that `reload()` already discarded. A `switchMap` would hide that
   * drop rather than state it, and `load()` is called from three call sites
   * (constructor, `reload()`, `loadMore()`) with different completion
   * semantics that a shared pipeline operator would have to paper over.
   */
  private generation = 0;

  private readonly productsSignal = signal<readonly ProductSummary[]>([]);
  private readonly errorSignal = signal<DisplayError | null>(null);
  /** Null nextCursor is the last page (CursorPage.cs). Nothing asks past it. */
  private readonly hasMoreSignal = signal(true);

  // Writable only inside this class — CartStore.lines and CommandIdentity's
  // current/isSpent make the same choice, for the same reason: Task 14 holds
  // a reference to this instance and `readonly` on the field only stops
  // reassignment, not `.set()` from outside.
  readonly products: Signal<readonly ProductSummary[]> = this.productsSignal.asReadonly();
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  readonly hasMore: Signal<boolean> = this.hasMoreSignal.asReadonly();

  constructor() {
    this.load();

    // Ionic caches this page's ComponentRef in its tab-stack view list and
    // reuses it on re-entry (StackController.getExistingView, via
    // IonRouterOutlet.activateWith) instead of constructing a fresh one, so
    // this constructor runs exactly ONCE per app session, not once per visit
    // to the tab. Without this effect, navigating back here after publishing
    // shows the stale list from the first (and only) construction. Task 14's
    // publish page calls CatalogRefresh.request() instead of trying to
    // navigate its way to a reload that navigation alone cannot produce.
    //
    // An effect() runs once immediately on top of every signal it reads, so
    // the version seen right here — before that first run — is remembered
    // and compared against: the first run is this same construction's own
    // load() above, and reloading again for it would double-fetch on every
    // app start.
    const constructedAtVersion = this.catalogRefresh.current();
    effect(() => {
      if (this.catalogRefresh.current() === constructedAtVersion) return;
      this.reload();
    });
  }

  /** Called by the publish page after a success (spec §5.5). */
  reload(): void {
    this.generation++;
    this.cursor = null;
    this.productsSignal.set([]);
    this.hasMoreSignal.set(true);
    this.load();
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  addToCart(product: ProductSummary): void {
    // Local only. The backend has no cart, so there is nothing to call.
    this.cart.add(product);
  }

  private load(done?: () => void): void {
    const generation = this.generation;

    this.catalog.products(this.cursor).subscribe({
      next: (page) => {
        // The ion-infinite-scroll element that triggered this call (if any)
        // is not destroyed by reload() — only the signals are reset — so its
        // internal `isLoading` flag survives a reload and must still be
        // cleared here even when the response itself is discarded below.
        // Ionic's own InfiniteScroll never fires `ionInfinite` again while
        // `isLoading` stays true, so skipping this on the stale branch would
        // reintroduce the hang this component exists to avoid.
        done?.();

        // Superseded by a reload() that started a new pagination sequence
        // while this request was in flight. Applying it now would append
        // onto the fresh list and overwrite `cursor` with a value computed
        // against the sequence reload() already discarded.
        if (generation !== this.generation) return;

        this.errorSignal.set(null);
        this.productsSignal.update((existing) => [...existing, ...page.items]);
        this.cursor = page.nextCursor;
        this.hasMoreSignal.set(page.nextCursor !== null);
      },
      error: (failure: HttpErrorResponse) => {
        done?.();
        if (generation !== this.generation) return;

        this.errorSignal.set(mapError(failure));
        // Stop asking. Retrying into a 429 is how a rate limit becomes a loop.
        this.hasMoreSignal.set(false);
      },
    });
  }
}
