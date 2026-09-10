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
});
