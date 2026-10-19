import {
  ChangeDetectionStrategy, Component, DestroyRef, LOCALE_ID, computed, effect, inject, signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonButton, IonChip, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonNote, IonSegment,
  IonSegmentButton, IonTitle, IonToolbar,
} from '@ionic/angular';
import { SavedAddressApi } from '@core/api/saved-address.api';
import { Address } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { APPEARANCES, Appearance, AppearanceStore } from '@core/theme/appearance.store';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ADDRESS_FIELDS, AddressField, splitAddressErrors } from '@shared/address/address-errors';
import { countryOptions } from '@shared/address/countries';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/** Spec §5.6. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [
    IonButton, IonChip, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonNote, IonSegment,
    IonSegmentButton, IonTitle, IonToolbar, ReactiveFormsModule, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .field-error { display: block; padding: .25rem 1rem 0; font-size: .875rem; }
    .country { flex: 0 0 auto; margin-right: 1rem; }
    select { flex: 1; min-height: 2.75rem; background: transparent; color: inherit;
             border: none; font: inherit; }
  `,
  template: `
    <ion-header><ion-toolbar><ion-title>Account</ion-title></ion-toolbar></ion-header>

    <ion-content>
      <app-error-banner [error]="error()" />

      @if (denied(); as permission) {
        <ion-item>
          <ion-label>
            <h2>Route refused</h2>
            <ion-note>That page needs <code>{{ permission }}</code>, which this account does not hold.</ion-note>
          </ion-label>
        </ion-item>
      }

      @if (signInRequired() && !username()) {
        <ion-item>
          <ion-label>
            <h2>Route refused</h2>
            <ion-note>That page shows one buyer's own orders, so it needs you to be signed in.</ion-note>
          </ion-label>
        </ion-item>
      }

      @if (username(); as name) {
        <ion-item><ion-label><h2>{{ name }}</h2></ion-label></ion-item>

        <ion-item>
          <ion-label>
            <h3>Permissions</h3>
            @if (permissions().length === 0) {
              <ion-note>None. Every write in this application will answer 403.</ion-note>
            }
            @for (permission of permissions(); track permission) {
              <ion-chip>{{ permission }}</ion-chip>
            }
          </ion-label>
        </ion-item>

        @if (editingAddress()) {
          <!--
            The saved address, being edited. The same five fields as the order's
            form, and the 400's messages for them sit under the control they
            concern, as there; what is typed is held only while the editor is
            open, and a sign-out closes it.
          -->
          <form [formGroup]="addressForm" (ngSubmit)="saveAddress()" data-testid="address-form">
            <ion-item>
              <ion-input label="Line 1" formControlName="line1" required></ion-input>
            </ion-item>
            @for (message of addressMessages().line1 ?? []; track $index) {
              <ion-note class="field-error" color="danger" role="alert" data-field="line1">
                {{ message }}
              </ion-note>
            }
            <ion-item><ion-input label="Line 2" formControlName="line2"></ion-input></ion-item>
            @for (message of addressMessages().line2 ?? []; track $index) {
              <ion-note class="field-error" color="danger" role="alert" data-field="line2">
                {{ message }}
              </ion-note>
            }
            <ion-item><ion-input label="City" formControlName="city" required></ion-input></ion-item>
            @for (message of addressMessages().city ?? []; track $index) {
              <ion-note class="field-error" color="danger" role="alert" data-field="city">
                {{ message }}
              </ion-note>
            }
            <ion-item>
              <ion-input label="Postal code" formControlName="postalCode" required></ion-input>
            </ion-item>
            @for (message of addressMessages().postalCode ?? []; track $index) {
              <ion-note class="field-error" color="danger" role="alert" data-field="postalCode">
                {{ message }}
              </ion-note>
            }
            <ion-item>
              <label class="country" for="account-country">Country</label>
              <select id="account-country" formControlName="country" required>
                <option value="" disabled>Choose a country</option>
                @for (option of countries; track option.code) {
                  <option [value]="option.code">{{ option.name }}</option>
                }
              </select>
            </ion-item>
            @for (message of addressMessages().country ?? []; track $index) {
              <ion-note class="field-error" color="danger" role="alert" data-field="country">
                {{ message }}
              </ion-note>
            }
            <ion-button expand="block" type="submit" data-testid="save-address"
              [disabled]="addressForm.invalid || savingAddress()">
              @if (savingAddress()) { Saving… } @else { Save address }
            </ion-button>
            <ion-button expand="block" fill="clear" type="button" data-testid="cancel-address"
              (click)="cancelEditAddress()">Cancel</ion-button>
          </form>
        } @else {
          @if (savedAddress(); as address) {
            <ion-item data-testid="saved-address">
              <ion-label>
                <h3>Saved delivery address</h3>
                <p>{{ address.line1 }}</p>
                @if (address.line2) {
                  <p>{{ address.line2 }}</p>
                }
                <p>{{ address.postalCode }} {{ address.city }}, {{ address.country }}</p>
                <ion-note>Offered at checkout, where you can also save a different one.</ion-note>
              </ion-label>
            </ion-item>
            <ion-button expand="block" fill="outline" data-testid="edit-address"
              (click)="editAddress()">
              Change this address
            </ion-button>
            <ion-button expand="block" fill="outline" data-testid="forget-address"
              (click)="forgetAddress()">
              Forget this address
            </ion-button>
          } @else {
            <ion-button expand="block" fill="outline" data-testid="add-address"
              (click)="editAddress()">
              Add a delivery address
            </ion-button>
          }
        }

        <ion-button expand="block" (click)="signOut()">Sign out</ion-button>
      } @else {
        <ion-button expand="block" (click)="signIn()">Sign in</ion-button>
      }

      <ion-item lines="none"><ion-label><h3>Appearance</h3></ion-label></ion-item>
      <ion-segment aria-label="Appearance" data-testid="appearance"
        [value]="appearance()" (ionChange)="chooseAppearance($event)">
        <ion-segment-button value="system" data-testid="appearance-system">
          <ion-label>System</ion-label>
        </ion-segment-button>
        <ion-segment-button value="light" data-testid="appearance-light">
          <ion-label>Light</ion-label>
        </ion-segment-button>
        <ion-segment-button value="dark" data-testid="appearance-dark">
          <ion-label>Dark</ion-label>
        </ion-segment-button>
      </ion-segment>

      <ion-item><ion-note>{{ tokenPosture() }}</ion-note></ion-item>
    </ion-content>
  `,
})
export class AccountPage {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  private readonly savedAddressApi = inject(SavedAddressApi);
  private readonly appearanceStore = inject(AppearanceStore);

  /** The sheet the user chose, shown selected; the choice itself is `AppearanceStore`'s (#92). */
  readonly appearance = this.appearanceStore.choice;
  private readonly destroyRef = inject(DestroyRef);

  private readonly currentUser = this.auth.user();

  /**
   * The signed-in buyer's saved delivery address, shown for them to see,
   * change and forget. Held only while they are signed in: it is personal data,
   * so a sign-out, or a different buyer, empties it before anything else
   * happens. Checkout can also replace it, by saving a different one there.
   */
  private readonly savedAddressState = signal<Address | null>(null);
  readonly savedAddress = this.savedAddressState.asReadonly();

  /**
   * The editor. The same five members as the order's form, with the same
   * required set (`PlaceOrderValidator` and the saved address's own validator
   * ask for the same things), and the server judges the values, a prefilled
   * one like a typed one. `Validators.required` accepts nothing else here that
   * would matter: these are text.
   */
  readonly addressForm = new FormGroup({
    line1: new FormControl('', { nonNullable: true, validators: Validators.required }),
    line2: new FormControl('', { nonNullable: true }),
    city: new FormControl('', { nonNullable: true, validators: Validators.required }),
    postalCode: new FormControl('', { nonNullable: true, validators: Validators.required }),
    country: new FormControl('', { nonNullable: true, validators: Validators.required }),
  });
  private readonly editingState = signal(false);
  private readonly savingState = signal(false);
  private readonly addressMessagesState = signal<
    Partial<Record<AddressField, readonly string[]>>
  >({});
  readonly editingAddress = this.editingState.asReadonly();
  readonly savingAddress = this.savingState.asReadonly();
  /** A 400's messages for the editor's controls, by control. */
  readonly addressMessages = this.addressMessagesState.asReadonly();
  protected readonly countries = countryOptions(inject(LOCALE_ID));

  readonly username = computed(() => this.currentUser()?.username ?? null);
  readonly permissions = computed(() => this.currentUser()?.permissions ?? []);
  /**
   * Read reactively, NOT from `route.snapshot`, and this page is the one
   * where that matters most.
   *
   * permissionGuard sends a refused navigation here as
   * `/tabs/account?denied=<permission>`. Account is a TAB: Ionic caches its
   * page in the tab stack and hands back the same ComponentRef on re-entry,
   * so this constructor runs once per app session — and a user who has
   * opened Account even once would afterwards be redirected here by the
   * guard and shown nothing at all.
   *
   * IonicRouteStrategy does not rescue this the way it rescues
   * order-placed's `:id`: its shouldReuseRoute compares `future.params`
   * against `curr.params`, which are ROUTE params. Query params are not
   * compared, so a change from `/tabs/account` to
   * `/tabs/account?denied=catalog:write` reuses the component by design.
   * Subscribing is the only thing that sees it.
   */
  readonly denied = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('denied'))),
    { initialValue: this.route.snapshot.queryParamMap.get('denied') },
  );

  /**
   * `signedInGuard`'s `?signIn=required`, read reactively for the reason
   * `denied` is. Hidden again once a user is signed in, because the sentence
   * is about a session that no longer exists and the query param outlives it.
   */
  readonly signInRequired = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('signIn') === 'required')),
    { initialValue: this.route.snapshot.queryParamMap.get('signIn') === 'required' },
  );

  /**
   * Known, accepted open loop at a tab root. If `signIn()` rejects (banner
   * shown) and the user switches to another tab and back, Ionic performs no
   * teardown on Account — it is a tab root, never destroyed — so the stale
   * banner is still there, unprompted by anything the user just did. The two
   * methods that can set it, `signIn()` and `signOut()`, are also the only
   * two that clear it, and each clears it first thing. Left as-is
   * deliberately, unlike the publish page's spent `CommandIdentity`: that
   * loop was CLOSED (the one thing that could clear it was disabled). This
   * one is open — whichever of the two buttons is on screen is enabled, and
   * either clears the banner — so the residue is cosmetic, and arguably
   * still true, rather than a stuck affordance.
   */
  private readonly errorState = signal<DisplayError | null>(null);
  readonly error = this.errorState.asReadonly();

  /**
   * The platform's token posture in one line. Both sentences are true
   * statements about a realm decision rather than reassurance: `web-app`
   * carries `use.refresh.tokens: "false"`, so the browser genuinely cannot
   * survive a reload, and saying so is more useful than a silent sign-out.
   *
   * Both branches are live as of plan Task 19: `sessionEndsOnReload` is
   * `true` in `WebAuthStrategy` and `false` in `NativeAuthStrategy`, whose
   * refresh token really does sit in the Keychain or
   * EncryptedSharedPreferences and really is replaced on every renewal
   * (the realm's `revokeRefreshToken: true`, `refreshTokenMaxReuse: 0`).
   * Which sentence a user sees is decided by the factory in
   * auth.providers.ts and by nothing on this page, which is spec §4's
   * one-interface-two-implementations doing its job.
   */
  readonly tokenPosture = computed(() =>
    this.auth.sessionEndsOnReload
      ? 'Session ends on reload, no refresh token.'
      : 'Refresh token in secure storage, rotated.',
  );

  constructor() {
    // Through a computed, so a token renewal that hands over a new user
    // object for the same buyer does not read the address again.
    const subject = computed(() => this.currentUser()?.subject ?? null);
    effect(() => {
      const current = subject();
      untracked(() => {
        // Whatever was out for the last session is its own, and lands on nothing.
        this.sessionEpoch++;
        // Emptied first: a different buyer, or none, must never be left looking
        // at the last one's address while the read is out, or at what they were
        // typing into the editor.
        this.savedAddressState.set(null);
        this.closeEditor();
        this.readSavedAddress(current);
      });
    });

    // An edit after a refusal makes the refusal's messages stale: they were
    // about the value that was sent.
    for (const field of ADDRESS_FIELDS) {
      this.addressForm.controls[field].valueChanges.subscribe(() => {
        if (this.addressMessagesState()[field] === undefined) return;
        this.addressMessagesState.update((messages) => {
          const remaining = { ...messages };
          delete remaining[field];
          return remaining;
        });
      });
    }
  }

  /** Opens the editor on the saved address, or empty when there is none. */
  editAddress(): void {
    this.errorState.set(null);
    this.addressMessagesState.set({});
    const saved = this.savedAddressState();
    this.addressForm.reset({
      line1: saved?.line1 ?? '',
      line2: saved?.line2 ?? '',
      city: saved?.city ?? '',
      postalCode: saved?.postalCode ?? '',
      country: saved?.country ?? '',
    });
    this.editingState.set(true);
  }

  cancelEditAddress(): void {
    this.closeEditor();
  }

  /**
   * Replaces the saved address with what is in the editor. The PUT is
   * convergent (the same request leaves the row the first left), so there is no
   * command id, and a second press needs no guard. The reply is the address as
   * the server normalised it, and that is what is shown, not what was typed.
   * A 400's messages for a control sit under it and leave the banner, which
   * keeps only the keys no control here owns.
   */
  saveAddress(): void {
    if (this.addressForm.invalid) return;

    const value = this.addressForm.getRawValue();
    const address: Address = {
      ...value,
      // Empty means absent, as the order's form sends it.
      line2: value.line2.trim() === '' ? null : value.line2,
    };
    const epoch = this.sessionEpoch;
    const save = ++this.saveSequence;
    // Only the session changing or a newer save makes this reply someone
    // else's. A read or a tab re-entry while it is out does not: the PUT has
    // reached the server either way, and its answer is the newest word on the
    // address.
    const mine = (): boolean => epoch === this.sessionEpoch && save === this.saveSequence;
    this.errorState.set(null);
    this.addressMessagesState.set({});
    this.savingState.set(true);

    this.savedAddressApi
      .save(address)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (saved) => {
          if (!mine()) return;
          // A read that was out when this landed is older than it.
          this.latestRequest++;
          this.savedAddressState.set(saved);
          this.closeEditor();
        },
        error: (failure: unknown) => {
          if (!mine()) return;
          this.savingState.set(false);
          const displayed = mapError(failure);
          if (displayed.kind === 'validation') {
            const { byField, rest } = splitAddressErrors(displayed.fields, '');
            this.addressMessagesState.set(byField);
            this.errorState.set({
              ...displayed,
              fields: Object.keys(rest).length > 0 ? rest : undefined,
            });
            return;
          }
          this.errorState.set(displayed);
        },
      });
  }

  /** Closes the editor and drops what was typed: it is personal data. */
  private closeEditor(): void {
    this.editingState.set(false);
    this.savingState.set(false);
    this.addressMessagesState.set({});
    this.addressForm.reset();
  }

  /**
   * Account is a tab root and is never destroyed, so the constructor runs once
   * per app session, and an address saved or replaced at checkout since would
   * never appear. Ionic calls this on every entry, as it does `OrdersPage`'s
   * reload, and the address is read again then. The old one stays on screen
   * until the new one lands, because the same buyer is looking at it.
   */
  ionViewWillEnter(): void {
    this.readSavedAddress(this.currentUser()?.subject ?? null);
  }

  /**
   * Counts the reads and forgets, so an answer is applied only if nothing was
   * asked or forgotten after it. That one rule covers both ways a read can be
   * out of date: it lands after a forget, which would put back an address the
   * server has deleted, or after the session moved on, because every session
   * change asks again (or, with nobody signed in, counts without asking).
   */
  private latestRequest = 0;

  /**
   * Counts the sessions this page has seen, and the saves it has sent. A
   * save's reply is applied only if neither moved: it is not ordered by
   * `latestRequest`, because a read or a tab re-entry while a save is out must
   * not strand the editor on "Saving…".
   */
  private sessionEpoch = 0;
  private saveSequence = 0;

  /**
   * A failed read shows nothing: the address is a convenience, and an empty
   * section is its honest fallback.
   */
  private readSavedAddress(subject: string | null): void {
    const request = ++this.latestRequest;
    if (subject === null) return;

    this.savedAddressApi
      .read()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (saved) => {
          if (request === this.latestRequest) this.savedAddressState.set(saved);
        },
        error: () => undefined,
      });
  }

  forgetAddress(): void {
    this.errorState.set(null);
    this.latestRequest++;

    this.savedAddressApi.remove().subscribe({
      next: () => this.savedAddressState.set(null),
      error: (failure: unknown) => this.errorState.set(mapError(failure)),
    });
  }

  /**
   * The segment's change. Its value is whatever the clicked button carried, so
   * anything that is not one of the three is ignored rather than stored: a
   * value kept here is read back at every launch.
   */
  chooseAppearance(event: Event): void {
    const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
    if (!APPEARANCES.some((appearance) => appearance === value)) return;
    void this.appearanceStore.choose(value as Appearance);
  }

  signIn(): void {
    this.errorState.set(null);

    // .catch(), not a bare `void` — and this button matters more than the
    // cart's, because it is the application's primary sign-in affordance.
    // signIn() rejects when the identity provider is unreachable:
    // WebAuthStrategy retries the discovery document there, since
    // initCodeFlow() with no loginUrl returns having done nothing instead of
    // navigating. Swallowed, that leaves a Sign in button which looks broken
    // and says nothing — the same failure the initializer fix removed from
    // the shell, reappearing on the one screen whose job is to explain the
    // session.
    // Untyped on purpose. `loadDiscoveryDocument()` rejects with a bare
    // STRING, not an HttpErrorResponse — annotating it as one is a claim
    // the runtime does not honour, which is why mapError takes `unknown`
    // and returns a retry kind for anything it does not recognise.
    this.auth.signIn().catch((failure: unknown) => {
      this.errorState.set(mapError(failure));
    });
  }

  signOut(): void {
    // Cleared first, exactly as signIn() does: a failed sign-in leaves a
    // banner, and a sign-out that then succeeds would otherwise leave that
    // banner sitting beside a signed-out shell, describing an attempt that is
    // two states out of date. The banner belongs to the last thing this page
    // tried, so every entry point clears it.
    this.errorState.set(null);

    // .catch(), matching signIn() — and here it matters even more than
    // symmetry: a swallowed rejection leaves the user believing they are
    // signed out when they are not, which is the one failure on this page
    // worth being loud about. `WebAuthStrategy.signOut()` is async and
    // `oauth.logOut()` can throw when `logoutUrl` is unset; in practice the
    // Sign out button only renders once a token was adopted, which means
    // discovery already succeeded and `logoutUrl` is populated, but nothing
    // stops a future AuthService implementation from rejecting for a
    // different reason.
    this.auth.signOut().catch((failure: unknown) => {
      this.errorState.set(mapError(failure));
    });
  }
}
