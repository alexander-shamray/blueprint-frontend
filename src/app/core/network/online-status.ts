import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/**
 * Whether the browser believes it has a network (#99).
 *
 * `navigator.onLine` is a hint and only one way: `false` is reliable, `true`
 * means a network interface is up and nothing more, so a captive portal or a
 * dead gateway reads as online. That is the right strength for what this
 * drives, which is a banner saying that what is on screen was loaded earlier.
 * It never decides whether a request is sent: the request is sent and its
 * failure is the platform's answer, mapped by the error mapper as any other.
 */
@Injectable({ providedIn: 'root' })
export class OnlineStatus {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly state = signal(this.win?.navigator.onLine ?? true);

  readonly online = this.state.asReadonly();

  constructor() {
    const win = this.win;
    if (!win) return;
    const up = () => this.state.set(true);
    const down = () => this.state.set(false);
    win.addEventListener('online', up);
    win.addEventListener('offline', down);
    inject(DestroyRef).onDestroy(() => {
      win.removeEventListener('online', up);
      win.removeEventListener('offline', down);
    });
  }
}
