import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonButton, IonChip, IonContent, IonHeader, IonItem, IonLabel, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
import { SavedAddressApi } from '@core/api/saved-address.api';
import { Address } from '@core/api/types';
import { AuthService } from '@core/auth/auth.service';
import { DisplayError, mapError } from '@core/errors/error-mapper';
import { ErrorBannerComponent } from '@shared/error-banner.component';

/** Spec §5.6. */
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [
    IonButton, IonChip, IonContent, IonHeader, IonItem, IonLabel, IonNote, IonTitle,
    IonToolbar, ErrorBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
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

        @if (savedAddress(); as address) {
          <ion-item data-testid="saved-address">
            <ion-label>
              <h3>Saved delivery address</h3>
              <p>{{ address.line1 }}</p>
              @if (address.line2) {
                <p>{{ address.line2 }}</p>
              }
              <p>{{ address.postalCode }} {{ address.city }}, {{ address.country }}</p>
              <ion-note>Offered at checkout. Save a different one there to replace it.</ion-note>
            </ion-label>
          </ion-item>
          <ion-button expand="block" fill="outline" data-testid="forget-address"
            (click)="forgetAddress()">
            Forget this address
          </ion-button>
        }

        <ion-button expand="block" (click)="signOut()">Sign out</ion-button>
      } @else {
        <ion-button expand="block" (click)="signIn()">Sign in</ion-button>
      }

      <ion-item><ion-note>{{ tokenPosture() }}</ion-note></ion-item>
    </ion-content>
  `,
})
export class AccountPage {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  private readonly savedAddressApi = inject(SavedAddressApi);
  private readonly destroyRef = inject(DestroyRef);

  private readonly currentUser = this.auth.user();

  /**
   * The signed-in buyer's saved delivery address, shown for them to see and
   * forget. Held only while they are signed in: it is personal data, so a
   * sign-out, or a different buyer, empties it before anything else happens.
   * Changing it is done at checkout, where it is entered.
   */
  private readonly savedAddressState = signal<Address | null>(null);
  readonly savedAddress = this.savedAddressState.asReadonly();

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
        // Emptied first: a different buyer, or none, must never be left looking
        // at the last one's address while the read is out.
        this.savedAddressState.set(null);
        this.readSavedAddress(current);
      });
    });
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
