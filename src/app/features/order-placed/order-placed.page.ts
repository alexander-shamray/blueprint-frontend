import {
  ChangeDetectionStrategy, Component, DOCUMENT, DestroyRef, computed, effect, inject, signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, map } from 'rxjs';
import {
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
  IonText, IonTitle, IonToolbar,
} from '@ionic/angular';
import { OrdersApi } from '@core/api/orders.api';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { ALREADY_COMMITTED } from '@core/commands/command-id';
import { ORDER_POLL, isTerminal, nextPollDelay } from '@core/orders/order-poll';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { OrderStatusComponent } from '@shared/order-status.component';

/**
 * Spec §5.4. The order id the platform returned, the buyer status the order
 * read reports for it, and a link to its tracking detail on the History tab,
 * which is where Cancel lives now (#95).
 *
 * The status is polled, because the read is a projection and nothing pushes
 * (#96): at once, then on `ORDER_POLL`'s back-off, stopping on a terminal
 * status, while the page is hidden, and when Ionic says the page is being
 * left. A read straight after placing usually answers 404 — the projection
 * has not absorbed `OrderPlaced` yet, and §10.7 gives an unattributed order
 * the same 404 as an unknown one — so a 404 here is "not recorded yet" and
 * the poll carries on rather than reporting a missing order.
 */
