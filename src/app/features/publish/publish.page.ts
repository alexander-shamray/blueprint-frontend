import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonContent, IonHeader, IonInput, IonItem, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { CatalogApi } from '@core/api/catalog.api';
import { AuthService } from '@core/auth/auth.service';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PERMISSIONS, PublishProductCommand } from '@core/api/types';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
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
      <app-error-banner [error]="error() ?? rateLimit.refusal()" [retryInSeconds]="rateLimit.remaining()" />

      <form [formGroup]="form" (ngSubmit)="publish()">
        <ion-item><ion-input label="Name" formControlName="name" required></ion-input></ion-item>
        <ion-item><ion-input label="Thumbnail URL" formControlName="thumbnailUrl"></ion-input></ion-item>
        <ion-item>
          <ion-input label="Amount" type="number" formControlName="amount" required></ion-input>
        </ion-item>
        <ion-item><ion-input label="Currency" formControlName="currency" required></ion-input></ion-item>

        <!--
          rateLimit.blocked() joins the other two refusals: the gateway has
          said how long to wait and the banner above is counting it down
          (spec §6).
        -->
        <ion-button expand="block" type="submit"
          [disabled]="form.invalid || identity.isSpent() || rateLimit.blocked()">
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
  private readonly auth = inject(AuthService);

  readonly identity = new CommandIdentity();

  /** Read by the template to tell "committed, id unknown" apart from a real id. */
  protected readonly alreadyCommitted = ALREADY_COMMITTED;

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    thumbnailUrl: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: Validators.required }),
    currency: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });

  // Private-writable, public `asReadonly()` — the convention `CartStore.lines`,
  // `CommandIdentity.current`, `CatalogRefresh.current` and `CheckoutHandoff.quote`
  // all state: `readonly` on the field stops reassignment, not `.set()` from
  // outside. `publishedId` is the stronger case of the two — it is this page's
  // claim that the platform accepted a publish, and a writer anywhere else
  // could put "Published as ..." on screen for a product that does not exist.
  private readonly errorState = signal<DisplayError | null>(null);
  private readonly publishedIdState = signal<string | null>(null);

  readonly error = this.errorState.asReadonly();
  readonly publishedId = this.publishedIdState.asReadonly();

  /**
   * Spec §6's 429 row — the gateway's authenticated bucket, shared with Get
   * quote, Place order and Cancel order. This is the page the issue's worked
   * example ends on: a 429 from Get quote used to leave Publish enabled
   * against a bucket the client already knew was empty, and the second
   * refusal was the customer's first hint.
   */
  readonly rateLimit = inject(RateLimitWindows).authenticated;

  /**
   * One automatic replay per successful round trip — the same bound
   * CheckoutPage sets, for the same reason: a 401 answered by a sign-in
   * that is answered by another 401 is a loop, not a replay.
   */
  private replayedAfterSignIn = false;

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
    this.publishedIdState.set(null);

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
        this.replayedAfterSignIn = false;
        this.errorState.set(null);
        this.publishedIdState.set(productId);
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
          this.errorState.set(null);
          this.publishedIdState.set(ALREADY_COMMITTED);
          this.identity.onSuccess();
          this.form.reset({ name: '', thumbnailUrl: '', amount: null, currency: '' });
          this.catalogRefresh.request();
          return;
        }

        this.errorState.set(displayed);

        // Spec §6's 401 row. What this page replays is THIS publish, under
        // the commandId it already holds: `identity.onFailure()` mints
        // nothing for a signIn kind and the form is untouched in between, so
        // the second POST carries the same id and IdempotencyBehavior treats
        // it as the replay it is rather than as a second product. (A 401 is
        // refused at the edge, before the handler, so nothing was published
        // to duplicate in the first place.)
        //
        // Unlike checkout, this page does not navigate away, so the replay
        // lands back on the same form with the same values in it — which is
        // the outcome the user asked for when they pressed Publish. On the
        // web it will not be reached at all: signIn() is a top-level
        // redirect to Keycloak and the heap does not survive it (spec §4.1).
        // It is written for the interface, which the native strategy
        // (spec §4.2) implements without the redirect.
        if (displayed.kind === 'signIn') this.signInAndReplay();
      },
    });
  }

  /** See the 401 branch above; `CartPage.getQuote()` documents why mapError takes `unknown` here. */
  private signInAndReplay(): void {
    const replay = !this.replayedAfterSignIn;
    this.replayedAfterSignIn = true;

    this.auth.signIn().then(
      () => {
        if (replay) this.publish();
      },
      (failure: unknown) => this.errorState.set(mapError(failure)),
    );
  }
}
