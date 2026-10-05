import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular';
import { PERMISSIONS } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { CartStore } from '@core/cart/cart.store';

/**
 * Spec §5: Products, Cart, Account, plus History, which appears only while
 * signed in, and Publish, which appears only when catalog:write is held. The
 * tab HIDES; the guard on the route refuses; the backend decides. All three,
 * because a hidden button and a refused call are two different facts (spec
 * §4.3).
 */
@Component({
  selector: 'app-tabs',
  standalone: true,
  imports: [IonBadge, IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-tabs>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="products">
          <ion-icon name="grid-outline"></ion-icon>
          <ion-label>Products</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="cart">
          <ion-icon name="cart-outline"></ion-icon>
          <ion-label>Cart</ion-label>
          @if (cartCount() > 0) {
            <ion-badge>{{ cartCount() }}</ion-badge>
          }
        </ion-tab-button>

        @if (signedIn()) {
          <ion-tab-button tab="orders">
            <ion-icon name="receipt-outline"></ion-icon>
            <ion-label>History</ion-label>
          </ion-tab-button>
        }

        @if (canPublish()) {
          <ion-tab-button tab="publish">
            <ion-icon name="cloud-upload-outline"></ion-icon>
            <ion-label>Publish</ion-label>
          </ion-tab-button>
        }

        <ion-tab-button tab="account">
          <ion-icon name="person-outline"></ion-icon>
          <ion-label>Account</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  `,
})
export class TabsPage {
  private readonly auth = inject(AuthService);
  private readonly cart = inject(CartStore);

  protected readonly cartCount = this.cart.count;
  protected readonly canPublish = computed(() => this.auth.hasPermission(PERMISSIONS.catalogWrite));
  /** History needs a session and no permission: the BFF binds the subject from the principal. */
  protected readonly signedIn = computed(() => this.auth.user()() !== null);
}
