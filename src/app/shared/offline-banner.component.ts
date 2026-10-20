import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { OnlineStatus } from '@core/network/online-status';

/**
 * Says the device is offline (#99). It is a statement about the network, not
 * about any one screen: what is on screen was loaded earlier, and a price or a
 * stock figure on it may have moved since (spec §9, the client never computes
 * or assumes money). It blocks nothing, because whether a request can be sent
 * is the request's own answer.
 */
@Component({
  selector: 'app-offline-banner',
  standalone: true,
  imports: [IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!status.online()) {
      <div class="offline" role="status" data-testid="offline-banner">
        <ion-icon name="cloud-offline-outline" aria-hidden="true"></ion-icon>
        <span i18n="@@offline.banner">You are offline. What you see was loaded earlier, and prices or stock may have changed.</span>
      </div>
    }
  `,
  styles: `
    .offline {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      padding: 0.5rem 1rem;
      font-size: 0.875rem;
      background: var(--ion-color-warning);
      color: var(--ion-color-warning-contrast);
    }
  `,
})
export class OfflineBannerComponent {
  protected readonly status = inject(OnlineStatus);
}
