import {
  ChangeDetectionStrategy, Component, Signal, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonButton, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel, IonList,
  IonListHeader, IonNote, IonThumbnail,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { OwnProduct, PERMISSIONS } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { EmptyStateComponent } from '@shared/empty-state.component';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { MoneyPipe } from '@shared/money.pipe';
import { SkeletonListComponent } from '@shared/skeleton-list.component';

/**
 * The seller's own products, under the Publish form, and the one action a
 * seller has on a product once it is out: withdrawing it (#107). Read from
 * `GET /v1/catalog/products/mine`, newest first, withdrawn ones included with
 * the time they went, because the seller's list keeps what the public reads
 * hide (backend ADR-074). Both the read and the withdrawal are behind
 * `catalog:write`, the claim the Publish tab is already gated on, so no new
 * permission is asked for anywhere.
 *
 * The list states are `ProductsPage`'s, and so is the reload: a publish or a
 * withdrawal asks `CatalogRefresh`, and this list hears it as the Products tab
 * does. Rows stay on screen until the fresh first page replaces them (#202),
 * so a withdrawal does not blank the list it was made from.
 *
 * A withdrawal is final: nothing undoes one, and a seller who withdrew by
 * mistake publishes again under a new id. So the button asks once more before
 * it sends, and that is the only action in this client that does.
 */
@Component({
  selector: 'app-own-products',
  standalone: true,
  imports: [
    DatePipe, IonButton, IonInfiniteScroll, IonInfiniteScrollContent, IonItem, IonLabel, IonList,
    IonListHeader, IonNote, IonThumbnail, EmptyStateComponent, ErrorBannerComponent, MoneyPipe,
    SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-list-header><h2>Your products</h2></ion-list-header>

    <app-error-banner [error]="actionError() ?? error() ?? rateLimit.refusal()"
      [retryInSeconds]="rateLimit.remaining()" />

    @if (error()) {
      <ion-button expand="block" fill="outline"
        [disabled]="rateLimit.blocked()" (click)="retryLoad()">Try again</ion-button>
    }

    @if (showSkeleton()) {
      <app-skeleton-list />
    }

    @if (isEmpty()) {
      <app-empty-state heading="Nothing published yet" icon="cube-outline"
        message="Products you publish from this account appear here." />
    }

    <ion-list>
      @for (product of products(); track product.productId) {
        <ion-item data-testid="own-product">
          @if (product.thumbnailUrl) {
            <ion-thumbnail slot="start">
              <img [src]="product.thumbnailUrl" [alt]="product.name" />
            </ion-thumbnail>
          }

          <ion-label>
            <h2>{{ product.name }}</h2>
            <ion-note>{{ product.amount | money: product.currency }}</ion-note>
            @if (product.withdrawnAt; as withdrawnAt) {
              <p class="withdrawn" data-testid="withdrawn">Withdrawn {{ withdrawnAt | date: 'medium' }}</p>
            } @else {
              <p>Published {{ product.publishedAt | date: 'medium' }}</p>
            }
          </ion-label>

          @if (!product.withdrawnAt) {
            @if (confirming() === product.productId) {
              <div slot="end" class="confirm" role="group" [attr.aria-label]="'Withdraw ' + product.name">
                @if (isPending(product)) {
                  <ion-note data-testid="withdrawing">Withdrawing…</ion-note>
                } @else {
                  <ion-note>Withdraw for good?</ion-note>
                }
                <ion-button fill="solid" color="danger" data-testid="confirm-withdraw"
                  [disabled]="rateLimit.blocked()" (click)="withdraw(product)">Withdraw</ion-button>
                <ion-button fill="clear" (click)="cancelWithdraw()">Keep</ion-button>
              </div>
            } @else {
              <ion-button slot="end" fill="clear" color="danger" data-testid="withdraw"
                (click)="askToWithdraw(product)">Withdraw</ion-button>
            }
          }
        </ion-item>
      }
    </ion-list>

    @if (reachedEnd()) {
      <p class="end" data-testid="end-of-own-list">That is everything this account has published.</p>
    }

    <ion-infinite-scroll [disabled]="!canLoadMore()" (ionInfinite)="loadMore($event)">
      <ion-infinite-scroll-content></ion-infinite-scroll-content>
    </ion-infinite-scroll>
  `,
  styles: `
    .withdrawn { color: var(--ion-color-medium); }
    .confirm { display: flex; align-items: center; gap: .25rem; }
    .end { text-align: center; color: var(--ion-color-medium); padding: 1rem; }
  `,
})
export class OwnProductsComponent {
  private readonly catalog = inject(CatalogApi);
  private readonly catalogRefresh = inject(CatalogRefresh);
  private readonly auth = inject(AuthService);
  private cursor: string | null = null;

  /** `ProductsPage.generation`'s guard, for the same call sites and the same late reply. */
  private generation = 0;

  /**
   * One id per product, because the id belongs to the action (spec §5.3) and
   * a withdrawal is an action on one product. Held across a failure, so the
   * retry of a withdrawal that may have committed is the same command; a
   * withdrawal that succeeded is never sent again, so its entry goes.
   */
  private readonly identities = new Map<string, CommandIdentity>();

  /** Bumped when the subject changes, so a reply for the last subject lands on nothing. */
  private subjectChanges = 0;

  private readonly productsSignal = signal<readonly OwnProduct[]>([]);
  private readonly errorSignal = signal<DisplayError | null>(null);
  private readonly actionErrorSignal = signal<DisplayError | null>(null);
  /** The platform's "no more pages", kept apart from "this attempt failed" as `ProductsPage` keeps it. */
  private readonly hasMoreSignal = signal(true);
  private readonly loadingSignal = signal(false);
  /** `ProductsPage.restartingSignal`: the rows are a discarded sequence's, kept until page one lands. */
  private readonly restartingSignal = signal(false);
  /** A refresh was asked for inside a blocked window, and is taken once it ends. */
  private readonly refreshHeld = signal(false);
  private readonly confirmingSignal = signal<string | null>(null);
  /** Withdrawals out, per product: a count, since a second press sends a second request. */
  private readonly pendingSignal = signal<ReadonlyMap<string, number>>(new Map());

  readonly products: Signal<readonly OwnProduct[]> = this.productsSignal.asReadonly();
  /** A page of the list failed to load. */
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  /** The last withdrawal was refused, or failed on the way. */
  readonly actionError: Signal<DisplayError | null> = this.actionErrorSignal.asReadonly();
  /** The product whose Withdraw has been pressed once and waits on the second press. */
  readonly confirming: Signal<string | null> = this.confirmingSignal.asReadonly();

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
   * The `authenticated` bucket: `catalog-own` and `catalog-write` both name it,
   * so the list and the withdrawal share it with Publish, the quote and the
   * order calls, and not with the Products tab's anonymous one.
   */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  /** `ProductsPage.canLoadMore`, whose comment argues each of the four conditions. */
  readonly canLoadMore = computed(
    () =>
      this.hasMoreSignal() &&
      this.errorSignal() === null &&
      !this.rateLimit.blocked() &&
      !(this.loadingSignal() && (this.productsSignal().length === 0 || this.restartingSignal())),
  );

  constructor() {
    this.load();

    // `ProductsPage`'s refresh effects, for the same reason: the Publish tab
    // root is cached for the session, so a construction loads once, and a
    // publish or a withdrawal asks for the reload through `CatalogRefresh`.
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

    // A different subject sees nothing of the last one's list, as
    // `OrdersPage` forgets an order history. The Publish page renders this
    // list only while somebody is signed in, so a sign-out destroys it; on
    // native a subject can still change without one, A to B directly.
    const user = this.auth.user();
    let lastSeen = untracked(() => user()?.subject ?? null);
    effect(() => {
      const subject = user()?.subject ?? null;
      if (subject === lastSeen) return;
      lastSeen = subject;
      untracked(() => {
        this.subjectChanges++;
        this.identities.clear();
        this.pendingSignal.set(new Map());
        this.confirmingSignal.set(null);
        this.actionErrorSignal.set(null);
        this.productsSignal.set([]);
        this.errorSignal.set(null);
        this.hasMoreSignal.set(true);
        if (subject !== null) this.reload();
        else this.generation++;
      });
    });
  }

  /** Restarts from the first page, keeping the rows until it lands (#202). */
  reload(done?: () => void): void {
    this.refreshHeld.set(false);
    this.generation++;
    this.cursor = null;
    this.restartingSignal.set(true);
    this.load(done);
  }

  loadMore(event?: { target: { complete: () => void } }): void {
    this.load(() => event?.target.complete());
  }

  /** Resumes at the page that failed, as `ProductsPage.retryLoad()` does. */
  retryLoad(): void {
    this.generation++;
    this.load();
  }

  isPending(product: OwnProduct): boolean {
    return (this.pendingSignal().get(product.productId) ?? 0) > 0;
  }

  askToWithdraw(product: OwnProduct): void {
    this.actionErrorSignal.set(null);
    this.confirmingSignal.set(product.productId);
  }

  cancelWithdraw(): void {
    this.confirmingSignal.set(null);
  }

  /**
   * The second press. Refused here as well as by the binding, as
   * `PublishPage.publish()` refuses an invalid form: a product already
   * withdrawn, or a window the gateway has said is closed.
   *
   * Not refused while a withdrawal of the same product is out, which is
   * `client-architecture.md` §4's non-guard: this request carries a command
   * id, so a second press is a replay the platform answers with
   * `request.in_progress`, and suppressing that would hide the mechanism.
   * `OrderDetailPage.cancel()` guards because its body carries no id; this one
   * does. The pending state is shown, not enforced.
   */
  withdraw(product: OwnProduct): void {
    if (product.withdrawnAt !== null || this.rateLimit.blocked()) return;

    const identity = this.identityFor(product.productId);
    const changesAtIssue = this.subjectChanges;
    this.setPending(product.productId, true);
    this.actionErrorSignal.set(null);

    this.catalog.withdraw(product.productId, { commandId: identity.current() }).subscribe({
      next: () => {
        if (this.subjectChanges !== changesAtIssue) return;
        this.setPending(product.productId, false);
        this.withdrawn(product.productId);
      },
      error: (failure: unknown) => {
        if (this.subjectChanges !== changesAtIssue) return;
        this.setPending(product.productId, false);
        const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
        identity.onFailure(displayed);

        // Both say this id's withdrawal was applied before, and the body is
        // the id alone, so there is no edited request it could have been:
        // the product is withdrawn, and the list is told so by reading it.
        if (displayed.kind === 'alreadyCommitted' || displayed.kind === 'idReused') {
          this.withdrawn(product.productId);
          return;
        }

        this.actionErrorSignal.set(displayed);

        // 422 `product.withdrawn` is a withdrawal made from somewhere else, and
        // 404 `product.not_found` a product this account no longer owns: in
        // both the row on screen is stale, so the list is read again and the
        // banner says why. Neither touches the Products tab, which had already
        // stopped listing a withdrawn product.
        if (displayed.kind === 'rule' || (failure instanceof HttpErrorResponse && failure.status === 404)) {
          this.confirmingSignal.set(null);
          this.reload();
        }
      },
    });
  }

  /**
   * The withdrawal landed. The Products tab drops the product, through the
   * refresh a publish already asks for, and this list hears the same request
   * and reads the row back with its `withdrawnAt`: the time is the server's,
   * so the client does not stamp one of its own.
   */
  private withdrawn(productId: string): void {
    this.identities.delete(productId);
    this.confirmingSignal.set(null);
    // A second press's `request.in_progress` may have landed first; the
    // withdrawal it was waiting on is the answer that counts.
    this.actionErrorSignal.set(null);
    this.catalogRefresh.request();
  }

  private identityFor(productId: string): CommandIdentity {
    let identity = this.identities.get(productId);
    if (!identity) {
      identity = new CommandIdentity();
      this.identities.set(productId, identity);
    }
    return identity;
  }

  private setPending(productId: string, pending: boolean): void {
    this.pendingSignal.update((current) => {
      const next = new Map(current);
      const count = Math.max(0, (next.get(productId) ?? 0) + (pending ? 1 : -1));
      if (count === 0) next.delete(productId);
      else next.set(productId, count);
      return next;
    });
  }

  private load(done?: () => void): void {
    const generation = this.generation;
    this.loadingSignal.set(true);

    this.catalog.mine(this.cursor).subscribe({
      next: (page) => {
        // The scroll's own `isLoading` must clear even for a stale reply;
        // `ProductsPage.load()` says why.
        done?.();
        if (generation !== this.generation) return;

        this.loadingSignal.set(false);
        this.errorSignal.set(null);
        this.productsSignal.update((existing) =>
          this.restartingSignal() ? page.items : [...existing, ...page.items],
        );
        this.restartingSignal.set(false);
        this.cursor = page.nextCursor;
        this.hasMoreSignal.set(page.nextCursor !== null);
      },
      error: (failure: unknown) => {
        done?.();
        if (generation !== this.generation) return;

        this.loadingSignal.set(false);
        this.errorSignal.set(mapError(failure, { permission: PERMISSIONS.catalogWrite }));
      },
    });
  }
}
