import { DisplayError } from '@core/errors/error-mapper';

/**
 * What a completed sign-in leaves on screen when the one replay a page owns is
 * already spent and nothing was sent (#610). The user is signed in, so "Sign in
 * to continue." would be false, and dropping it would leave nothing saying the
 * command did not go out. The text is client-authored, the one banner spec §6
 * allows beyond the generic six: `client-architecture.md` §12, *A sign-in that
 * sends nothing says so*. Pressing the button again is what the page offers;
 * each caller says why that is safe.
 */
export function notSentError(): DisplayError {
  return {
    kind: 'retry',
    title: $localize`:@@error.notSentAfterSignIn:That was not sent.`,
    detail: $localize`:@@error.notSentAfterSignInDetail:You are signed in again. Press the button once more to send it.`,
  };
}
