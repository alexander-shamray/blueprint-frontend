import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { filter } from 'rxjs';
import { OnlineStatus } from '@core/network/online-status';

/** The only destination a waiting shell is taken at: the products tab, with or without a query. */
export const SHELL_TAKEN_AT = /^\/tabs\/products\/?(\?[^#]*)?(#.*)?$/;

/**
 * How a new shell replaces the one a user is running (#99,
 * `docs/client-architecture.md` §16).
 *
 * The worker keeps serving the shell it installed until the page is loaded
 * again, so left alone a tab opened last week keeps calling the API shape it
 * was built against after the backend has moved on, which is this client's
 * version of drift. The strategy is to take the new shell when the user next
 * goes to the products tab, not at once and not on a prompt:
 *
 * - Not at once, and not at just any navigation, because loading the page
 *   again discards everything held only in memory: the checkout's quote
 *   (`CheckoutHandoff`, whose guard sends a reloaded app back to the cart), a
 *   publish form not yet sent, and any other page Ionic's tab stack is
 *   keeping alive. The cart is the one thing that survives, by design. The
 *   products tab is where the user starts browsing again, and its listing is
 *   fetched afresh anyway, so it is the one destination that costs nothing.
 * - Not on a prompt, because a banner asking for permission to be current is
 *   one more thing to ignore, and an ignored one is the stale shell again.
 *
 * It is an allow-list for the reason a deny-list of "screens holding state"
 * would rot: a page added next month that holds a handoff is protected by
 * default, and is taken the next time the user lands on products.
 *
 * So `VERSION_READY` only records that a newer shell is waiting, and the next
 * `NavigationStart` to the products tab activates it and loads that address
 * fresh. It also asks for an update when the connection returns, since a
 * browser that was offline for a day has not heard of the release it missed.
 *
 * Without a worker (development, native, a browser that has none)
 * `SwUpdate.isEnabled` is false and this does nothing.
 */
@Injectable({ providedIn: 'root' })
export class ShellUpdates {
  private readonly updates = inject(SwUpdate);
  private readonly router = inject(Router);
  private readonly location = inject(DOCUMENT).location;
  private readonly online = inject(OnlineStatus);
  private newerShellWaiting = false;

  constructor() {
    if (!this.updates.isEnabled) return;
    const destroyed = inject(DestroyRef);

    const ready = this.updates.versionUpdates
      .pipe(filter((event) => event.type === 'VERSION_READY'))
      .subscribe(() => (this.newerShellWaiting = true));

    const navigating = this.router.events
      .pipe(filter((event): event is NavigationStart => event instanceof NavigationStart))
      .subscribe((event) => {
        if (!this.newerShellWaiting || !SHELL_TAKEN_AT.test(event.url)) return;
        this.newerShellWaiting = false;
        void this.updates
          .activateUpdate()
          .then(() => this.location.assign(event.url))
          .catch(() => undefined);
      });

    // Runs once at start and again each time the connection returns.
    effect(() => {
      if (!this.online.online()) return;
      untracked(() => void this.updates.checkForUpdate().catch(() => undefined));
    });

    destroyed.onDestroy(() => {
      ready.unsubscribe();
      navigating.unsubscribe();
    });
  }
}
