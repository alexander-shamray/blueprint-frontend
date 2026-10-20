import {
  ChangeDetectionStrategy, Component, Signal, WritableSignal, computed, effect, inject, signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonInfiniteScroll, IonInfiniteScrollContent, IonInput, IonItem, IonLabel, IonList,
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

/** `Amount`'s messages from a 400, apart from the keys no control here owns. */
function splitAmountErrors(fields: Readonly<Record<string, readonly string[]>> | undefined): {
  readonly amount: readonly string[];
  readonly rest: Readonly<Record<string, readonly string[]>>;
} {
  const rest: Record<string, readonly string[]> = {};
  let amount: readonly string[] = [];
  for (const [key, messages] of Object.entries(fields ?? {})) {
    if (key.toLowerCase() === 'amount') amount = [...amount, ...messages];
    else rest[key] = messages;
  }
  return { amount, rest };
}

/**
 * The seller's own products, under the Publish form, and the two actions a
 * seller has on a product once it is out: repricing it (#176) and withdrawing
 * it (#107). Read from
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
    DatePipe, IonButton, IonInfiniteScroll, IonInfiniteScrollContent, IonInput, IonItem, IonLabel,
    IonList, IonListHeader, IonNote, IonThumbnail, ReactiveFormsModule, EmptyStateComponent,
    ErrorBannerComponent, MoneyPipe, SkeletonListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-list-header><h2 i18n="@@own.title">Your products</h2></ion-list-header>

    <app-error-banner [error]="actionError() ?? error() ?? rateLimit.refusal()"
      [retryInSeconds]="rateLimit.remaining()" />

    @if (error()) {
      <ion-button expand="block" fill="outline"
        [disabled]="rateLimit.blocked()" (click)="retryLoad()" i18n="@@action.tryAgain">Try again</ion-button>
    }

    @if (showSkeleton()) {
      <app-skeleton-list />
    }

    @if (isEmpty()) {
      <app-empty-state heading="Nothing published yet" i18n-heading="@@products.emptyHeading"
        icon="cube-outline" message="Products you publish from this account appear here."
        i18n-message="@@own.emptyMessage" />
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
              <p class="withdrawn" data-testid="withdrawn" i18n="@@own.withdrawn">Withdrawn {{ withdrawnAt | date: 'medium' }}</p>
            } @else {
              <p i18n="@@own.published">Published {{ product.publishedAt | date: 'medium' }}</p>
            }
          </ion-label>

          @if (!product.withdrawnAt) {
            @if (pricing() === product.productId) {
              <!--
                The new price, in the currency the product already has: a price
                cannot change currency (product.currency_fixed), so there is no
                picker, and the amount goes out as typed.
              -->
              <div slot="end" class="reprice" role="group" [attr.aria-label]="repriceLabel(product.name)">
                <ion-input type="number" inputmode="decimal" [formControl]="priceControl"
                  [autofocus]="true" [label]="newPriceLabel(product.currency)"
                  data-testid="price-input"></ion-input>
                @for (message of priceMessages(); track $index) {
                  <ion-note class="field-error" color="danger" data-field="amount"
                    role="alert">{{ message }}</ion-note>
                }
                @if (isRepricing(product)) {
                  <ion-note data-testid="repricing" role="status" i18n="@@own.saving">Saving…</ion-note>
                }
                <ion-button fill="solid" data-testid="confirm-reprice"
                  [disabled]="priceControl.invalid || rateLimit.blocked()"
                  (click)="reprice(product)" i18n="@@own.save">Save</ion-button>
                <ion-button fill="clear" data-testid="cancel-reprice" (click)="cancelReprice()"
                  i18n="@@own.cancel">Cancel</ion-button>
              </div>
            } @else if (confirming() === product.productId) {
              <div slot="end" class="confirm" role="group" [attr.aria-label]="withdrawLabel(product.name)">
                @if (isPending(product)) {
                  <ion-note data-testid="withdrawing" i18n="@@own.withdrawing">Withdrawing…</ion-note>
                } @else {
                  <ion-note i18n="@@own.confirm">Withdraw for good?</ion-note>
                }
                <ion-button fill="solid" color="danger" data-testid="confirm-withdraw"
                  [disabled]="rateLimit.blocked()" (click)="withdraw(product)"
                  i18n="@@own.withdraw">Withdraw</ion-button>
                <ion-button fill="clear" (click)="cancelWithdraw()" i18n="@@own.keep">Keep</ion-button>
              </div>
            } @else {
              <ion-button slot="end" fill="clear" data-testid="reprice"
                (click)="askToReprice(product)"
                i18n="@@own.reprice">Reprice</ion-button>
              <ion-button slot="end" fill="clear" color="danger" data-testid="withdraw"
                (click)="askToWithdraw(product)"
                i18n="@@own.withdraw">Withdraw</ion-button>
            }
          }
        </ion-item>
      }
    </ion-list>

    @if (reachedEnd()) {
      <p class="end" data-testid="end-of-own-list" i18n="@@own.end">
        That is everything this account has published.
      </p>
    }

    <ion-infinite-scroll [disabled]="!canLoadMore()" (ionInfinite)="loadMore($event)">
      <ion-infinite-scroll-content></ion-infinite-scroll-content>
    </ion-infinite-scroll>
  `,
  styles: `
    .withdrawn { color: var(--ion-color-medium); }
    .confirm { display: flex; align-items: center; gap: .25rem; }
    .reprice { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem; }
    .field-error { display: block; font-size: .875rem; }
    .end { text-align: center; color: var(--ion-color-medium); padding: 1rem; }
  `,
})
export class OwnProductsComponent {
  /** The reprice group's accessible name, which says which product it prices. */
  protected repriceLabel(name: string): string {
    return $localize`:@@own.repriceGroup:Reprice ${name}:name:`;
  }

  /** The new-price field's label, which carries the currency the product is fixed to. */
  protected newPriceLabel(currency: string): string {
    return $localize`:@@own.newPrice:New price in ${currency}:currency:`;
  }

  /** The withdraw group's accessible name. */
  protected withdrawLabel(name: string): string {
    return $localize`:@@own.withdrawGroup:Withdraw ${name}:name:`;
  }

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

  /**
   * The products whose withdrawal has had its one replay after a sign-in, as
   * `OrderDetailPage.replayedAfterSignIn` bounds a cancel: a 401 answered by a
   * sign-in answered by another 401 is a loop, not a replay.
   */
  private readonly replayedAfterSignIn = new Set<string>();

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

  /** The product whose price is being typed, if any: one editor at a time. */
  private readonly pricingSignal = signal<string | null>(null);
  /** Reprice requests out, per product: a count, since a second press sends a second request. */
  private readonly repricingSignal = signal<ReadonlyMap<string, number>>(new Map());
  /**
   * A 400's messages for the amount, which sit under the field and leave the
   * banner. Held with the product they are about: the field is shared by the
   * rows, and a late answer for one must not appear under another's editor.
   */
  private readonly priceMessagesSignal = signal<{
    readonly productId: string;
    readonly messages: readonly string[];
  } | null>(null);
  /**
   * One id per product's reprice, apart from its withdrawal's: they are two
   * commands, and the backend keys each on its own operation. Held across a
   * failure that may have committed; gone after a success.
   */
  private readonly priceIdentities = new Map<string, CommandIdentity>();

  /**
   * The new price. `Validators.required` and no more: it accepts `0`, which is
   * a price (client-architecture §12, "A product may cost nothing"), and the
   * rest of the rules are the backend's, answered per field.
   */
  readonly priceControl = new FormControl<number | null>(null, { validators: Validators.required });

  readonly products: Signal<readonly OwnProduct[]> = this.productsSignal.asReadonly();
  /** A page of the list failed to load. */
  readonly error: Signal<DisplayError | null> = this.errorSignal.asReadonly();
  /** The last withdrawal was refused, or failed on the way. */
  readonly actionError: Signal<DisplayError | null> = this.actionErrorSignal.asReadonly();
  /** The product whose Withdraw has been pressed once and waits on the second press. */
  readonly confirming: Signal<string | null> = this.confirmingSignal.asReadonly();
  /** The product whose price is open for typing. */
  readonly pricing: Signal<string | null> = this.pricingSignal.asReadonly();
  /** The amount's messages for the open editor, and only for it. */
  readonly priceMessages = computed<readonly string[]>(() => {
    const held = this.priceMessagesSignal();
    return held !== null && held.productId === this.pricingSignal() ? held.messages : [];
  });

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

    // An edit after a validation failure releases the id, as the order form's
    // does; after any other failure the id is held (`CommandIdentity.onEdit`).
    // The messages were about the value that was sent, so they go with it.
    this.priceControl.valueChanges.subscribe(() => {
      const productId = this.pricingSignal();
      if (productId !== null) {
        this.priceIdentities.get(productId)?.onEdit();
        this.clearPriceMessages(productId);
      }
    });

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
        this.priceIdentities.clear();
        this.replayedAfterSignIn.clear();
        this.pendingSignal.set(new Map());
        this.repricingSignal.set(new Map());
        this.pricingSignal.set(null);
        this.priceMessagesSignal.set(null);
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
    this.cancelReprice();
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

        // Spec §6's 401 row, as `OrderDetailPage.cancel()` answers it: refused
        // at the edge, so nothing was withdrawn, and the same command sent
        // again after a sign-in is the first one arriving with a token.
        if (displayed.kind === 'signIn') {
          this.signInAndReplay(`withdraw:${product.productId}`, () => this.withdraw(product));
          return;
        }

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
    this.replayedAfterSignIn.delete(`withdraw:${productId}`);
    this.confirmingSignal.set(null);
    // A second press's `request.in_progress` may have landed first; the
    // withdrawal it was waiting on is the answer that counts.
    this.actionErrorSignal.set(null);
    this.catalogRefresh.request();
  }

  /**
   * Re-authenticate, then send the same withdrawal again, once, and only while
   * the subject that was refused is the one signed in: under anybody else the
   * same command id is a different command, and they never pressed Withdraw.
   * On the web the replay is unreachable, since `signIn()` is a redirect this
   * page does not survive (spec §4.1); the native strategy returns with the
   * page still standing.
   */
  private signInAndReplay(key: string, resend: () => void): void {
    const replay = !this.replayedAfterSignIn.has(key);
    const refusedSubject = this.auth.user()()?.subject ?? null;
    const changesAtRefusal = this.subjectChanges;

    this.auth.signIn().then(
      () => {
        const sameSubject =
          refusedSubject !== null &&
          this.auth.user()()?.subject === refusedSubject &&
          this.subjectChanges === changesAtRefusal;
        if (replay && sameSubject) {
          this.replayedAfterSignIn.add(key);
          resend();
        }
      },
      // `unknown`: signIn() can reject with a bare string (see CartPage.getQuote()).
      (failure: unknown) => this.actionErrorSignal.set(mapError(failure)),
    );
  }

  /** Opens the price for typing, with the product's own price in it. */
  askToReprice(product: OwnProduct): void {
    this.actionErrorSignal.set(null);
    this.confirmingSignal.set(null);
    this.priceMessagesSignal.set(null);
    this.pricingSignal.set(product.productId);
    // Without the event: seeding the field is not an edit of it.
    this.priceControl.setValue(product.amount, { emitEvent: false });
  }

  cancelReprice(): void {
    this.pricingSignal.set(null);
    this.priceMessagesSignal.set(null);
  }

  /** Whether a reprice of this product is out. */
  isRepricing(product: OwnProduct): boolean {
    return (this.repricingSignal().get(product.productId) ?? 0) > 0;
  }

  /**
   * Sends the typed amount and the product's own currency, under an id that
   * belongs to this product's reprice. Refused here as well as by the binding:
   * a product already withdrawn, a blank or invalid field, a closed window.
   * Not refused while one is out, for the reason `withdraw()` gives: the body
   * carries the id, so a second press is a replay the platform answers.
   *
   * The amount is the number as typed (client-architecture §9): the client
   * rounds nothing, and the currency's rules and the bound are the backend's.
   */
  reprice(product: OwnProduct): void {
    const amount = this.priceControl.value;
    if (this.priceControl.invalid || amount === null) return;
    this.sendReprice(product, amount);
  }

  /**
   * The send, with the amount given. A replay after a sign-in goes through
   * here with the amount it was refused with, because the field is shared by
   * the rows and the seller may have opened another by the time the sign-in
   * returns: re-reading it would send that row's amount under this row's id.
   */
  private sendReprice(product: OwnProduct, amount: number): void {
    if (product.withdrawnAt !== null || this.rateLimit.blocked()) return;

    const identity = this.priceIdentityFor(product.productId);
    const changesAtIssue = this.subjectChanges;
    this.adjustCount(this.repricingSignal, product.productId, +1);
    this.actionErrorSignal.set(null);
    this.clearPriceMessages(product.productId);

    this.catalog
      .changePrice(product.productId, {
        commandId: identity.current(),
        amount,
        currency: product.currency,
      })
      .subscribe({
        next: () => {
          if (this.subjectChanges !== changesAtIssue) return;
          this.adjustCount(this.repricingSignal, product.productId, -1);
          this.repriced(product.productId);
        },
        error: (failure: unknown) => {
          if (this.subjectChanges !== changesAtIssue) return;
          this.adjustCount(this.repricingSignal, product.productId, -1);
          const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
          identity.onFailure(displayed);

          // This id's reprice was applied before, so the price is the new one
          // and the list is told so by reading it.
          if (displayed.kind === 'alreadyCommitted') {
            this.repriced(product.productId);
            return;
          }

          // command.id_reused: the first reprice under this id committed, and
          // THIS one, which differs from it (the amount edited since), did not.
          // The price on the row is the first one's; the banner says so and the
          // list is read again to show it.
          if (displayed.kind === 'idReused') {
            this.finishPricing(product.productId);
            this.actionErrorSignal.set(displayed);
            this.reload();
            return;
          }

          if (displayed.kind === 'validation') {
            const { amount: messages, rest } = splitAmountErrors(displayed.fields);
            this.priceMessagesSignal.set({ productId: product.productId, messages });
            this.actionErrorSignal.set({
              ...displayed,
              fields: Object.keys(rest).length > 0 ? rest : undefined,
            });
            return;
          }

          this.actionErrorSignal.set(displayed);

          // Spec §6's 401 row, as a withdrawal answers it.
          if (displayed.kind === 'signIn') {
            this.signInAndReplay(`price:${product.productId}`, () =>
              this.sendReprice(product, amount),
            );
            return;
          }

          // 422 (`product.withdrawn`, `product.currency_fixed`) and 404 (a
          // product this account no longer owns): the row on screen is stale,
          // so the editor closes, the list is read again and the banner says why.
          if (
            displayed.kind === 'rule' ||
            (failure instanceof HttpErrorResponse && failure.status === 404)
          ) {
            this.finishPricing(product.productId);
            this.reload();
          }
        },
      });
  }

  /**
   * The new price landed. The Products tab shows it through the refresh a
   * publish already asks for, and this list hears the same request and reads
   * the row back: the price on screen is the server's, never the typed one.
   * A cart that already holds the product keeps its listed price until the next
   * quote, which is the only price the client trusts (client-architecture §8).
   */
  private repriced(productId: string): void {
    this.finishPricing(productId);
    this.actionErrorSignal.set(null);
    this.catalogRefresh.request();
  }

  private finishPricing(productId: string): void {
    this.priceIdentities.delete(productId);
    this.replayedAfterSignIn.delete(`price:${productId}`);
    if (this.pricingSignal() === productId) this.pricingSignal.set(null);
    this.clearPriceMessages(productId);
  }

  /** Clears the amount's messages if they are this product's, and leaves another row's alone. */
  private clearPriceMessages(productId: string): void {
    if (this.priceMessagesSignal()?.productId === productId) this.priceMessagesSignal.set(null);
  }

  private priceIdentityFor(productId: string): CommandIdentity {
    let identity = this.priceIdentities.get(productId);
    if (!identity) {
      identity = new CommandIdentity();
      this.priceIdentities.set(productId, identity);
    }
    return identity;
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
    this.adjustCount(this.pendingSignal, productId, pending ? 1 : -1);
  }

  /** Moves one product's count of requests out by a step, and drops the entry at zero. */
  private adjustCount(
    counts: WritableSignal<ReadonlyMap<string, number>>,
    productId: string,
    step: 1 | -1,
  ): void {
    counts.update((current) => {
      const next = new Map(current);
      const count = Math.max(0, (next.get(productId) ?? 0) + step);
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
