import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IonItem, IonLabel, IonList, IonSkeletonText, IonThumbnail } from '@ionic/angular';

/**
 * Placeholder rows for any paged list whose first page has not arrived; the
 * product listing is the one that has such a page today. The cart does not
 * use it, since its lines are local and never wait on the network.
 *
 * `aria-busy` on the list and nothing for a screen reader to read inside it:
 * a row of grey bars announced one by one is noise, and the busy state is the
 * fact worth stating.
 */
@Component({
  selector: 'app-skeleton-list',
  standalone: true,
  imports: [IonItem, IonLabel, IonList, IonSkeletonText, IonThumbnail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-list aria-busy="true" data-testid="skeleton-list">
      @for (row of indexes(); track row) {
        <ion-item aria-hidden="true">
          <ion-thumbnail slot="start"><ion-skeleton-text [animated]="true"></ion-skeleton-text></ion-thumbnail>
          <ion-label>
            <h2><ion-skeleton-text [animated]="true" style="width: 60%"></ion-skeleton-text></h2>
            <p><ion-skeleton-text [animated]="true" style="width: 30%"></ion-skeleton-text></p>
          </ion-label>
        </ion-item>
      }
    </ion-list>
  `,
})
export class SkeletonListComponent {
  readonly rows = input(6);

  protected readonly indexes = computed(() => Array.from({ length: this.rows() }, (_, i) => i));
}
