import {
  ChangeDetectionStrategy, Component, Signal, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel,
  IonList, IonModal, IonNote, IonRefresher, IonRefresherContent, IonThumbnail, IonTitle,
  IonToolbar, IonButton,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductSummary } from '@core/api/types';
import { CartStore } from '@core/cart/cart.store';
import { CatalogAvailability } from '@core/catalog/catalog-availability';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { EmptyStateComponent } from '@shared/empty-state.component';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { SkeletonListComponent } from '@shared/skeleton-list.component';
import { ProductSheetComponent } from './product-sheet.component';
import { stockLabel, stockOf } from './stock';

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
    IonLabel, IonList, IonModal, IonNote, IonRefresher, IonRefresherContent, IonThumbnail,
    IonTitle, IonToolbar, EmptyStateComponent, ErrorBannerComponent, MoneyPipe,
    ProductSheetComponent, SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Products</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <!--
        Pull to refresh is reload(), the same restart a publish asks for, and
        it is refused while a 429 window is open for the reason the Try again
        button below is: the gateway has said how long to wait.
      -->
      <ion-refresher slot="fixed" [disabled]="rateLimit.blocked()" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <app-error-banner [error]="error() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

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

      @if (showSkeleton()) {
        <app-skeleton-list />
      }

      @if (isEmpty()) {
        <app-empty-state heading="Nothing published yet"
          message="Pull down to check again for newly published products." />
      }

      <ion-list>
        @for (product of products(); track product.productId) {
          <ion-item>
            @if (product.thumbnailUrl) {
              <ion-thumbnail slot="start">
                <img [src]="product.thumbnailUrl" [alt]="product.name" />
              </ion-thumbnail>
            }

            <!--
              A native button around the label rather than a clickable
              ion-item: the row already holds Add, and a button inside a
              button is neither valid nor reachable by keyboard in an order a
              screen reader can explain.
            -->
            <button type="button" class="open" (click)="open(product)">
              <ion-label>
                <h2>{{ product.name }}</h2>
                <ion-note>{{ product.amount | money: product.currency }}</ion-note>
                @if (stockText(product); as text) {
                  <p class="stock" [class.out]="isOut(product)">{{ text }}</p>
                }
              </ion-label>
            </button>

            <ion-button slot="end" fill="clear" [disabled]="isOut(product)"
              (click)="addToCart(product)">Add</ion-button>
          </ion-item>
        }
      </ion-list>

      @if (reachedEnd()) {
        <p class="end" data-testid="end-of-list">That is everything published so far.</p>
      }

      <ion-infinite-scroll [disabled]="!canLoadMore()" (ionInfinite)="loadMore($event)">
        <ion-infinite-scroll-content></ion-infinite-scroll-content>
      </ion-infinite-scroll>

      <ion-modal [isOpen]="selected() !== null" [initialBreakpoint]="0.75" [breakpoints]="[0, 0.75, 1]"
        (didPresent)="nameSheet($event)" (didDismiss)="close()">
        <ng-template>
          @if (selected(); as product) {
            <app-product-sheet [product]="product" (added)="addFromSheet(product, $event)"
              (closed)="close()" />
          }
        </ng-template>
      </ion-modal>
    </ion-content>
  `,
  styles: `
    .open { all: unset; flex: 1; cursor: pointer; padding: .5rem 0; }
    .open:focus-visible { outline: 2px solid var(--ion-color-primary); }
    .stock { margin: .25rem 0 0; font-size: .875rem; color: var(--ion-color-medium); }
    .stock.out { color: var(--ion-color-danger); }
    .end { text-align: center; color: var(--ion-color-medium); padding: 1rem; }
  `,
})
export class ProductsPage {
  private readonly catalog = inject(CatalogApi);
  private readonly cart = inject(CartStore);
  private readonly catalogRefresh = inject(CatalogRefresh);
  private readonly availability = inject(CatalogAvailability);
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
  /**
   * A request for this generation is in flight. Set by `load()` and cleared
   * only by the response of the generation that is current, so a superseded
   * reply landing late cannot report "done" while the reload that replaced it
   * is still waiting.
   */
  private readonly loadingSignal = signal(false);
  /**
   * The rows on screen belong to a sequence `reload()` discarded, and the
   * first page of the new one has not landed. They stay until it does (#202),
   * so the reply replaces them rather than extending them, and a failed
   * restart keeps them with the error beside them; `retryLoad()` is then
   * still a restart. Cleared only by a first page that lands.
   */
  private readonly restartingSignal = signal(false);
  private readonly selectedSignal = signal<ProductSummary | null>(null);
  /** A publish asked for a refresh inside a blocked window; the listing is stale until it is taken. */
  private readonly refreshHeld = signal(false);

  // Writable only inside this class — CartStore.lines and CommandIdentity's
  // current/isSpent make the same choice, for the same reason: `readonly` on
  // the field stops reassignment, not `.set()` from outside. Nothing holds a
  // reference to this component — the publish page asks for a refresh through
  // CatalogRefresh precisely BECAUSE a feature may not import another feature
  // (spec §3, enforced by the ESLint rule and boundaries.spec.ts) — so the
  // point is not to fend off a caller that exists. It is that `products`,
  // `error` and `hasMore` are what the platform answered, and the only code
  // entitled to say what the platform answered is the code that read the
  // response. `loading` and `selected` are this page's own state — a request
  // it has out, a row it has opened — and are written only here for the same
  // reason.
  readonly products: Signal<readonly ProductSummary[]> = this.productsSignal.asReadonly();
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  readonly hasMore: Signal<boolean> = this.hasMoreSignal.asReadonly();
  readonly loading: Signal<boolean> = this.loadingSignal.asReadonly();
  /** The row whose sheet is open, or null. A row, not an id: the sheet shows what the row holds. */
  readonly selected: Signal<ProductSummary | null> = this.selectedSignal.asReadonly();

  /**
   * Three list states a blank screen used to stand in for, each its own fact.
   * Loading with nothing yet to show is the skeleton; loaded, with no error,
   * no rows and no further page is the platform saying the catalogue is
   * empty; rows and no further page is the end. A failed first page is none
   * of these — the banner and Try again say what happened.
   */
  readonly showSkeleton = computed(
    () => this.loadingSignal() && this.productsSignal().length === 0 && this.errorSignal() === null,
  );
  readonly isEmpty = computed(
    () =>
      !this.loadingSignal() &&
      this.errorSignal() === null &&
      this.productsSignal().length === 0 &&
      !this.hasMoreSignal(),
  );
  readonly reachedEnd = computed(() => !this.hasMoreSignal() && this.productsSignal().length > 0);

  /**
   * Spec §6's 429 row — and the one page whose bucket is NOT the one every
   * other action shares.
   *
   * `GET /api/v1/catalog/**` is the single route the gateway gives its
   * `anonymous` limiter policy, and it does so for everyone: a signed-in
   * customer's listing takes that route too, keyed on their IP rather than on
   * them. It is the tightest budget in the system — a fixed window of 100 a
   * minute with no queue, against 300 a minute for everything else — and the
   * infinite scroll below is what draws on it. Publish POSTs to this exact
   * URL and is limited by the other bucket entirely.
   */
  readonly rateLimit = inject(RateLimitWindows).catalogue;

  /**
   * Whether the infinite scroll may ask for another page on its own.
   *
   * Two independent reasons to stop, deliberately kept apart. `hasMore` is
   * the platform's answer — a null nextCursor, and there is genuinely nothing
   * past it. An error is this attempt's answer, and it is temporary: the
   * scroll stays quiet so it cannot hammer a limiter, and the Try again
   * button above is how the user says otherwise. Clearing the error (which a
   * successful load does) re-arms the scroll at the cursor it left off at.
   *
   * The rate-limit window is a third reason, and it is not covered by the
   * second: since the windows became shared, "a 429 is open on the catalogue
   * bucket" and "this page has an error" are different states — a refusal can
   * arrive on a request this page never made. Without the check, the scroll
   * re-arms and fires straight into a limiter the client already knows is
   * closed, which is precisely the loop the paragraph above says it exists to
   * prevent.
   *
   * A first page in flight is the fourth. `loadMore()` asks for whatever
   * `cursor` holds and bumps no generation, so a scroll while the first page
   * of a cold start, a pull to refresh or a `CatalogRefresh` reload is still
   * out — and the skeleton gives the content something to scroll — would ask
   * for page one again under the same generation, and both replies would be
   * appended. A cold start has no rows yet and a restart keeps the old ones
   * (#202), so the state is "loading with no rows, or restarting". A later
   * page the scroll itself started is not stopped here: Ionic's own
   * `isLoading` already holds the scroll until `complete()`, and disabling it
   * mid-load would clear that flag, hide the spinner and turn `complete()`
   * into a no-op.
   */
  readonly canLoadMore = computed(
    () =>
      this.hasMoreSignal() &&
      this.errorSignal() === null &&
      !this.rateLimit.blocked() &&
      !(this.loadingSignal() && (this.productsSignal().length === 0 || this.restartingSignal())),
  );

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
    //
    // A request that arrives while the catalogue window is open is held, not
    // taken: it would send a request the client already expects to be
    // refused, which reopens the window (#161), as
    // `OrdersPage.ionViewWillEnter()` skips an entry for the same reason. The
    // list stays as it is; the hold is taken by the second effect once the
    // window closes, and `reload()` clears it, so a pull to refresh that
    // gets there first takes it instead of leaving a second reload behind.
    const constructedAtVersion = this.catalogRefresh.current();
    effect(() => {
      if (this.catalogRefresh.current() === constructedAtVersion) return;
      untracked(() => {
        if (this.rateLimit.blocked()) this.refreshHeld.set(true);
        else this.reload();
      });
    });
    effect(() => {
      if (!this.refreshHeld() || this.rateLimit.blocked()) return;
      untracked(() => this.reload());
    });
  }

  /**
   * Restarts the listing from the first page. Reached two ways: the effect
   * above, when a publish elsewhere bumps `CatalogRefresh` (spec §5.5), and
   * `refresh()`, pull to refresh. The rows stay on screen until the first page
   * replaces them (#202).
   */
  reload(done?: () => void): void {
    this.refreshHeld.set(false);
    this.generation++;
    this.cursor = null;
    this.restartingSignal.set(true);
    this.load(done);
  }

  /** Pull to refresh: a reload whose spinner closes when its own response lands. */
  refresh(event?: { target: { complete: () => void } }): void {
    this.reload(() => event?.target.complete());
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
    // Local only. The backend has no cart, so there is nothing to call. An
    // out-of-stock row's button is disabled, and this refuses too, because
    // the binding and the method are two paths to the same store.
    if (this.isOut(product)) return;
    this.cart.add(product);
  }

  open(product: ProductSummary): void {
    this.selectedSignal.set(product);
  }

  close(): void {
    this.selectedSignal.set(null);
  }

  /**
   * Gives the sheet's dialog a name. The `role="dialog"` element is Ionic's
   * `.modal-wrapper`, inside the modal's shadow root, and nothing Ionic
   * exposes labels it: `htmlAttributes` lands on the host, which is not the
   * dialog, and axe (rule `aria-dialog-name`) and a screen reader both read
   * the wrapper. So the label goes on the wrapper itself, once it is drawn.
   */
  nameSheet(event: Event): void {
    const wrapper = (event.target as HTMLElement).shadowRoot?.querySelector('.modal-wrapper');
    wrapper?.setAttribute('aria-label', this.selectedSignal()?.name ?? 'Product details');
  }

  addFromSheet(product: ProductSummary, quantity: number): void {
    if (!this.isOut(product)) this.cart.add(product, quantity);
    this.close();
  }

  isOut(product: ProductSummary): boolean {
    return stockOf(product.quantityAvailable).kind === 'out';
  }

  stockText(product: ProductSummary): string | null {
    return stockLabel(stockOf(product.quantityAvailable));
  }

  private load(done?: () => void): void {
    const generation = this.generation;
    this.loadingSignal.set(true);

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

        this.loadingSignal.set(false);
        this.errorSignal.set(null);
        this.availability.record(page.items);
        this.productsSignal.update((existing) =>
          this.restartingSignal() ? page.items : [...existing, ...page.items],
        );
        this.restartingSignal.set(false);
        this.cursor = page.nextCursor;
        this.hasMoreSignal.set(page.nextCursor !== null);
      },
      error: (failure: HttpErrorResponse) => {
        done?.();
        if (generation !== this.generation) return;

        this.loadingSignal.set(false);

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
