import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PERMISSIONS, PublishProductCommand } from '@core/api/types';
import { CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/**
 * Spec §5.5, with the same command-id lifecycle as checkout — the backend
 * treats both commands identically, so the client must too.
 *
 * On success it asks CatalogRefresh for a catalogue reload rather than
 * navigating to the products tab and hoping the visit refreshes it — Ionic
 * caches that page, so a visit is not a construction and a construction is
 * the only thing that loads.
 *
 * Unlike checkout, this page never navigates away on success, and it reads
 * no external signal analogous to CheckoutHandoff.quote() in its template or
 * in publish(). Checkout's null-quote guard exists because router.navigate()
 * is async: between handoff.clear() and the navigation resolving, the still-
 * mounted page could see isSpent() cleared and the form still valid while
 * currency() asserted a quote that was already gone. Here the entire success
 * handler — onSuccess() (which clears isSpent()) and form.reset() (which
 * makes the form invalid again, since name/amount/currency are all
 * required) — runs synchronously in one callback with no navigation and no
 * `await` in between, and zoneless CD only re-renders after that callback
 * returns. So there is no tick in which a user could click while the button
 * is enabled but the state behind it is gone: by the time anything repaints,
 * the button is already disabled again (form.invalid is true). No guard is
 * added here for that reason — see publish.page.spec.ts for the coverage
 * that would fail if this reasoning were wrong.
 *
 * The gateway routes this POST only once plan Task 0 has landed;
 * `catalog-public` matches GET alone. Until then a real call answers 404 at
 * the edge, which the banner shows as sent.
 */
@Component({
  selector: 'app-publish',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
    ReactiveFormsModule, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Publish</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      <form [formGroup]="form" (ngSubmit)="publish()">
        <ion-item><ion-input label="Name" formControlName="name" required></ion-input></ion-item>
        <ion-item><ion-input label="Thumbnail URL" formControlName="thumbnailUrl"></ion-input></ion-item>
        <ion-item>
          <ion-input label="Amount" type="number" formControlName="amount" required></ion-input>
        </ion-item>
        <ion-item><ion-input label="Currency" formControlName="currency" required></ion-input></ion-item>

        <ion-button expand="block" type="submit" [disabled]="form.invalid || identity.isSpent()">
          Publish
        </ion-button>
      </form>

      @if (publishedId(); as id) {
        <ion-item><ion-note>Published as <code>{{ id }}</code>.</ion-note></ion-item>
      }
    </ion-content>
  `,
})
export class PublishPage {
  private readonly catalog = inject(CatalogApi);
  private readonly catalogRefresh = inject(CatalogRefresh);

  readonly identity = new CommandIdentity();

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    thumbnailUrl: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: Validators.required }),
    currency: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  readonly error = signal<DisplayError | null>(null);
  readonly publishedId = signal<string | null>(null);

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());
  }

  publish(): void {
    const value = this.form.getRawValue();

    const command: PublishProductCommand = {
      commandId: this.identity.current(),
      name: value.name,
      thumbnailUrl: value.thumbnailUrl.trim() === '' ? null : value.thumbnailUrl,
      // The form's required validator guarantees a number here. Sending null
      // would be met with the backend's own NotNull, keyed `Amount` — correct,
      // and still a client bug.
      amount: value.amount!,
      currency: value.currency,
    };

    this.catalog.publish(command).subscribe({
      next: (productId) => {
        this.error.set(null);
        this.publishedId.set(productId);
        this.identity.onSuccess();
        this.form.reset({ name: '', thumbnailUrl: '', amount: null, currency: '' });

        // "On success the products tab refreshes from the first page"
        // (spec §5.5). Navigation cannot deliver that: Ionic caches a tab's
        // page in its stack and hands back the SAME ComponentRef on
        // re-entry (StackController.getExistingView, via
        // IonRouterOutlet.activateWith), so ProductsPage's constructor runs
        // once per app session and a second visit re-shows the first
        // visit's list. Asking explicitly is the only thing that works, and
        // it is why CatalogRefresh exists.
        //
        // And we stay here rather than navigating: the spec asks for a
        // refreshed tab, not a redirect. Staying keeps the returned id in
        // front of the person who just published, keeps a second publish
        // one form away, and avoids leaving a stale "Published as ..." note
        // sitting on this cached page for the user's next visit.
        this.catalogRefresh.request();
      },
      error: (failure: HttpErrorResponse) => {
        const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
        this.error.set(displayed);
        this.identity.onFailure(displayed);
      },
    });
  }
}
