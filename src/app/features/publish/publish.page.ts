import {
  ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import {
  IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { map, switchMap } from 'rxjs';
import { CatalogApi } from '@core/api/catalog.api';
import { ProductImagesApi } from '@core/api/product-images.api';
import { AuthService } from '@core/auth/auth.service';
import { CatalogRefresh } from '@core/catalog/catalog-refresh';
import { PERMISSIONS, PublishProductCommand } from '@core/api/types';
import { ALREADY_COMMITTED, CommandIdentity } from '@core/commands/command-id';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { RateLimitWindows } from '@core/errors/rate-limit';
import { ErrorBannerComponent } from '@shared/error-banner.component';
import { ImageSource } from './image-source';
import { OwnProductsComponent } from './own-products.component';

/**
 * Where the chosen image is. `uploading` covers both hops, the BFF's issue and
 * the store's PUT; `failed` is one that may succeed if tried again, and
 * `refused` one the BFF answered with a 400, which the same file never will.
 */
type ImageStatus = 'uploading' | 'uploaded' | 'failed' | 'refused';

interface ChosenImage {
  readonly name: string;
  readonly status: ImageStatus;
}

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
 * command.id_reused gets the same escape and one difference. The earlier
 * publish under this id went through — ADR-057 stores only a success's
 * result — and this one, which the user has since edited, was refused
 * without running. So a new entry starts and the catalogue refreshes, as on
 * already_committed, but the form KEEPS the edited values: they are what was
 * not applied, and the note under the form says so and points at Products,
 * where the product that does exist can be read. Checkout points at History
 * and still makes the opposite choice: an edited order is a second order,
 * where an edited product is only the next entry.
 *
 * The gateway routes this POST through `catalog-write`, which matches POST
 * and requires authentication, rather than through `catalog-public`, which
 * matches GET alone and is anonymous. Both routes exist
 * (Gateway.Api/appsettings.json); the split is what lets the catalogue be
 * readable by anyone while publishing is not.
 *
 * The image is uploaded when it is chosen, not when Publish is pressed
 * (#108): the BFF issues a pre-signed PUT for one key, the bytes go straight
 * to the store, and the command carries the key. Uploading first is what
 * keeps a failure from publishing a bare product. While an image is chosen
 * and its upload has not landed, Publish stays disabled, and the image's own
 * Try again or Remove is the way on; a seller who wants no image removes it
 * and says so by doing it. An upload that landed holds for a day in the
 * store, so a publish that then fails is retried with the same key.
 */
@Component({
  selector: 'app-publish',
  standalone: true,
  imports: [
    IonButton, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonNote, IonTitle, IonToolbar,
    ReactiveFormsModule, ErrorBannerComponent, OwnProductsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header><ion-toolbar><ion-title>Publish</ion-title></ion-toolbar></ion-header>

    <ion-content>
      @if (signedOut()) {
        <!--
          Nobody is signed in, so the draft is not rendered: this tab root
          survives a native sign-out (#159). The form and its command id are
          held, for the owner's return.
        -->
        <ion-item data-testid="signed-out">
          <ion-note>Sign in to publish a product.</ion-note>
        </ion-item>
      } @else {
        <app-error-banner [error]="error() ?? imageError() ?? rateLimit.refusal()"
          [retryInSeconds]="rateLimit.remaining()" />

        <form [formGroup]="form" (ngSubmit)="publish()">
          <ion-item><ion-input label="Name" formControlName="name" required></ion-input></ion-item>
          <ion-item>
            <ion-input label="Amount" type="number" formControlName="amount" required></ion-input>
          </ion-item>
          <ion-item><ion-input label="Currency" formControlName="currency" required></ion-input></ion-item>

          @if (imageUnavailable) {
            <ion-item>
              <ion-label>
                Image
                <p data-testid="image-unavailable">{{ imageUnavailable }}</p>
              </ion-label>
            </ion-item>
          } @else {
            <ion-item>
              <ion-label>
                Image
                @if (image(); as chosen) {
                  <p data-testid="image-status">{{ chosen.name }}: {{ statusText(chosen.status) }}</p>
                } @else {
                  <p>Optional.</p>
                }
              </ion-label>
              @if (image()?.status === 'failed') {
                <ion-button slot="end" fill="clear" data-testid="retry-upload"
                  [disabled]="rateLimit.blocked()" (click)="retryUpload()">Try again</ion-button>
              }
              <ion-button slot="end" fill="clear" data-testid="choose-image"
                [disabled]="rateLimit.blocked()" (click)="chooseImage()">
                {{ image() ? 'Choose another' : 'Choose image' }}
              </ion-button>
              @if (image()) {
                <ion-button slot="end" fill="clear" data-testid="remove-image"
                  (click)="removeImage()">Remove</ion-button>
              }
            </ion-item>
          }

          <!--
            The BFF's 400 for the upload request, keyed ContentType or
            SizeBytes, sits under the image as a checkout field's sits under
            its control (#82): the limits are the server's, and this is where
            it says them.
          -->
          @for (message of imageFieldErrors(); track $index) {
            <ion-note class="field-error" color="danger" data-field="image">{{ message }}</ion-note>
          }

          <!--
            rateLimit.blocked() joins the other refusals: the gateway has
            said how long to wait and the banner above is counting it down
            (spec §6). imageBusy() is an image chosen and not yet in the
            store, which publishing now would leave off the product.
          -->
          <ion-button expand="block" type="submit"
            [disabled]="form.invalid || identity.isSpent() || rateLimit.blocked() || imageBusy()">
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

        @if (error()?.kind === 'idReused') {
          <ion-item>
            <ion-note>
              An earlier publish from this form already went through, so any changes you made since
              were not applied. Check Products before publishing again: publishing now creates a
              second product.
            </ion-note>
          </ion-item>
        }

        <app-own-products />
      }
    </ion-content>
  `,
  styles: `
    .field-error { display: block; padding: .25rem 1rem; }
  `,
})
export class PublishPage {
  private readonly catalog = inject(CatalogApi);
  private readonly images = inject(ProductImagesApi);
  private readonly imageSource = inject(ImageSource);
  private readonly catalogRefresh = inject(CatalogRefresh);
  private readonly auth = inject(AuthService);

  /** See `CheckoutPage.signedOut`: the draft is hidden, not dropped, while nobody is signed in. */
  protected readonly signedOut = computed(() => this.auth.user()() === null);

  readonly identity = new CommandIdentity();

  /** Read by the template to tell "committed, id unknown" apart from a real id. */
  protected readonly alreadyCommitted = ALREADY_COMMITTED;

  readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
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

  // The image is not a form control: no input renders it, and the form's
  // value is what `setValue` and `reset` are written against. So its key is a
  // signal beside the form, and each change to it is an edit to the command,
  // which `setImageKey` reports to the identity as a control's change would.
  private readonly imageState = signal<ChosenImage | null>(null);
  private readonly imageKeyState = signal<string | null>(null);
  private readonly imageErrorState = signal<DisplayError | null>(null);
  private readonly imageFieldErrorsState = signal<readonly string[]>([]);
  /** The file behind `image()`, kept so Try again sends the same bytes. */
  private imageFile: File | null = null;
  /** `replayedAfterSignIn`, for the upload's own 401. */
  private uploadReplayedAfterSignIn = false;
  /** Why this platform offers no image, or null where it does. */
  protected readonly imageUnavailable = this.imageSource.unavailable;
  /** Bumped by every new upload and every removal, so a superseded reply lands on nothing. */
  private uploads = 0;

  /** The chosen image and where its upload is, or null for a product with none. */
  readonly image = this.imageState.asReadonly();
  /** The upload's key once its bytes are in the store; what the command carries. */
  readonly imageKey = this.imageKeyState.asReadonly();
  /** The BFF's refusal of the upload request, other than a 400's field messages. */
  readonly imageError = this.imageErrorState.asReadonly();
  /** A 400's messages for the image, under the control as a field's are. */
  readonly imageFieldErrors = this.imageFieldErrorsState.asReadonly();
  /** An image is chosen and is not in the store, so Publish would leave it off. */
  readonly imageBusy = computed(() => {
    const image = this.imageState();
    return image !== null && image.status !== 'uploaded';
  });

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

  /** Bumped each time the effect below starts the form again for a new owner. */
  private subjectChanges = 0;

  constructor() {
    this.form.valueChanges.subscribe(() => this.identity.onEdit());

    // The owner rule `CheckoutPage`'s subject effect argues, for the same
    // reason: this tab root is cached for the app session and survives a
    // native sign-out, so the next buyer would otherwise find the last one's
    // draft under a live Publish, with their note and banner beside it. Only
    // a different buyer signing in starts the form again; a sign-out alone,
    // or the owner signing back in, keeps the draft and its held id.
    const user = this.auth.user();
    let owner = untracked(() => user()?.subject ?? null);
    effect(() => {
      const subject = user()?.subject ?? null;
      if (subject === null || subject === owner) return;
      const previous = owner;
      owner = subject;
      if (previous === null) return;
      untracked(() => {
        this.subjectChanges++;
        this.form.reset({ name: '', amount: null, currency: '' });
        this.errorState.set(null);
        this.publishedIdState.set(null);
        this.replayedAfterSignIn = false;
        // The upload was the last seller's, under their prefix: the key is
        // one the next seller's publish would be refused for.
        this.clearImage();
        this.identity.onSuccess();
      });
    });
  }

  /** What the image line says beside the file's name. */
  statusText(status: ImageStatus): string {
    switch (status) {
      case 'uploading':
        return 'uploading';
      case 'uploaded':
        return 'ready';
      case 'failed':
        return 'did not upload. Try again, or remove it to publish without one.';
      case 'refused':
        return 'not accepted. Choose another, or remove it.';
    }
  }

  /** Asks the image source for a file, and uploads it the moment it has one. */
  async chooseImage(): Promise<void> {
    const file = await this.imageSource.pick();
    if (file === null) return;
    // A file the seller chose is a new entry, with its own one replay after a
    // sign-in; the replay itself goes through `upload()`, so it cannot loop.
    this.uploadReplayedAfterSignIn = false;
    this.upload(file);
  }

  /** The image's own Try again: the same file, under a new key, since a key is single use. */
  retryUpload(): void {
    if (this.imageFile !== null && this.imageState()?.status === 'failed') this.upload(this.imageFile);
  }

  /** Publishes without an image, which the seller has now said by doing it. */
  removeImage(): void {
    this.clearImage();
  }

  private clearImage(): void {
    this.uploads++;
    // A new entry, so its upload has its own one replay after a sign-in, as
    // the subject effect gives a new owner's publish one.
    this.uploadReplayedAfterSignIn = false;
    this.imageFile = null;
    this.imageState.set(null);
    this.imageErrorState.set(null);
    this.imageFieldErrorsState.set([]);
    this.setImageKey(null);
  }

  private setImageKey(key: string | null): void {
    if (this.imageKeyState() === key) return;
    this.imageKeyState.set(key);
    this.identity.onEdit();
  }

  /**
   * The two hops: the BFF's issue, then the PUT to the URL it signed. The
   * type and the size are the file's own, and the BFF decides whether they
   * pass.
   *
   * Held to the page's owner rather than to whoever is signed in when the
   * reply lands. A different seller signing in clears the image, which bumps
   * `uploads`, so their arrival drops the reply; a sign-out alone keeps the
   * draft for the owner's return (#159), and a reply landing in between
   * belongs to that draft. Dropping it there would leave the image at
   * `uploading`, Publish held, and no Try again on screen.
   */
  private upload(file: File): void {
    const upload = ++this.uploads;
    const current = () => upload === this.uploads;

    this.imageFile = file;
    this.imageState.set({ name: file.name, status: 'uploading' });
    this.imageErrorState.set(null);
    this.imageFieldErrorsState.set([]);
    this.setImageKey(null);

    let issued = false;
    this.images
      .issue({ contentType: file.type, sizeBytes: file.size })
      .pipe(
        switchMap((granted) => {
          issued = true;
          return this.images.upload(granted, file).pipe(map(() => granted.key));
        }),
      )
      .subscribe({
        next: (key) => {
          if (!current()) return;
          this.uploadReplayedAfterSignIn = false;
          this.imageState.set({ name: file.name, status: 'uploaded' });
          this.setImageKey(key);
        },
        error: (failure: unknown) => {
          if (!current()) return;

          // The store's refusal is not the platform's: it answers in S3's XML,
          // not a problem body, and a 403 there is an expired or mismatched
          // signature rather than a missing permission. So it is not mapped.
          // A new issue is the remedy for every way it fails, and the line
          // under the image says to try again.
          if (issued) {
            this.imageState.set({ name: file.name, status: 'failed' });
            return;
          }

          // Every 400 is the BFF refusing this file's type or size, keyed or
          // not, and the same file sent again is refused again: so not
          // `failed`, whose Try again would only ask the same question.
          const displayed = mapError(failure, { permission: PERMISSIONS.catalogWrite });
          if (failure instanceof HttpErrorResponse && failure.status === 400) {
            this.imageState.set({ name: file.name, status: 'refused' });
            this.imageFieldErrorsState.set(Object.values(displayed.fields ?? {}).flat());
            // Keyed fields all landed under the image; a 400 with none says
            // what it says in the banner, as any other 400 would.
            if (!displayed.fields) this.imageErrorState.set(displayed);
            return;
          }

          this.imageState.set({ name: file.name, status: 'failed' });
          this.imageErrorState.set(displayed);

          // Spec §6's 401 row, as for a publish: the issue was refused at the
          // edge and wrote nothing, so the same file is asked about again once
          // the seller has signed in.
          if (displayed.kind === 'signIn') this.signInAndReupload(upload, file);
        },
      });
  }

  /**
   * `signInAndReplay()`'s bounds, for the upload: once per round trip, and
   * only while the refused seller is signed in and this is still the upload
   * the page is waiting on.
   */
  private signInAndReupload(upload: number, file: File): void {
    const replay = !this.uploadReplayedAfterSignIn;
    const refusedSubject = this.auth.user()()?.subject ?? null;

    this.auth.signIn().then(
      () => {
        const sameSubject =
          refusedSubject !== null && this.auth.user()()?.subject === refusedSubject;
        if (replay && sameSubject && upload === this.uploads) {
          this.uploadReplayedAfterSignIn = true;
          this.upload(file);
        }
      },
      (failure: unknown) => this.imageErrorState.set(mapError(failure)),
    );
  }

  publish(): void {
    // (ngSubmit) is not the only way in — this method is public and directly
    // callable — so the guard the template's [disabled] binding expresses
    // must also live here, the same precedent checkout's placeOrder() sets
    // for its own non-null assertion below. Without this, value.amount!
    // would assert over a null the required validator was supposed to have
    // ruled out. An image still on its way is the same kind of refusal: the
    // product would publish without it.
    if (this.form.invalid || this.imageBusy()) return;

    // Cleared at the START of every attempt, not just on the branches that
    // change it: a "Published as ..." (or already-committed) note from a
    // PRIOR success must not keep sitting under an error banner from THIS
    // attempt, implying the thing that just failed actually succeeded.
    this.publishedIdState.set(null);

    const value = this.form.getRawValue();
    const imageKey = this.imageKeyState();

    const command: PublishProductCommand = {
      commandId: this.identity.current(),
      name: value.name,
      // Omitted rather than null for a product with no image, so the body
      // holds only what the seller chose (#175's keys test reads them).
      ...(imageKey !== null ? { imageKey } : {}),
      // The form's required validator guarantees a number here. Sending null
      // would be met with the backend's own NotNull, keyed `Amount` — correct,
      // and still a client bug.
      amount: value.amount!,
      currency: value.currency,
    };

    // Held to the buyer who sent it, as `CheckoutPage.placeOrder()` holds its
    // reply: anyone else signed in is shown nothing of it.
    const issuedFor = this.auth.user()()?.subject ?? null;
    const changesAtIssue = this.subjectChanges;
    const stillFor = (): boolean =>
      this.subjectChanges === changesAtIssue &&
      (this.auth.user()()?.subject ?? null) === issuedFor;

    this.catalog.publish(command).subscribe({
      next: (productId) => {
        if (!stillFor()) return;
        this.replayedAfterSignIn = false;
        this.errorState.set(null);
        this.publishedIdState.set(productId);
        this.identity.onSuccess();
        this.form.reset({ name: '', amount: null, currency: '' });
        this.clearImage();

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
        if (!stillFor()) return;
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
          this.form.reset({ name: '', amount: null, currency: '' });
          this.clearImage();
          this.catalogRefresh.request();
          return;
        }

        if (displayed.kind === 'idReused') {
          // The earlier publish committed and this edited one did not (see
          // the class doc comment). The banner and the note stay up, the
          // edited values stay in the form, and onSuccess() starts the new
          // entry that onFailure() above left spent — so the next click is a
          // new product under a new id, which the note has just warned of.
          this.errorState.set(displayed);
          this.identity.onSuccess();
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

  /**
   * See the 401 branch above; `CartPage.getQuote()` documents why mapError
   * takes `unknown` here. The replay is held to the subject that was refused,
   * for the reason `CheckoutPage.signInAndReplay()` gives: under another
   * principal the same commandId is a new command, and they never pressed
   * Publish.
   */
  private signInAndReplay(): void {
    const replay = !this.replayedAfterSignIn;
    const refusedSubject = this.auth.user()()?.subject ?? null;
    const changesAtRefusal = this.subjectChanges;

    this.auth.signIn().then(
      () => {
        // Nor is anything replayed when the subject effect has started the form
        // again in between, even for the refused subject coming back: what it
        // would send is no longer the publish that was refused (#160), as in
        // `CheckoutPage`.
        const sameSubject =
          refusedSubject !== null &&
          this.auth.user()()?.subject === refusedSubject &&
          this.subjectChanges === changesAtRefusal;
        if (replay && sameSubject) {
          // Spent where the replay is sent (#157); see CheckoutPage.
          this.replayedAfterSignIn = true;
          this.publish();
        }
      },
      (failure: unknown) => this.errorState.set(mapError(failure)),
    );
  }
}
