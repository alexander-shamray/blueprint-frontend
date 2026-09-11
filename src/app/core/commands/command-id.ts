import { Signal, signal } from '@angular/core';
import { DisplayError } from '@core/errors/error-mapper';

/**
 * The order id the placed page is given when the platform answered
 * `command.already_committed`: the order exists, but no id came back and there
 * is no endpoint to read one from. It lives here rather than on the checkout
 * page because two features need it and a feature never imports another
 * feature (spec §3) — the ESLint rule and the boundary test both enforce that.
 */
export const ALREADY_COMMITTED = 'already-committed';

/**
 * Spec §5.3's command-id lifecycle, as a state machine rather than as three
 * lines scattered through a page.
 *
 * The backend keys IdempotencyBehavior on subject, operation and commandId. A
 * retry with the same id is a replay; a concurrent second request with the
 * same id is refused with 409 `request.in_progress`; a retry of an id whose
 * result has expired is 409 `command.already_committed`. So the id is minted
 * once per FORM, not once per click — and the difference between the two is
 * the difference between a replay and a second order.
 */
export class CommandIdentity {
  private readonly id = signal(crypto.randomUUID());
  private readonly spent = signal(false);
  private failedValidationOnly = false;

  readonly current: Signal<string> = this.id.asReadonly();

  /**
   * True once the platform has said this id already committed. Do not resubmit it.
   *
   * This is a *record* of the fact, not an enforcement: `current()` returns a
   * usable id regardless of this signal's value. A page holding a spent identity
   * must check `isSpent()` and disable submit, rather than relying on this class
   * to refuse the id. This design — a signal meant to be read by callers — is
   * acceptable, but the guarantee lives entirely in the two pages that consume
   * this class, each of which must enforce it.
   */
  readonly isSpent: Signal<boolean> = this.spent.asReadonly();

  onFailure(error: DisplayError): void {
    // A validation failure never reached a handler — the request was refused
    // before IdempotencyBehavior claimed anything — so the id is free to be
    // released once the user changes the form. Every other failure may have
    // committed, so the id is held.
    this.failedValidationOnly = error.kind === 'validation';

    if (error.kind === 'alreadyCommitted') this.spent.set(true);
  }

  /**
   * An edit releases the id ONLY after a validation failure. After a network
   * failure or a 5xx the submission may have committed, and resubmitting
   * changed data under a fresh id is the duplicate the whole mechanism exists
   * to prevent.
   */
  onEdit(): void {
    // A spent id is permanent: the platform has told us this id committed, and
    // resubmitting under a fresh id is the second order the whole mechanism
    // exists to prevent. No edit — not even after a validation failure — may
    // release it. Only onSuccess() may clear spent, because only a completed
    // submission starts a new form entry.
    if (this.spent()) return;

    if (!this.failedValidationOnly) return;

    this.mint();
  }

  onSuccess(): void {
    this.mint();
  }

  private mint(): void {
    this.id.set(crypto.randomUUID());
    this.spent.set(false);
    this.failedValidationOnly = false;
  }
}
