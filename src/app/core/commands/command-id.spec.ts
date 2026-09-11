import { describe, expect, it } from 'vitest';
import { DisplayError, ErrorKind } from '@core/errors/error-mapper';
import { CommandIdentity } from './command-id';

const failure = (kind: ErrorKind): DisplayError => ({ kind, title: '', detail: null });

describe('CommandIdentity', () => {
  it('mints an id when the form is entered', () => {
    expect(new CommandIdentity().current()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('keeps the id across a network failure, so the retry is a replay', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));

    expect(identity.current()).toBe(first);
  });

  it('keeps the id across an unavailable service', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('unavailable'));

    expect(identity.current()).toBe(first);
  });

  it('keeps the id when an identical request is still in flight', () => {
    // request.in_progress means the FIRST attempt is still running. A new id
    // would turn the retry into a second order.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('inProgress'));

    expect(identity.current()).toBe(first);
  });

  it('mints a new id after a success', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onSuccess();

    expect(identity.current()).not.toBe(first);
  });

  it('mints a new id when the form is edited after a validation failure', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('validation'));
    expect(identity.current()).toBe(first);

    identity.onEdit();
    expect(identity.current()).not.toBe(first);
  });

  it('does not mint a new id on an edit that follows no failure', () => {
    // Typing in a form that has never been submitted must not churn the id:
    // the id identifies the SUBMISSION, and there has not been one.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onEdit();

    expect(identity.current()).toBe(first);
  });

  it('does not mint a new id on an edit after a non-validation failure', () => {
    // The submission may have committed. Editing and resubmitting under a new
    // id is exactly the duplicate order IdempotencyBehavior exists to prevent,
    // so an edit here does NOT release the id.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));
    identity.onEdit();

    expect(identity.current()).toBe(first);
  });

  it('keeps the id after an already-committed answer, and never resubmits it', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));

    expect(identity.current()).toBe(first);
    expect(identity.isSpent()).toBe(true);
  });

  it('asserts v4 uuid format with version and variant nibbles', () => {
    const id = new CommandIdentity().current();
    // Version 4 (random) has 4 in the third group's first position
    // Variant RFC4122 has 8, 9, a, or b in the fourth group's first position
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not mint a new id on edit after success', () => {
    // After a successful submission, the id is fresh. An edit from valueChanges
    // is a no-op: the id identifies the submission, not the form state.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onSuccess();
    const afterSuccess = identity.current();
    expect(afterSuccess).not.toBe(first);

    identity.onEdit();
    expect(identity.current()).toBe(afterSuccess);
  });

  it('does not un-spend an id on edit after already-committed, even if validation failed', () => {
    // alreadyCommitted marks this id as spent and permanently exhausted.
    // A subsequent validation failure sets failedValidationOnly, but onEdit()
    // must not release a spent id: it is a guarantee that the platform has told
    // us this id committed, and resubmitting under a fresh id would be a second order.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));
    expect(identity.isSpent()).toBe(true);

    identity.onFailure(failure('validation'));
    // failedValidationOnly is now true, but spent is still true.

    identity.onEdit();
    // onEdit() must NOT mint when spent is true, regardless of failedValidationOnly.
    expect(identity.current()).toBe(first);
    expect(identity.isSpent()).toBe(true);
  });

  it('does not mint on edit after alreadyCommitted with no intervening failure', () => {
    // A spent id is not released by mere editing. The page must check isSpent()
    // and disable submit; this class does not refuse the id.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));
    expect(identity.isSpent()).toBe(true);

    identity.onEdit();
    expect(identity.current()).toBe(first);
    expect(identity.isSpent()).toBe(true);
  });

  it('clears spent on success, allowing a fresh submission', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));
    expect(identity.isSpent()).toBe(true);

    identity.onSuccess();
    // Success mints a new id and clears spent, because the successful submission
    // has completed and a new form entry begins.
    expect(identity.current()).not.toBe(first);
    expect(identity.isSpent()).toBe(false);
  });

  it('releases id after validation failure when previous non-validation failure did not reach a handler', () => {
    // Trace: onFailure('retry') then onFailure('validation') then onEdit().
    // The second failure (validation) is refused before the handler runs, so an id
    // that answered retry cannot have committed on that attempt. If the earlier retry
    // *had* committed, a resubmit under the same id would have replayed the success
    // or answered 409 already_committed, not 400. So the transition is safe: a 400
    // cannot follow a committed id.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));
    // At this point, failedValidationOnly is false, so onEdit() is a no-op.
    identity.onFailure(failure('validation'));
    // Now failedValidationOnly is true. The id may not have committed on retry,
    // and if it had, we would not have reached this 400. Safe to release.
    identity.onEdit();

    expect(identity.current()).not.toBe(first);
  });
});
