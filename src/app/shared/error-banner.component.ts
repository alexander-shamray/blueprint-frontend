import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { IonIcon, IonNote, IonText } from '@ionic/angular';
import { DisplayError, ErrorKind } from '@core/errors/error-mapper';

/**
 * The six generic banners spec §6 permits, plus one each for the two extra
 * 409s the backend distinguishes. Where the backend sends `title` and
 * `detail`, they are shown as sent and these are not used.
 */
const GENERIC: Readonly<Record<ErrorKind, string | null>> = {
  validation: null,
  banner: null,
  rule: null,
  signIn: 'Sign in to continue.',
  forbidden: 'Your account does not hold the permission this action needs.',
  alreadyCommitted: 'This request was already applied. It has not been sent again.',
  inProgress: 'An identical request is still in flight. Try again in a moment.',
  concurrencyConflict: 'Someone else changed this while you were working. Reload and try again.',
  rateLimited: 'Too many requests.',
  unavailable: 'The service is temporarily unavailable.',
  retry: 'Something went wrong.',
};

@Component({
  selector: 'app-error-banner',
  standalone: true,
  imports: [IonIcon, IonNote, IonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error(); as e) {
      <div class="banner" role="alert" [attr.data-kind]="e.kind">
        <ion-icon name="alert-circle-outline" aria-hidden="true"></ion-icon>

        <div>
          <ion-text><strong>{{ heading() }}</strong></ion-text>

          @if (e.detail) {
            <p>{{ e.detail }}</p>
          }

          @if (e.permission) {
            <p>Needed: <code>{{ e.permission }}</code></p>
          }

          @if (e.fields) {
            <ul>
              @for (field of fieldEntries(); track field[0]) {
                <li><strong>{{ field[0] }}</strong>: {{ field[1].join(' ') }}</li>
              }
            </ul>
          }

          @if (e.kind === 'rateLimited') {
            <p>
              Retry in {{ e.retryAfterSeconds }}s.
              <!--
                What the client can actually observe: it read no usable
                Retry-After off this response. WHY it read none — absent,
                empty, an HTTP-date, stripped in transit, an older gateway —
                is not in the response, and naming one of those causes would
                be the banner asserting a diagnosis it cannot make. Naming the
                wrong one is worse than being vague: an earlier wording here
                blamed CORS ("the gateway did not expose Retry-After to this
                origin"), and the gateway's policy names the header explicitly
                (Gateway.Api/Program.cs calls WithExposedHeaders("Retry-After",
                ...)), so the single cause that text picked is the one cause
                that has been ruled out. error-mapper.ts's constant lists what
                remains.
              -->
              @if (e.retryAfterIsFallback) {
                <ion-note>
                  The platform sent no readable Retry-After, so that is this app's own estimate.
                </ion-note>
              }
            </p>
          }

          @if (e.correlationId) {
            <ion-note>Correlation id: <code>{{ e.correlationId }}</code></ion-note>
          }
        </div>
      </div>
    }
  `,
  styles: `
    .banner { display: flex; gap: .75rem; padding: .75rem 1rem; border-radius: .5rem;
              background: var(--ion-color-danger-tint); color: var(--ion-color-danger-contrast); }
    ul { margin: .25rem 0 0; padding-left: 1.25rem; }
    p { margin: .25rem 0 0; }
  `,
})
export class ErrorBannerComponent {
  readonly error = input.required<DisplayError | null>();

  /**
   * The backend's title wins whenever it sent one; the generic is the
   * fallback. `error` is a required input typed `DisplayError | null`, so
   * `null` is a legal value here — not just a template guard upstream — and
   * must not be assumed away with a non-null assertion.
   */
  protected readonly heading = computed(() => {
    const e = this.error();
    return e ? e.title || GENERIC[e.kind] || 'Something went wrong.' : 'Something went wrong.';
  });

  protected readonly fieldEntries = computed(() => Object.entries(this.error()?.fields ?? {}));
}
