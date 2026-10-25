import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject } from '@angular/core';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { PERMISSIONS } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CartStore } from '@core/cart/cart.store';
import { AssistantEntryComponent } from '@features/assistant/assistant-entry.component';
import { OfflineBannerComponent } from '@shared/offline-banner.component';
import { focusPageHeading } from './focus-page-heading';

/**
 * Spec §5: Products, Cart, Account, plus History, which appears only while
 * signed in, and Publish, which appears only when catalog:write is held. The
 * tab HIDES; the guard on the route refuses; the backend decides. All three,
 * because a hidden button and a refused call are two different facts (spec
 * §4.3). The assistant's entry point sits over every tab while the BFF has it
 * on and a customer is signed in (spec §5.8).
 */
@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [
    AssistantEntryComponent,
    IonBadge,
    IonIcon,
    IonLabel,
    IonTabBar,
    IonTabButton,
    IonTabs,
    OfflineBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-tabs>
      <!-- Above every tab's page, from the shell: the network is not one screen's fact (#99). -->
      <app-offline-banner slot="top" />

      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="products">
          <ion-icon name="grid-outline" aria-hidden="true"></ion-icon>
          <ion-label i18n="@@tab.products">Products</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="cart">
          <ion-icon name="cart-outline" aria-hidden="true"></ion-icon>
          <ion-label i18n="@@tab.cart">Cart</ion-label>
          @if (cartCount() > 0) {
            <ion-badge>{{ cartCount() }}</ion-badge>
          }
        </ion-tab-button>

        @if (signedIn()) {
          <ion-tab-button tab="orders">
            <ion-icon name="receipt-outline" aria-hidden="true"></ion-icon>
            <ion-label i18n="@@tab.history">History</ion-label>
          </ion-tab-button>
        }

        @if (canPublish()) {
          <ion-tab-button tab="publish">
            <ion-icon name="cloud-upload-outline" aria-hidden="true"></ion-icon>
            <ion-label i18n="@@tab.publish">Publish</ion-label>
          </ion-tab-button>
        }

        <ion-tab-button tab="account">
          <ion-icon name="person-outline" aria-hidden="true"></ion-icon>
          <ion-label i18n="@@tab.account">Account</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>

    <!-- Over every tab, from the shell, and nothing at all while the BFF says
         the assistant is off or nobody is signed in (#326). -->
    <app-assistant-entry />
  `,
})
export class TabsPage {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);

  protected readonly cartCount = this.cart.count;
  protected readonly canPublish = computed(() => this.auth.hasPermission(PERMISSIONS.catalogWrite));
  /** History needs a session and no permission: the BFF binds the subject from the principal. */
  protected readonly signedIn = computed(() => this.auth.user()() !== null);

  /**
   * The first entry is the page the app opened on: nothing was activated to
   * get there, and taking focus on load would also pull it off a field the
   * user had already reached.
   */
  private opened = false;

  constructor() {
    // The shell owns this because every page is entered through it, and a page
    // that managed its own focus would be one more thing a new page forgets.
    //
    // Captured, because Ionic dispatches `ionViewDidEnter` with `bubbles:
    // false` (`lifecycle()` in @ionic/core): a bubble-phase listener on the
    // document, which `host: { '(document:…)' }` is, never hears it.
    const entered = (event: Event) => this.enteredPage(event);
    document.addEventListener('ionViewDidEnter', entered, { capture: true });
    inject(DestroyRef).onDestroy(() =>
      document.removeEventListener('ionViewDidEnter', entered, { capture: true }),
    );
  }

  private enteredPage(event: Event): void {
    if (!this.opened) {
      this.opened = true;
      return;
    }
    focusPageHeading(event);
  }
}
