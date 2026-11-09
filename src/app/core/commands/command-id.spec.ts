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

  it('spends the id after a reused-id answer, and an edit does not release it', () => {
    // command.id_reused (ADR-057): this id's first command completed. The id
    // replays nothing this form now holds, and a fresh one would place the
    // edited request as a second order, so no edit may mint one.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('idReused'));
    identity.onEdit();

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
    // alreadyCommitted marks this id as spent and permanently exhausted, and as
    // one that may have committed, so a later validation failure does not make
    // it releasable. Either record alone holds it: the platform has told us this
    // id committed, and resubmitting under a fresh id would be a second order.
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('alreadyCommitted'));
    expect(identity.isSpent()).toBe(true);

    identity.onFailure(failure('validation'));

    identity.onEdit();
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

  it.each<ErrorKind>(['retry', 'unavailable', 'inProgress'])(
    'holds the id on an edit after a validation failure that followed one of kind %s',
    (uncertain) => {
      // The first attempt may have committed. Validation runs before
      // IdempotencyBehavior claims anything, so the edited resubmit's 400 says
      // nothing about that commit, and a fresh id would place a second order.
      const identity = new CommandIdentity();
      const first = identity.current();

      identity.onFailure(failure(uncertain));
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).toBe(first);
    },
  );

  it('keeps holding the id through repeated validation failures after an uncertain one', () => {
    const identity = new CommandIdentity();
    const first = identity.current();

    identity.onFailure(failure('retry'));
    identity.onFailure(failure('validation'));
    identity.onEdit();
    identity.onFailure(failure('validation'));
    identity.onEdit();

    expect(identity.current()).toBe(first);
  });

  it('releases the id again once a success has minted a fresh one', () => {
    // mint() clears the may-have-committed record: it belonged to the old id.
    const identity = new CommandIdentity();

    identity.onFailure(failure('retry'));
    identity.onSuccess();
    const fresh = identity.current();

    identity.onFailure(failure('validation'));
    identity.onEdit();

    expect(identity.current()).not.toBe(fresh);
  });

  it('mints after a run of validation failures, each answered before the next went out', () => {
    const identity = new CommandIdentity();
    const first = identity.begin();

    identity.onFailure(failure('validation'));
    identity.begin();
    identity.onFailure(failure('validation'));
    identity.onEdit();

    expect(identity.current()).not.toBe(first);
  });

  describe('while a request under the id is still out (#425)', () => {
    it('hands out the id it holds, and keeps it', () => {
      const identity = new CommandIdentity();
      const first = identity.current();

      expect(identity.begin()).toBe(first);
      expect(identity.current()).toBe(first);
    });

    it('holds the id on an edit after a validation failure of a second press', () => {
      const identity = new CommandIdentity();
      const first = identity.begin();

      identity.begin();
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).toBe(first);
    });

    it('still holds the id once the request that was out has failed too', () => {
      // The record is kept rather than worked out again: holding an id is
      // always safe, because the platform answers a held id for what it is.
      const identity = new CommandIdentity();
      const first = identity.begin();
      identity.begin();

      identity.onFailure(failure('validation'));
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).toBe(first);
    });

    it('does not release on an edit made after the next press went out', () => {
      // The validation failure freed the id for an edit, and the press after it
      // claimed the id again before the edit arrived.
      const identity = new CommandIdentity();
      const first = identity.begin();
      identity.onFailure(failure('validation'));

      identity.begin();
      identity.onEdit();

      expect(identity.current()).toBe(first);
    });

    it('forgets what was out under the old id once one is minted', () => {
      const identity = new CommandIdentity();
      identity.begin();
      identity.begin();

      identity.onSuccess();
      const fresh = identity.begin();
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).not.toBe(fresh);
    });
  });

  describe('when a reply is dropped unread', () => {
    it('holds the id, since the dropped reply may have been a commit', () => {
      const identity = new CommandIdentity();
      const first = identity.begin();

      identity.onDropped(first);
      identity.begin();
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).toBe(first);
    });

    it('takes a dropped reply under an old id as nothing to do with the current one', () => {
      const identity = new CommandIdentity();
      const first = identity.begin();
      identity.onSuccess();

      identity.onDropped(first);
      const fresh = identity.begin();
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).not.toBe(fresh);
    });

    it('does not count a dropped reply under an old id against a request out now', () => {
      const identity = new CommandIdentity();
      const first = identity.begin();
      identity.onSuccess();
      const fresh = identity.begin();
      identity.begin();

      identity.onDropped(first);
      identity.onFailure(failure('validation'));
      identity.onEdit();

      expect(identity.current()).toBe(fresh);
    });
  });
});
