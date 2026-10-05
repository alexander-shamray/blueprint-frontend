import {
  ChangeDetectionStrategy, Component, Signal, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import {
  IonButton, IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent, IonItem,
  IonLabel, IonList, IonRefresher, IonRefresherContent, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrdersApi } from '@core/api/orders.api';
import { OrderSummary } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { EmptyStateComponent } from '@shared/empty-state.component';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { OrderStatusComponent } from '@shared/order-status.component';
import { SkeletonListComponent } from '@shared/skeleton-list.component';

/**
 * Spec §5.7. The History tab: the signed-in buyer's own orders, newest first
 * as the BFF pages them, over `GET /bff/v1/orders`. A tab rather than a
 * section of Account (decided 2026-09-20, #94): History is the screen a buyer
 * returns to, and Account the one they visit once.
 *
 * It is a tab root, so Ionic constructs it once per session and never tears
 * it down (`client-architecture.md` §12). Two things follow, and each has its
 * own mechanism here rather than leaning on navigation:
 *
 * - **It reloads on every entry**, from `ionViewWillEnter`. An order placed
 *   on the Cart tab, or cancelled on a detail page pushed from here, would
 *   otherwise not appear until a restart. Products answers the same fact with
 *   `CatalogRefresh`, because only a publish changes the catalogue; here a
 *   placement, a cancellation and the platform's own progress all do, and
 *   the last has no caller to ask for a refresh. So arriving is the trigger,
 *   except into an open rate-limit window, which `ionViewWillEnter` says.
 * - **It forgets on a change of subject.** A cached page that signed-out A
 *   left would otherwise show A's history to B until B pulled to refresh.
 */
@Component({
  selector: 'app-orders',
  standalone: true,
  imports: [
    DatePipe, IonButton, IonContent, IonHeader, IonInfiniteScroll, IonInfiniteScrollContent,
    IonItem, IonLabel, IonList, IonRefresher, IonRefresherContent, IonTitle, IonToolbar,
    RouterLink, EmptyStateComponent, ErrorBannerComponent, MoneyPipe, OrderStatusComponent,
    SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>History</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <ion-refresher slot="fixed" [disabled]="rateLimit.blocked()" (ionRefresh)="refresh($event)">
        <ion-refresher-content></ion-refresher-content>
      </ion-refresher>

      <app-error-banner [error]="error() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

      @if (error() || unread()) {
        <ion-button expand="block" fill="outline"
          [disabled]="rateLimit.blocked()" (click)="retryLoad()">Try again</ion-button>
      }

      @if (showSkeleton()) {
        <app-skeleton-list />
      }

      @if (isEmpty()) {
        <app-empty-state heading="No orders yet" icon="receipt-outline"
          message="Orders you place from the cart appear here." />
      }

      <ion-list>
        @for (order of orders(); track order.orderId) {
          <ion-item [routerLink]="['/tabs/orders', order.orderId]" [detail]="true"
            data-testid="order-row">
            <ion-label>
              <h2>{{ headline(order) }}</h2>
              <p>
                @if (order.total; as total) {
                  {{ total.amount | money: total.currency }}
                } @else {
                  Not priced yet
                }
                @if (order.timeline.placed; as placed) {
                  · {{ placed | date: 'medium' }}
                }
              </p>
            </ion-label>
            <app-order-status slot="end" [status]="order.status" />
          </ion-item>
        }
      </ion-list>

      @if (reachedEnd()) {
        <p class="end" data-testid="end-of-list">That is every order on this account.</p>
      }

      <ion-infinite-scroll [disabled]="!canLoadMore()" (ionInfinite)="loadMore($event)">
        <ion-infinite-scroll-content></ion-infinite-scroll-content>
      </ion-infinite-scroll>
    </ion-content>
  `,
  styles: `
    .end { text-align: center; color: var(--ion-color-medium); padding: 1rem; }
  `,
})
export class OrdersPage {
  private readonly ordersApi = inject(OrdersApi);
  private readonly auth = inject(AuthService);
  private cursor: string | null = null;

  /** `ProductsPage.generation`'s guard, for the same three call sites and the same late reply. */
  private generation = 0;

  private readonly ordersSignal = signal<readonly OrderSummary[]>([]);
  private readonly errorSignal = signal<DisplayError | null>(null);
  /** The platform's "no more pages", kept apart from "this attempt failed" as `ProductsPage` keeps it. */
  private readonly hasMoreSignal = signal(true);
  private readonly loadingSignal = signal(false);
  /** An entry fell inside a blocked window and read nothing; the next load clears it. */
  private readonly skippedSignal = signal(false);

  readonly orders:Signal<readonly OrderSummary[]> = this.ordersSignal.asReadonly();
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  readonly loading: Signal<boolean> = this.loadingSignal.asReadonly();

  readonly showSkeleton = computed(
    () => this.loadingSignal() && this.ordersSignal().length === 0 && this.errorSignal() === null,
  );
  readonly isEmpty = computed(
    () =>
      !this.loadingSignal() &&
      this.errorSignal() === null &&
      this.ordersSignal().length === 0 &&
      !this.hasMoreSignal(),
  );
  readonly reachedEnd = computed(() => !this.hasMoreSignal() && this.ordersSignal().length > 0);

  /**
   * Nothing has been read, because an entry was skipped into a blocked window:
   * no rows, no error, no skeleton and no empty state, so without this the
   * page would be blank with nothing to press once the window ends.
   */
  readonly unread = computed(
    () =>
      this.skippedSignal() &&
      this.ordersSignal().length === 0 &&
      !this.loadingSignal() &&
      this.errorSignal() === null &&
      this.hasMoreSignal(),
  );

  /** The gateway's `authenticated` bucket: `/bff/**` draws on it, as quote and checkout do. */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  /** `ProductsPage.canLoadMore`, whose comment argues each of the four conditions. */
  readonly canLoadMore = computed(
    () =>
      this.hasMoreSignal() &&
      this.errorSignal() === null &&
      !this.rateLimit.blocked() &&
      !(this.loadingSignal() && this.ordersSignal().length === 0),
  );

  constructor() {
    // A different subject — a sign-out, or a sign-out and somebody else's
    // sign-in — empties the list before anything else can render it. The
    // comparison is with the last subject seen, not with the one this page
    // was built for: a subject can come back — A, then B, then A again, which
    // on native need not pass through a sign-out — and the return has to
    // clear B's list too. The first run sees this construction's own subject,
    // and nothing has loaded yet, so it does nothing.
    const user = this.auth.user();
    let lastSeen = untracked(() => user()?.subject ?? null);
    effect(() => {
      const subject = user()?.subject ?? null;
      if (subject === lastSeen) return;
      lastSeen = subject;
      untracked(() => this.clear());
    });
  }

  /**
   * Ionic's own entry hook: every arrival at the tab, including the first.
   * Not while the `authenticated` window is open: the read would go into a
   * limiter the gateway has said is refusing, and clearing first would take
   * away the list the buyer could still see. The banner says why; pull to
   * refresh and Try again come back when the window ends.
   */
  ionViewWillEnter(): void {
    if (this.rateLimit.blocked()) {
      this.skippedSignal.set(true);
      return;
    }
    this.reload();
  }

  reload(done?: () => void): void {
    this.clear();
    this.load(done);
  }

  refresh(event?: { target: { complete: () => void } }): void {
    this.reload(() => event?.target.complete());
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  /** Resumes at the page that failed, as `ProductsPage.retryLoad()` does. */
  retryLoad(): void {
    this.generation++;
    this.load();
  }

  /**
   * What a row is called. The product names the BFF resolved, joined; a line
   * whose name never resolved (§10.7's nullable `productName`) is named as
   * that rather than dropped, and an order with no priced lines yet says so.
   */
  headline(order: OrderSummary): string {
    if (order.lines.length === 0) return 'Order details not recorded yet';
    return order.lines.map((line) => line.productName ?? 'Unnamed product').join(', ');
  }

  private clear(): void {
    this.generation++;
    this.cursor = null;
    this.ordersSignal.set([]);
    this.errorSignal.set(null);
    this.hasMoreSignal.set(true);
    this.loadingSignal.set(false);
  }

  private load(done?: () => void): void {
    const generation = this.generation;
    this.skippedSignal.set(false);
    this.loadingSignal.set(true);

    this.ordersApi.list(this.cursor).subscribe({
      next: (page) => {
        done?.();
        if (generation !== this.generation) return;

        this.loadingSignal.set(false);
        this.errorSignal.set(null);
        this.ordersSignal.update((existing) => [...existing, ...page.items]);
        this.cursor = page.nextCursor;
        this.hasMoreSignal.set(page.nextCursor !== null);
      },
      error: (failure: HttpErrorResponse) => {
        done?.();
        if (generation !== this.generation) return;

        this.loadingSignal.set(false);
        this.errorSignal.set(mapError(failure));
      },
    });
  }
}