@Component({
  selector: 'app-order-placed',
  standalone: true,
  imports: [
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonNote,
    IonText, IonTitle, IonToolbar, RouterLink, ErrorBannerComponent, OrderStatusComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/cart"></ion-back-button></ion-buttons>
        <ion-title>Order placed</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <!--
        Only a refusal the buyer can act on reaches the banner. A poll is a
        request they did not make, so a 429 on one stretches the interval
        instead (#96), and a failure that will be retried is a note below.
      -->
      <app-error-banner [error]="error()" />

      @if (alreadyCommitted()) {
        <ion-item>
          <ion-label>
            <h2>Already committed</h2>
            <ion-note>
              The platform reported that this command id had already been applied, and it no longer
              holds the result. The order exists, and its id is not recoverable from this page;
              History lists every order this account has placed.
            </ion-note>
          </ion-label>
        </ion-item>

        <ion-button expand="block" fill="outline" routerLink="/tabs/orders">Open History</ion-button>
      } @else if (foreign()) {
        <!--
          The id, its status and its tracking link belong to the buyer who
          placed it, and they are not the one signed in now.
        -->
        <ion-item data-testid="foreign">
          <ion-note>
            This order was placed under another sign-in, so it is not shown here. Sign in as the
            account that placed it to follow it.
          </ion-note>
        </ion-item>
      } @else if (orderId() !== '') {
        <ion-item>
          <ion-label>
            <h2>Order</h2>
            <ion-text><code>{{ orderId() }}</code></ion-text>
          </ion-label>
          @if (status(); as current) {
            <app-order-status slot="end" [status]="current" />
          }
        </ion-item>

        <ion-item>
          <ion-note data-testid="status-note">{{ statusNote() }}</ion-note>
        </ion-item>

        <ion-button expand="block" fill="outline" [routerLink]="['/tabs/orders', orderId()]">
          Track this order
        </ion-button>
      }
    </ion-content>
  `,
})
export class OrderPlacedPage {
  private readonly orders = inject(OrdersApi);
  private readonly route = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);
  private readonly user = inject(AuthService).user();

  /**
   * Reactive, not a one-shot `route.snapshot` read. Angular's default
   * `RouteReuseStrategy` compares only `routeConfig` identity — params are
   * ignored — so navigating `placed/A` -> `placed/B` can hand this component
   * the SAME `ActivatedRoute` instance rather than constructing a fresh one.
   * `app.config.ts` installs `IonicRouteStrategy`, which closes that gap
   * app-wide, but this page does not lean on a fact maintained three files
   * away: `paramMap` keeps emitting on a reused `ActivatedRoute` regardless
   * of which strategy is active, so reading it reactively is correct under
   * either strategy and the page is right on its own terms.
   */
  readonly orderId = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: this.route.snapshot.paramMap.get('id') ?? '' },
  );

  readonly alreadyCommitted = computed(() => this.orderId() === ALREADY_COMMITTED);

  /**
   * The buyer this page is for: whoever was signed in when it was handed its
   * id, since only they could have placed it. Null until somebody is.
   */
  private readonly ownerState = signal<string | null>(null);

  /**
   * Signed in as somebody other than that buyer, or signed out. The page then
   * shows nothing of the order and polls nothing: the id is the first buyer's,
   * and the read would answer anyone else 404 for as long as the page stood,
   * on their own budget. Nobody signed in is foreign even before the page has
   * an owner: a page handed its id while signed out waits for a buyer.
   */
  readonly foreign = computed(() => {
    const owner = this.ownerState();
    const subject = this.user()?.subject ?? null;
    return subject === null || (owner !== null && subject !== owner);
  });

  /** What the order read last said, for `orderId` and no other. */
  private readonly statusState = signal<string | null>(null);
  /** Whether the read has answered 404 and nothing better since. */
  private readonly notRecordedState = signal(false);
  /** A failure the next poll may clear: shown as a note, never as the banner. */
  private readonly transientState = signal(false);
  /** A refusal the poll cannot outwait — a 401 or a 403 — which stops it. */
  private readonly errorState = signal<DisplayError | null>(null);

  readonly status = this.statusState.asReadonly();
  readonly error = this.errorState.asReadonly();

  readonly statusNote = computed(() => {
    const status = this.statusState();
    if (status !== null && isTerminal(status)) return 'This order has reached its last status.';
    if (this.errorState() !== null) return 'The status is not being checked any more.';
    if (this.transientState()) return 'The status could not be read just now; checking again shortly.';
    if (status === null && this.notRecordedState()) {
      return 'The platform has not recorded this order yet. Checking again shortly.';
    }
    if (status === null) return 'Reading the order status…';
    return 'Checking for changes while this page is open.';
  });

  /**
   * Spec §6's 429 row — the gateway's `authenticated` bucket, which every
   * other signed-in action shares. A poll is never sent while it is blocked
   * (#96): the timer waits the window out instead.
   */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Subscription | null = null;
  private delayMs: number = ORDER_POLL.initialMs;
  /** Between Ionic's `ionViewWillEnter` and `ionViewWillLeave`. Construction counts as entering. */
  private entered = true;

  constructor() {
    // Each id this instance is handed starts its own poll from the first
    // interval, having dropped everything the previous id left: a status, a
    // note or a timer belonging to order A must never be shown or fired
    // under order B. The first run is this construction's own id. A new id
    // is a new placement, so it belongs to whoever is signed in now.
    effect(() => {
      this.orderId();
      untracked(() => {
        this.ownerState.set(this.user()?.subject ?? null);
        this.restart();
      });
    });

    // A different subject restarts the poll from nothing, for the reason a
    // different id does: on native this page stands on the Cart tab's stack
    // across a sign-out and somebody else's sign-in, and one buyer's order,
    // status, note or banner must never be shown to the next. The restart
    // polls only for the buyer the page is for (`foreign`), so it is a stop
    // under anyone else and a fresh start when that buyer is back. Compared
    // with the last subject seen, because a subject can come back; the first
    // run is the construction's own and does nothing, since the id effect
    // has started it.
    let lastSeen = untracked(() => this.user()?.subject ?? null);
    effect(() => {
      const subject = this.user()?.subject ?? null;
      if (subject === lastSeen) return;
      lastSeen = subject;
      untracked(() => {
        // Built while nobody was signed in: the first buyer to sign in is
        // the one whose session the page has been waiting for.
        if (this.ownerState() === null) this.ownerState.set(subject);
        this.restart();
      });
    });

    const onVisibility = (): void => {
      if (this.document.visibilityState === 'hidden') this.stop();
      else this.resume();
    };
    this.document.addEventListener('visibilitychange', onVisibility);

    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibility);
      this.stop();
    });
  }

  /**
   * Ionic's own leave hook, and the one #96 asks to be tested as Ionic
   * reports it: this page is pushed on the Cart tab's stack, and switching
   * tabs leaves it standing — undestroyed, so `ngOnDestroy` never fires — while
   * `ionViewWillLeave` does.
   */
  ionViewWillLeave(): void {
    this.entered = false;
    this.stop();
  }

  ionViewWillEnter(): void {
    this.entered = true;
    // A 401 stopped the poll for want of a session. Once one is back the
    // refusal no longer holds, so the poll resumes; a change of subject is
    // the effect's to restart, so this is the same buyer signing in again.
    // A 403 is a refusal a session does not lift, and stays a stop.
    if (this.errorState()?.kind === 'signIn' && this.user() !== null) {
      this.errorState.set(null);
    }
    this.resume();
  }

  private restart(): void {
    this.stop();
    this.statusState.set(null);
    this.notRecordedState.set(false);
    this.transientState.set(false);
    this.errorState.set(null);
    this.delayMs = ORDER_POLL.initialMs;
    this.resume();
  }

  /** Polls now, if this page is in a state to poll at all. Idempotent while one is already pending. */
  private resume(): void {
    if (this.timer !== null || this.inFlight !== null) return;
    if (!this.canPoll()) return;
    this.poll();
  }

  private canPoll(): boolean {
    const status = this.statusState();
    return (
      this.entered &&
      this.document.visibilityState !== 'hidden' &&
      this.orderId() !== '' &&
      !this.alreadyCommitted() &&
      !this.foreign() &&
      this.errorState() === null &&
      !(status !== null && isTerminal(status))
    );
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.unsubscribe();
    this.inFlight = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll();
    }, ms);
  }

  private poll(): void {
    if (!this.canPoll()) return;

    // No request into a window the gateway has closed. Waiting out what is
    // left of it, or the current interval if that is longer, keeps the poll
    // from spending the buyer's own budget on a refusal it already knows.
    if (this.rateLimit.blocked()) {
      this.schedule(Math.max(this.rateLimit.remaining() * 1000, this.delayMs));
      return;
    }

    const issuedForId = this.orderId();

    this.inFlight = this.orders.get(issuedForId).subscribe({
      next: (order) => {
        this.inFlight = null;
        if (this.orderId() !== issuedForId) return;

        this.statusState.set(order.status);
        this.notRecordedState.set(false);
        this.transientState.set(false);
        this.next();
      },
      error: (failure: HttpErrorResponse) => {
        this.inFlight = null;
        if (this.orderId() !== issuedForId) return;

        const displayed = mapError(failure);
        if (displayed.kind === 'signIn' || displayed.kind === 'forbidden') {
          // Nothing a later poll could change on its own: say so and stop.
          // A 401 is lifted on the next entry once a session is back
          // (`ionViewWillEnter`); a 403 is not.
          this.errorState.set(displayed);
          return;
        }

        if (displayed.kind === 'rateLimited') {
          // Stretched, never surfaced: the interceptor has already opened
          // the window, and the next turn waits it out.
          this.delayMs = Math.max(
            ORDER_POLL.maxMs,
            (displayed.retryAfterSeconds ?? 0) * 1000,
          );
        } else if (failure.status === 404) {
          // The latest answer decides the note, and a 404 never stands
          // beside a status an earlier read reported.
          this.statusState.set(null);
          this.notRecordedState.set(true);
          this.transientState.set(false);
        } else {
          this.notRecordedState.set(false);
          this.transientState.set(true);
        }
        this.next();
      },
    });
  }

  /** The wait before the next poll, or none once the status is final. */
  private next(): void {
    if (!this.canPoll()) return;
    const wait = this.delayMs;
    this.delayMs = nextPollDelay(this.delayMs);
    this.schedule(wait);
  }
}
