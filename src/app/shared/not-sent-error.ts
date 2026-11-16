import { DisplayError } from '@core/errors/error-mapper';

/**
 * What a completed sign-in leaves on screen when the one replay a page owns is
 * already spent and was refused again (#610). The buyer or seller is signed in,
 * so "Sign in to continue." would be false, and dropping it would leave
 * nothing saying the command did not go out. Pressing the button again is safe:
 * the page still holds the command id.
 */
export function notSentError(): DisplayError {
  return {
    kind: 'retry',
    title: $localize`:@@error.notSentAfterSignIn:That was not sent.`,
    detail: $localize`:@@error.notSentAfterSignInDetail:You are signed in again. Press the button once more to send it.`,
  };
}
