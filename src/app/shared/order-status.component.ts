import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IonChip, IonLabel } from '@ionic/angular';
import { BuyerStatus } from '@core/api/types';

/**
 * The words for §10.7's buyer statuses. The BFF computes the status and this
 * only names it: there is no saga state here and no client-side derivation,
 * and a status the BFF's vocabulary lacks is an ask of the backend rather
 * than a row to add.
 */
const LABELS: Readonly<Record<BuyerStatus, string>> = {
  placed: 'Placed',
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  out_of_stock: 'Out of stock',
  declined: 'Payment declined',
};

/**
 * The unhappy endings are endings, not errors (#95): an order that ended in
 * "payment declined" finished, so none of them is drawn in the danger colour
 * the error banner owns.
 */
const COLOURS: Readonly<Record<BuyerStatus, string>> = {
  placed: 'medium',
  confirmed: 'primary',
  dispatched: 'tertiary',
  delivered: 'success',
  cancelled: 'medium',
  out_of_stock: 'warning',
  declined: 'warning',
};

/**
 * Own keys only, for the reason `mapError()` gives for its 409 table: a plain
 * index answers `constructor` with what an object literal inherits. A member
 * outside the closed set is rendered as sent — the contract says it cannot
 * happen, and the screen says what arrived rather than guessing what it meant.
 */
export function statusLabel(status: string): string {
  return Object.hasOwn(LABELS, status) ? LABELS[status as BuyerStatus] : status;
}

function statusColour(status: string): string {
  return Object.hasOwn(COLOURS, status) ? COLOURS[status as BuyerStatus] : 'medium';
}

/** One buyer status as a chip, shared by the History list, the tracking detail and Order placed. */
@Component({
  selector: 'app-order-status',
  standalone: true,
  imports: [IonChip, IonLabel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-chip [color]="colour()" [outline]="true" data-testid="order-status">
      <ion-label>{{ label() }}</ion-label>
    </ion-chip>
  `,
})
export class OrderStatusComponent {
  readonly status = input.required<string>();

  protected readonly label = computed(() => statusLabel(this.status()));
  protected readonly colour = computed(() => statusColour(this.status()));
}
