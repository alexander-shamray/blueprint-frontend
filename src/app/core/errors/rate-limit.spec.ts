import { Signal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, CurrentUser } from '@core/auth/auth.service';
import { DisplayError } from './error-mapper';
import { RateLimitWindows } from './rate-limit';

const rateLimited = (seconds: number): DisplayError => ({
  kind: 'rateLimited',
  title: 'Too many requests',
  detail: null,
  retryAfterSeconds: seconds,
});

const user: CurrentUser = {
  username: 'someone',
  subject: 'sub-1',
  permissions: [],
  expiresAt: Date.now() + 300_000,
};

class StubAuth {
  readonly current = signal<CurrentUser | null>(null);
  user = (): Signal<CurrentUser | null> => this.current;
  accessToken = () => (this.current() ? 'the-token' : null);
}

describe('RateLimitWindows', () => {
  let windows: RateLimitWindows;
  let auth: StubAuth;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useClass: StubAuth }],
    });

    windows = TestBed.inject(RateLimitWindows);
    auth = TestBed.inject(AuthService) as unknown as StubAuth;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the window itself', () => {
    it('ticks down once a second and blocks the action until the window closes', () => {
      windows.authenticated.open(rateLimited(3));

      expect(windows.authenticated.remaining()).toBe(3);
      expect(windows.authenticated.blocked()).toBe(true);

      // The defect this class exists to fix: the banner used to render the
      // mapped number once and never touch it again, so "Retry in 60s" still
      // said 60 a minute later. A second of wall clock must move it.
      vi.advanceTimersByTime(1000);
      expect(windows.authenticated.remaining()).toBe(2);

      vi.advanceTimersByTime(2000);
      expect(windows.authenticated.remaining()).toBe(0);
      // The other half of spec §6's 429 row: the action is disabled for the
      // length of the window and released at the end of it, rather than
      // staying dead until something else happens to re-render.
      expect(windows.authenticated.blocked()).toBe(false);

      // And nothing keeps counting past zero into negative seconds.
      vi.advanceTimersByTime(5000);
      expect(windows.authenticated.remaining()).toBe(0);
    });

    it('opens no window for a Retry-After of zero', () => {
      windows.authenticated.open({ ...rateLimited(0), retryAfterSeconds: 0 });

      expect(windows.authenticated.blocked()).toBe(false);
    });

    it('ends the window on close, without waiting for the clock', () => {
      windows.authenticated.open(rateLimited(30));
      expect(windows.authenticated.blocked()).toBe(true);

      // Something got through the limiter. The action must come back
      // immediately — the gateway's window was a prediction, and the
      // prediction has just been overtaken by an answer.
      windows.authenticated.close();

      expect(windows.authenticated.remaining()).toBe(0);
      expect(windows.authenticated.blocked()).toBe(false);
    });

    it('restarts the window when a second refusal arrives', () => {
      windows.authenticated.open(rateLimited(10));
      vi.advanceTimersByTime(4000);
      expect(windows.authenticated.remaining()).toBe(6);

      // A different refusal with a different budget — the platform's latest
      // word, not a remainder of the first one.
      windows.authenticated.open(rateLimited(20));

      expect(windows.authenticated.remaining()).toBe(20);
    });

    it('carries the refusal that opened it, and drops it when the window closes', () => {
      // This is what lets a page with no error of its own explain the wait.
      // Before the windows were shared, a 429 could only ever be shown by the
      // page that provoked it; now the countdown can be running because of
      // something the customer did on another tab, and a disabled button with
      // no banner above it is the client knowing and not saying.
      const refusal = rateLimited(30);
      windows.authenticated.open(refusal);

      expect(windows.authenticated.refusal()).toBe(refusal);

      vi.advanceTimersByTime(30_000);
      expect(windows.authenticated.refusal()).toBeNull();
    });
  });

  describe('the two partitions', () => {
    it('keeps the anonymous window out of an authenticated refusal', () => {
      // `Gateway.Api/Program.cs`: the authenticated policy partitions by the
      // subject claim, the anonymous one by IP with its own budget. They are
      // different buckets, so emptying one says nothing about the other.
      windows.authenticated.open(rateLimited(30));

      expect(windows.anonymous.blocked()).toBe(false);
      expect(windows.anonymous.refusal()).toBeNull();
    });

    it('keeps the authenticated window out of an anonymous refusal', () => {
      windows.anonymous.open(rateLimited(30));

      expect(windows.authenticated.blocked()).toBe(false);
    });
  });

  describe('the window a catalogue read will land in', () => {
    it('follows the anonymous window while signed out', () => {
      windows.anonymous.open(rateLimited(30));

      expect(windows.catalogue.blocked()).toBe(true);
      expect(windows.catalogue.remaining()).toBe(30);
    });

    it('follows the authenticated window while signed in', () => {
      // The catalogue is anonymous at the endpoint, but `authInterceptor`
      // attaches the bearer to EVERY gateway request once there is one — so a
      // signed-in customer's catalogue read is partitioned by their subject
      // like everything else. Which bucket a listing draws on is a fact about
      // the session, not about the route.
      auth.current.set(user);
      windows.authenticated.open(rateLimited(30));

      expect(windows.catalogue.blocked()).toBe(true);
      expect(windows.catalogue.remaining()).toBe(30);
    });

    it('stops following the anonymous window the moment the customer signs in', () => {
      windows.anonymous.open(rateLimited(30));
      expect(windows.catalogue.blocked()).toBe(true);

      // Signing in moves the next listing into the user's bucket, which is
      // full. Leaving Products disabled on the strength of the IP window
      // would be the client enforcing a limit the gateway is not.
      auth.current.set(user);

      expect(windows.catalogue.blocked()).toBe(false);
    });
  });
});
