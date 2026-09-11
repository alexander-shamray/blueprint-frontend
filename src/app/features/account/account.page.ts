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

  private readonly errorState = signal<DisplayError | null>(null);
  readonly error = this.errorState.asReadonly();

  /**
   * The platform's token posture in one line. Both sentences are true
   * statements about a realm decision rather than reassurance: `web-app`
   * carries `use.refresh.tokens: "false"`, so the browser genuinely cannot
   * survive a reload, and saying so is more useful than a silent sign-out.
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
    void this.auth.signOut();
  }
}
