import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError } from './error-mapper';

/**
 * What a page binds to. Three signals and no way to open or close anything:
 * a page renders a window, it does not decide one is open — the gateway does
 * that, and `rateLimitInterceptor` is what hears it.
 */
export interface RateLimitView {
  /** Seconds left in the window; 0 when no window is open. */
  readonly remaining: Signal<number>;
  /**
   * True while the platform has told this client to wait. Pages bind it into
   * the action's `[disabled]`, so the refusal the gateway already made is not
   * one the customer has to discover by being refused again.
   */
  readonly blocked: Signal<boolean>;
  /**
   * The refusal that opened the window, so a page with no failure of its own
   * can still say why its action is dead — `[error]="error() ?? rateLimit.refusal()"`.
   * Null whenever no window is open.
   */
  readonly refusal: Signal<DisplayError | null>;
}

/**
 * Spec §6's 429 row: "`Retry-After` parsed, the action disabled for that long
 * with a countdown."
 *
 * `error-mapper.ts` does the parsing; this does the other two thirds. The
 * banner used to render `retryAfterSeconds` once and never touch it again, so
 * "Retry in 60s" still said 60 a minute later, and nothing stopped the user
 * from tapping straight back into the limiter in the meantime.
 *
 * One instance per gateway limiter partition, held by `RateLimitWindows` —
 * NOT one per page, which is what this replaced. The predecessor was a page
 * field (`new RetryCountdown(this.error)`) watching that page's error signal,
 * and the mismatch was structural: four pages meant four independent
 * countdowns over one shared bucket, so a 429 on Cart disabled Get quote and
 * left Publish, the catalogue and everything else drawing on a bucket that
 * was already empty. A window per partition is the shape the platform
 * actually has.
 *
 * Driven imperatively rather than by an `effect` over an error signal, which
 * is also a simplification: the effect had to be wrapped in `untracked` so
 * that its own tick could not restart the window it was counting. There is no
 * such hazard when the only writer is an HTTP response.
 */
export class RateLimitWindow implements RateLimitView {
  private readonly refusalState = signal<DisplayError | null>(null);
  private readonly remainingState = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly remaining: Signal<number> = this.remainingState.asReadonly();
  readonly refusal: Signal<DisplayError | null> = this.refusalState.asReadonly();
  readonly blocked = computed(() => this.remainingState() > 0);

  constructor(destroyRef: DestroyRef) {
    // These live for the life of the app rather than of a page, so the leak
    // this guards against is smaller than it was — but an interval writing to
    // a signal after the injector is gone is still a defect, and this app is
    // zoneless, so nothing else would ever notice it.
    destroyRef.onDestroy(() => this.close());
  }

  /**
   * A fresh refusal restarts the window; the platform's latest word on how
   * long to wait replaces its previous one rather than letting the first
   * one's remainder stand.
   */
  open(refusal: DisplayError): void {
    this.stop();

    const seconds = Math.max(0, Math.ceil(refusal.retryAfterSeconds ?? 0));
    this.remainingState.set(seconds);

    if (seconds === 0) {
      this.refusalState.set(null);
      return;
    }

    this.refusalState.set(refusal);
    this.timer = setInterval(() => {
      const left = this.remainingState() - 1;
      this.remainingState.set(Math.max(0, left));
      if (left <= 0) this.close();
    }, 1000);
  }

  /** Ends the window now: something has got through the limiter. */
  close(): void {
    this.stop();
    this.remainingState.set(0);
    this.refusalState.set(null);
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * One window per limiter partition the gateway actually has, and no more.
 *
 * `Gateway.Api/Program.cs` runs two policies: `authenticated` is a token
 * bucket keyed on the subject claim — one bucket per user, 300 tokens a
 * minute, shared by quote, order, cancel, publish and any catalogue read that
 * carried a bearer — and the anonymous policy is a fixed window keyed on IP
 * with its own budget. Two buckets, two keys, so two windows. Modelling them
 * as one would disable the catalogue for a signed-out visitor because a
 * signed-in one was refused; modelling them per page, as this client did
 * until now, models neither.
 */
@Injectable({ providedIn: 'root' })
export class RateLimitWindows {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  /** Quote, order, cancel, publish — and any read made while signed in. */
  readonly authenticated = new RateLimitWindow(this.destroyRef);
  /** The catalogue, read by a visitor who has not signed in. */
  readonly anonymous = new RateLimitWindow(this.destroyRef);

  /**
   * The window a catalogue read will land in, which is a fact about the
   * SESSION rather than about the route: the listing is anonymous at the
   * endpoint, but `authInterceptor` attaches the bearer to every gateway
   * request once there is one, so a signed-in customer's listing is
   * partitioned by their subject like everything else they do. Products binds
   * this; the four authenticated actions bind `authenticated` directly,
   * because they are behind a sign-in either way.
   */
  readonly catalogue: RateLimitView = {
    remaining: computed(() => this.forCatalogue().remaining()),
    blocked: computed(() => this.forCatalogue().blocked()),
    refusal: computed(() => this.forCatalogue().refusal()),
  };

  /**
   * Which window a refusal belongs in, decided the way the gateway decided
   * it: by whether the request carried a bearer.
   */
  forRequest(carriedBearer: boolean): RateLimitWindow {
    return carriedBearer ? this.authenticated : this.anonymous;
  }

  private forCatalogue(): RateLimitWindow {
    return this.auth.user()() ? this.authenticated : this.anonymous;
  }
}
