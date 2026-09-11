import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PERMISSIONS, PublishProductCommand } from '@core/api/types';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
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
 * added here for that reason — publish.page.spec.ts's "resets the form to
 * invalid so a second click cannot resubmit the same product" assertion is
 * the coverage that would fail if this reasoning were wrong.
 *
 * command.already_committed is handled unlike checkout handles it, and for a
 * reason specific to this page: checkout escapes a spent identity by
 * navigating away — the placed page is a different component, and a later
 * visit to checkout gets a freshly constructed CommandIdentity. This page
 * never navigates and Ionic caches its ComponentRef for the app session, so
 * a spent identity here is not escaped by anything — it is permanent, and
 * the Publish tab would be dead for the rest of the session. The publish DID
 * commit, though: the platform is saying the product exists and it no
 * longer holds the result to hand back an id for. So this branch does what
 * a success does, minus the id.
 *
 * The gateway routes this POST through `catalog-write`, which matches POST
 * and requires authentication, rather than through `catalog-public`, which
 * matches GET alone and is anonymous. Both routes exist
 * (Gateway.Api/appsettings.json); the split is what lets the catalogue be
 * readable by anyone while publishing is not.
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
        @if (id === alreadyCommitted) {
          <ion-item>
            <ion-note>
              The platform reported that this command id had already been applied, and it no
              longer holds the result. The product was published; its id is not recoverable
              from here.
            </ion-note>
          </ion-item>
        } @else {
          <ion-item><ion-note>Published as <code>{{ id }}</code>.</ion-note></ion-item>
        }
      }
    </ion-content>
  `,
})
export class PublishPage {
  private readonly catalog = inject(CatalogApi);
  private readonly catalogRefresh = inject(CatalogRefresh);

  readonly identity = new CommandIdentity();

  /** Read by the template to tell "committed, id unknown" apart from a real id. */
  protected readonly alreadyCommitted = ALREADY_COMMITTED;

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
    // (ngSubmit) is not the only way in — this method is public and directly
    // callable — so the guard the template's [disabled] binding expresses
    // must also live here, the same precedent checkout's placeOrder() sets
    // for its own non-null assertion below. Without this, value.amount!
    // would assert over a null the required validator was supposed to have
    // ruled out.
    if (this.form.invalid) return;

    // Cleared at the START of every attempt, not just on the branches that
    // change it: a "Published as ..." (or already-committed) note from a
    // PRIOR success must not keep sitting under an error banner from THIS
    // attempt, implying the thing that just failed actually succeeded.
    this.publishedId.set(null);

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
      // `unknown`, not HttpErrorResponse: mapError()'s parameter is `unknown`
      // on purpose (see its own comment on the branch that handles a bare
      // string rejection from WebAuthStrategy.signIn(), added for cart.page.ts's
      // sign-in retry) and it re-narrows internally. Annotating this as
      // HttpErrorResponse costs nothing at runtime here because mapError()
      // never trusts the annotation either way — but it is still a claim
      // this call site cannot back, which is reason enough not to make it.
      error: (failure: unknown) => {
        const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
        this.identity.onFailure(displayed);

        if (displayed.kind === 'alreadyCommitted') {
          // The submission committed — the platform is telling us the
          // product exists and it no longer holds the result to hand an id
          // back for. Checkout treats the same code as success-pending-
          // confirmation and moves on because navigating away rebuilds its
          // page with a fresh CommandIdentity; this page has no such escape
          // (see the class doc comment), so it does the equivalent work
          // itself: onSuccess() is the right call here too, because a
          // completed submission — which this is — is exactly what its own
          // doc comment says starts a new form entry.
          this.error.set(null);
          this.publishedId.set(ALREADY_COMMITTED);
          this.identity.onSuccess();
          this.form.reset({ name: '', thumbnailUrl: '', amount: null, currency: '' });
          this.catalogRefresh.request();
          return;
        }

        this.error.set(displayed);
      },
    });
  }
}
