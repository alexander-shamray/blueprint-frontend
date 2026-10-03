import {
  ChangeDetectionStrategy, Component, computed, input, output, signal,
} from '@angular/core';
import {
  IonButton, IonButtons, IonContent, IonHeader, IonNote, IonText, IonTitle, IonToolbar,
} from '@ionic/angular';
import { ProductSummary } from '@core/api/types';
import { MoneyPipe } from '@shared/money.pipe';
import { stockLabel, stockOf } from './stock';

/**
 * Product detail, as a sheet over the summary row the listing already holds
 * (spec §10, amended). It shows nothing the row did not carry — there is no
 * `GET` for one product, so a larger image, the same price and the same stock
 * are all a detail can be until Catalog serves one. It is not a route for the
 * same reason: a deep link would have to fetch a product the platform cannot
 * return by id.
 *
 * The stepper floors at one and has no ceiling, for the reason `CartPage`'s
 * own stepper gives — a client-side limit is a copy of the platform's that
 * drifts. Asking for more than a positive listed level is warned about and
 * not refused: the level is Catalog's projection, the reservation is
 * Inventory's, and only the second is a verdict. A level of zero or below is
 * out of stock, and there Add to cart is disabled, as it is on the listing's
 * row (docs/client-architecture.md §12, "The listing carries stock, and null
 * is not none").
 */
@Component({
  selector: 'app-product-sheet',
  standalone: true,
  imports: [
    IonButton, IonButtons, IonContent, IonHeader, IonNote, IonText, IonTitle, IonToolbar,
    MoneyPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>{{ product().name }}</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="closed.emit()">Close</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      @if (product().thumbnailUrl; as url) {
        <img class="hero" [src]="url" [alt]="product().name" />
      }

      <ion-text><h2 data-testid="sheet-price">{{ product().amount | money: product().currency }}</h2></ion-text>

      @if (label(); as text) {
        <ion-note data-testid="sheet-stock" [color]="stock().kind === 'out' ? 'danger' : 'medium'">
          {{ text }}
        </ion-note>
      }

      <div class="stepper">
        <ion-button fill="outline" [disabled]="quantity() <= 1" (click)="step(-1)">−</ion-button>
        <span data-testid="sheet-quantity" aria-live="polite">{{ quantity() }}</span>
        <ion-button fill="outline" (click)="step(1)">+</ion-button>
      </div>

      @if (exceeds()) {
        <ion-note color="warning" data-testid="sheet-exceeds">
          More than the {{ product().quantityAvailable }} listed. Inventory decides at checkout.
        </ion-note>
      }

      <ion-button expand="block" [disabled]="stock().kind === 'out'" (click)="added.emit(quantity())">
        Add to cart
      </ion-button>
    </ion-content>
  `,
  styles: `
    .hero { display: block; width: 100%; max-height: 50vh; object-fit: contain; }
    .stepper { display: flex; align-items: center; gap: 1rem; margin: 1rem 0; }
  `,
})
export class ProductSheetComponent {
  readonly product = input.required<ProductSummary>();
  readonly added = output<number>();
  readonly closed = output<void>();

  private readonly quantityState = signal(1);

  readonly quantity = this.quantityState.asReadonly();
  protected readonly stock = computed(() => stockOf(this.product().quantityAvailable));
  protected readonly label = computed(() => stockLabel(this.stock()));

  protected readonly exceeds = computed(() => {
    const available = this.product().quantityAvailable;
    return available !== null && available > 0 && this.quantity() > available;
  });

  step(by: number): void {
    this.quantityState.update((n) => Math.max(1, n + by));
  }
}
