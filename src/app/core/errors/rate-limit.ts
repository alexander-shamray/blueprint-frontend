import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { DisplayError } from './error-mapper';

/**
 * What a page binds to. Three signals and no way to open or close anything:
 * a page renders a window, it does not decide one is open — the gateway does
 * that, and `rateLimitInterceptor` is what hears it. The two fields on
 * `RateLimitWindows` are typed as this for that reason, so the distinction is
 * enforced rather than merely stated.
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
 * One instance per gateway limiter policy, held by `RateLimitWindows` — NOT
 * one per page, which is what this replaced. The predecessor was a page field
 * (`new RetryCountdown(this.error)`) watching that page's error signal, and
 * the mismatch was structural: five pages meant five independent countdowns
 * over two shared buckets, so a 429 on Cart disabled Get quote and left
 * Publish, the catalogue and everything else drawing on a bucket that was
 * already empty.
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

  /**
   * When the window ends, in wall-clock terms. The countdown is computed from
   * this on every tick rather than decremented by one, because a tick is not
   * a second: a backgrounded browser tab throttles timers to roughly one a
   * minute, and a suspended Capacitor WebView stops them altogether. Counting
   * ticks there means a customer coming back to the app after a minute away
   * sees 29 seconds left of a window that expired while they were gone, with
   * the buttons still dead. That matters more now than it did for the
   * per-page countdown this replaced, because these windows outlive the page
   * and the app is a native shell where suspension is ordinary.
   */
  private deadline = 0;

  /**
   * Bumped by every refusal. `close(epoch)` carries the value its caller saw
   * before its request went out, which is what stops a slow success from
   * closing a window a newer refusal opened while it was in flight — see
   * `close`.
   */
  private epochCounter = 0;

  readonly remaining: Signal<number> = this.remainingState.asReadonly();
  readonly refusal: Signal<DisplayError | null> = this.refusalState.asReadonly();
  readonly blocked = computed(() => this.remainingState() > 0);

  get epoch(): number {
    return this.epochCounter;
  }

  constructor(destroyRef: DestroyRef) {
    // These live for the life of the app rather than of a page, so the leak
    // this guards against is larger than it was, not smaller: an interval
    // writing to a signal after its injector is gone, in a zoneless app where
    // nothing else would ever notice it.
    destroyRef.onDestroy(() => this.close());
  }

  /**
   * A fresh refusal restarts the window: the platform's latest word on how
   * long to wait replaces its previous one rather than letting the first
   * one's remainder stand.
   */
  open(refusal: DisplayError): void {
    this.stop();
    this.epochCounter++;

    const seconds = Math.max(0, Math.ceil(refusal.retryAfterSeconds ?? 0));
    this.remainingState.set(seconds);

    if (seconds === 0) {
      // `Retry-After: 0` means retry now, so there is no window and nothing
      // to explain. The consequence worth naming: a page whose own `error()`
      // is null shows no banner for this refusal at all, which is right —
      // there is no wait to describe, and the page that made the request
      // still has its own mapped error to render.
      this.deadline = 0;
      this.refusalState.set(null);
      return;
    }

    this.deadline = Date.now() + seconds * 1000;
    this.refusalState.set(refusal);
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /**
   * Ends the window now: something has got through the limiter.
   *
   * `epoch` is the value the caller read before its own request went out.
   * Without it a request that was already in flight when a refusal arrived
   * could land afterwards and cancel a window it knows nothing about — A is
   * admitted, B is refused and opens the window, A's 200 arrives last and
   * closes it. Self-correcting, since the next attempt is simply refused
   * again, but it is the same shape as the interleaving bugs #8 catalogues,
   * and one comparison removes it. Omitted, the close is unconditional, which
   * is what a caller holding no epoch — the destroy hook, a test — means.
   */
  close(epoch?: number): void {
    if (epoch !== undefined && epoch !== this.epochCounter) return;

    this.stop();
    this.deadline = 0;
    this.remainingState.set(0);
    this.refusalState.set(null);
  }

  private tick(): void {
    const left = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
    this.remainingState.set(left);
    if (left <= 0) this.close();
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Which of the gateway's two limiter policies a request will be judged by. */
export type RateLimitPartition = 'catalogue' | 'authenticated';

/**
 * One window per limiter policy the gateway actually has, and no more.
 *
 * `Gateway.Api/appsettings.json` assigns a `RateLimiterPolicy` per YARP
 * route, and `Program.cs` defines the two it names. The `anonymous` policy is
 * a fixed window of 100 a minute keyed on the remote IP, with no queue, and
 * exactly one route takes it: `catalog-public`, `GET /api/v1/catalog/**`. The
 * `authenticated` policy is a token bucket of 300 a minute with a queue of
 * ten, keyed on the subject claim and falling back to the IP when there is no
 * signed-in user, and it covers everything else this client calls — publish,
 * quote, order and cancel.
 *
 * So the split is by ROUTE, not by who is calling. `catalogue` is named for
 * what it governs rather than for the gateway's policy name, because
 * "anonymous" is misleading from this side: a signed-in customer's listing
 * takes that route too, and is limited by that bucket, keyed on their IP
 * rather than on them. Modelling the split by bearer instead — which this did
 * briefly — files a signed-in catalogue refusal against the ordering bucket,
 * which is both the tightest budget in the system reported as the loosest and
 * the two windows collapsing into one.
 */
@Injectable({ providedIn: 'root' })
export class RateLimitWindows {
  private readonly destroyRef = inject(DestroyRef);

  private readonly windows: Readonly<Record<RateLimitPartition, RateLimitWindow>> = {
    catalogue: new RateLimitWindow(this.destroyRef),
    authenticated: new RateLimitWindow(this.destroyRef),
  };

  /** The public catalogue listing: 100 a minute, per IP. Products binds this. */
  readonly catalogue: RateLimitView = this.windows.catalogue;
  /** Quote, order, cancel and publish: 300 a minute, per subject. */
  readonly authenticated: RateLimitView = this.windows.authenticated;

  /**
   * The window to open or close for a request in this partition. Returns the
   * mutable `RateLimitWindow`, which is why the two fields above do not: only
   * `rateLimitInterceptor` reaches this, and a page holding a window it could
   * open itself would make `RateLimitView`'s contract a comment.
   */
  forPartition(partition: RateLimitPartition): RateLimitWindow {
    return this.windows[partition];
  }
}
