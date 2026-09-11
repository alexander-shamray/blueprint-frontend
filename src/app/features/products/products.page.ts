import {
  ChangeDetectionStrategy, Component, Signal, computed, effect, inject, signal,
} from '@angular/core';
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
import { RetryCountdown } from '@core/errors/retry-countdown';
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
      <app-error-banner [error]="error()" [retryInSeconds]="rateLimit.remaining()" />

      <!--
        The way back from a failed load — of ANY page, not just the first.
        The automatic retry the infinite scroll would make is still refused
        while an error stands (canLoadMore below), because retrying into a 429
        automatically is how a rate limit becomes a loop; what the user asks
        for explicitly is a different thing, and every other failure in this
        client — Get quote, Place order, Publish, Sign in, Cancel order — is
        already one tap from being tried again.

        Disabled for the length of a 429's window, spec §6's other half: the
        gateway has already said how long to wait, and a button that spends
        that wait being tapped and refused is a countdown nobody is counting.
      -->
      @if (error()) {
        <ion-button expand="block" fill="outline"
          [disabled]="rateLimit.blocked()" (click)="retryLoad()">Try again</ion-button>
      }

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

      <ion-infinite-scroll [disabled]="!canLoadMore()" (ionInfinite)="loadMore($event)">
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
   * a publish elsewhere bumps `CatalogRefresh` — which is what drives this
   * page's own `reload()`, via the effect below; the publish page never calls
   * `reload()` itself, because a feature may not import another feature — lands
   * AFTER the fresh first page and appends its items onto (and overwrites
   * `cursor` from) a pagination sequence that `reload()` already discarded.
   * A `switchMap` would hide that drop rather than state it, and `load()` is
   * called from three call sites (constructor, `reload()`, `loadMore()`) with
   * different completion semantics that a shared pipeline operator would have
   * to paper over.
   */
  private generation = 0;

  private readonly productsSignal = signal<readonly ProductSummary[]>([]);
  private readonly errorSignal = signal<DisplayError | null>(null);
  /**
   * Null nextCursor is the last page (CursorPage.cs). Nothing asks past it.
   *
   * This says what the PLATFORM said, and only that. A failed request says
   * nothing about whether more pages exist, so the error branch below no
   * longer touches this signal: it used to, and the result was that one 429
   * or one 503 on page two ended pagination for the rest of the session — the
   * user could never reach page two again even after the retry window closed.
   * "There are no more pages" and "this attempt failed" are different facts,
   * and are now held in different places; `canLoadMore` is where they meet.
   */
  private readonly hasMoreSignal = signal(true);

  // Writable only inside this class — CartStore.lines and CommandIdentity's
  // current/isSpent make the same choice, for the same reason: `readonly` on
  // the field stops reassignment, not `.set()` from outside. Nothing holds a
  // reference to this component — the publish page asks for a refresh through
  // CatalogRefresh precisely BECAUSE a feature may not import another feature
  // (spec §3, enforced by the ESLint rule and boundaries.spec.ts) — so the
  // point is not to fend off a caller that exists. It is that these three
  // signals are what the platform answered, and the only code entitled to say
  // what the platform answered is the code that read the response.
  readonly products: Signal<readonly ProductSummary[]> = this.productsSignal.asReadonly();
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  readonly hasMore: Signal<boolean> = this.hasMoreSignal.asReadonly();

  /**
   * Spec §6's 429 row, for this page's action. Constructed here, in a field
   * initialiser, because RetryCountdown needs an injection context for its
   * effect and its DestroyRef — the same place `new CommandIdentity()` is
   * built on the pages that have one. `error` above must be declared first:
   * field initialisers run in order.
   */
  readonly rateLimit = new RetryCountdown(this.error);

  /**
   * Whether the infinite scroll may ask for another page on its own.
   *
   * Two independent reasons to stop, deliberately kept apart. `hasMore` is
   * the platform's answer — a null nextCursor, and there is genuinely nothing
   * past it. An error is this attempt's answer, and it is temporary: the
   * scroll stays quiet so it cannot hammer a limiter, and the Try again
   * button above is how the user says otherwise. Clearing the error (which a
   * successful load does) re-arms the scroll at the cursor it left off at.
   */
  readonly canLoadMore = computed(() => this.hasMoreSignal() && this.errorSignal() === null);

  constructor() {
    this.load();

    // Ionic caches this page's ComponentRef in its tab-stack view list and
    // reuses it on re-entry (StackController.getExistingView, via
    // IonRouterOutlet.activateWith) instead of constructing a fresh one, so
    // this constructor runs exactly ONCE per app session, not once per visit
    // to the tab. Without this effect, navigating back here after publishing
    // shows the stale list from the first (and only) construction. The publish
    // page calls CatalogRefresh.request() instead of trying to navigate its
    // way to a reload that navigation alone cannot produce.
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

  /**
   * Restarts the listing from the first page. Reached two ways: the effect
   * above, when a publish elsewhere bumps `CatalogRefresh` (spec §5.5), and
   * the template's "Try again" button after a failed load.
   */
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

  /**
   * The Try again button. Resumes rather than restarts: the error branch
   * leaves `cursor` alone, so it still points at the page that failed, and
   * asking for it again asks for exactly the page that never arrived. On a
   * first-page failure that cursor is null, so this IS the first page again
   * — which is why one method serves both cases and neither has to ask which
   * one it is in.
   *
   * The generation bump is the same guard `reload()` makes: a second tap
   * while the first retry is still in flight must not let both responses
   * append the same page twice.
   */
  retryLoad(): void {
    this.generation++;
    this.load();
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

        // Stop asking automatically — retrying into a 429 is how a rate limit
        // becomes a loop — but say so by RECORDING THE FAILURE, which
        // `canLoadMore` reads, rather than by claiming the catalogue has no
        // more pages. The old line here was `hasMoreSignal.set(false)`, and it
        // made a transient failure indistinguishable from the end of the
        // listing: after a 429's window closed, or after a 503 passed, page
        // two was unreachable for the rest of the session.
        this.errorSignal.set(mapError(failure));
      },
    });
  }
}
