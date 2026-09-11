import { DestroyRef, Signal, computed, effect, inject, signal, untracked } from '@angular/core';
import { DisplayError } from './error-mapper';

/**
 * Spec §6's 429 row: "`Retry-After` parsed, the action disabled for that long
 * with a countdown."
 *
 * `error-mapper.ts` does the parsing; this does the other two thirds. The
 * banner used to render `retryAfterSeconds` once and never touch it again, so
 * "Retry in 60s" still said 60 a minute later, and nothing stopped the user
 * from tapping straight back into the limiter in the meantime.
 *
 * Owned by the PAGE, not by the banner, for two reasons. The action that has
 * to be disabled — Get quote, Place order, Publish, Cancel order, Try again —
 * belongs to the page, and the number on screen and the disabled button must
 * come from one clock: two independent intervals started from the same error
 * would drift apart, and the banner could say "you may retry now" while the
 * button was still dead. The banner therefore renders what it is handed
 * (`retryInSeconds`) rather than counting for itself.
 *
 * Construct it in an injection context — a component field initialiser, the
 * same place `new CommandIdentity()` is built. It needs one for `effect()`
 * and for the `DestroyRef` that stops the interval: a timer that outlives the
 * page it was started for is its own defect, and this app is zoneless, so the
 * interval must WRITE a signal rather than expect change detection to notice
 * that a number in a class field moved.
 */
export class RetryCountdown {
  private readonly remainingState = signal(0);
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Seconds left in the window; 0 when no window is open. */
  readonly remaining: Signal<number> = this.remainingState.asReadonly();

  /**
   * True while the platform has told this client to wait. Pages bind it into
   * the action's `[disabled]`, so the refusal the gateway already made is not
   * one the customer has to discover by being refused again.
   */
  readonly blocked = computed(() => this.remainingState() > 0);

  constructor(error: Signal<DisplayError | null>) {
    effect(() => {
      const current = error();
      // `untracked` is not needed to READ here — nothing in start() reads a
      // signal this effect should depend on — but the write is what matters:
      // this effect must re-run when the ERROR changes and never because its
      // own countdown ticked, or every tick would restart the window.
      untracked(() => this.start(current));
    });

    // A 429 on a page the user navigates away from would otherwise leave an
    // interval running for the life of the app, writing to a signal nothing
    // reads. Ionic keeps tab pages mounted for the session, so this fires
    // less often than it looks — which is exactly why forgetting it would go
    // unnoticed.
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * A fresh 429 restarts the window; anything else — a different failure, or
   * the error clearing on a success — ends it. `mapError` builds a new object
   * per response, so a second 429 restarts the countdown rather than letting
   * the first one's remainder stand, which is right: the second refusal is
   * the platform's latest word on how long to wait.
   */
  private start(error: DisplayError | null): void {
    this.stop();

    const seconds =
      error?.kind === 'rateLimited' ? Math.max(0, Math.ceil(error.retryAfterSeconds ?? 0)) : 0;

    this.remainingState.set(seconds);
    if (seconds === 0) return;

    this.timer = setInterval(() => {
      const left = this.remainingState() - 1;
      this.remainingState.set(Math.max(0, left));
      if (left <= 0) this.stop();
    }, 1000);
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
