import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import {
  IonButton, IonChip, IonContent, IonHeader, IonItem, IonLabel, IonNote, IonTitle, IonToolbar,
} from '@ionic/angular';
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

  private readonly currentUser = this.auth.user();

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
   * Known, accepted open loop at a tab root. If `signIn()` rejects (banner
   * shown) and the user switches to another tab and back, Ionic performs no
   * teardown on Account — it is a tab root, never destroyed — so the stale
   * banner is still there, unprompted by anything the user just did. Only
   * the next `signIn()` click clears it, since that is the only thing that
   * ever sets it. Left as-is deliberately, unlike Task 14's spent
   * `CommandIdentity`: that loop was CLOSED (the one thing that could clear
   * it was disabled). This one is open — the Sign in button that clears it
   * is always enabled — so the residue is cosmetic, and arguably still
   * true, rather than a stuck affordance.
   */
  private readonly errorState = signal<DisplayError | null>(null);
  readonly error = this.errorState.asReadonly();

  /**
   * The platform's token posture in one line. Both sentences are true
   * statements about a realm decision rather than reassurance: `web-app`
   * carries `use.refresh.tokens: "false"`, so the browser genuinely cannot
   * survive a reload, and saying so is more useful than a silent sign-out.
   *
   * The `false` branch is not live on any strategy that exists today —
   * `sessionEndsOnReload` is `true` in `WebAuthStrategy` and nothing else
   * implements `AuthService` yet, since native auth is Phase B. It stays
   * here because spec §5.6 mandates both sentences and spec §4's
   * one-interface-two-implementations is the point of the abstraction: this
   * is the contract Phase B's native strategy must satisfy, pinned now so it
   * cannot drift before that strategy exists to honour it — not a
   * description of anything this client does today.
   */
  readonly tokenPosture = computed(() =>
    this.auth.sessionEndsOnReload
      ? 'Session ends on reload, no refresh token.'
      : 'Refresh token in secure storage, rotated.',
  );

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
