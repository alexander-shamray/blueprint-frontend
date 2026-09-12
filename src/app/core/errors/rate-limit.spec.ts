import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayError } from './error-mapper';
import { RateLimitWindows } from './rate-limit';

const rateLimited = (seconds: number): DisplayError => ({
  kind: 'rateLimited',
  title: 'Too many requests',
  detail: null,
  retryAfterSeconds: seconds,
});

describe('RateLimitWindows', () => {
  let windows: RateLimitWindows;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    windows = TestBed.inject(RateLimitWindows);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the window itself', () => {
    it('ticks down once a second and blocks the action until the window closes', () => {
      windows.forPartition('authenticated').open(rateLimited(3));

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

    it('counts wall clock, not ticks, so a suspended app does not resume a dead window', () => {
      windows.forPartition('authenticated').open(rateLimited(30));

      // The app goes to the background: a throttled browser tab fires its
      // interval roughly once a minute, and a suspended Capacitor WebView
      // does not fire it at all. Time passes without ticks — so the clock
      // moves 30 seconds here and only ONE tick follows it.
      vi.setSystemTime(Date.now() + 30_000);
      vi.advanceTimersByTime(1000);

      // Decrementing by one per tick would have this at 29 with the buttons
      // still dead, half a minute after the platform stopped refusing.
      expect(windows.authenticated.remaining()).toBe(0);
      expect(windows.authenticated.blocked()).toBe(false);
    });

    it('opens no window for a Retry-After of zero, and nothing to explain either', () => {
      windows.forPartition('authenticated').open(rateLimited(0));

      expect(windows.authenticated.blocked()).toBe(false);
      // No wait means no banner is owed: the page that made the request still
      // renders its own mapped error, and a page that made no request has
      // nothing to say about this one.
      expect(windows.authenticated.refusal()).toBeNull();
    });

    it('ends the window on close, without waiting for the clock', () => {
      windows.forPartition('authenticated').open(rateLimited(30));
      expect(windows.authenticated.blocked()).toBe(true);

      windows.forPartition('authenticated').close();

      expect(windows.authenticated.remaining()).toBe(0);
      expect(windows.authenticated.blocked()).toBe(false);
    });

    it('restarts the window when a second refusal arrives', () => {
      windows.forPartition('authenticated').open(rateLimited(10));
      vi.advanceTimersByTime(4000);
      expect(windows.authenticated.remaining()).toBe(6);

      // A different refusal with a different budget — the platform's latest
      // word, not a remainder of the first one.
      windows.forPartition('authenticated').open(rateLimited(20));

      expect(windows.authenticated.remaining()).toBe(20);
    });

    it('ignores a close from before the refusal that is standing', () => {
      const window = windows.forPartition('authenticated');
      // What a request holds when it goes out, before anything has been
      // refused.
      const epoch = window.epoch;

      window.open(rateLimited(30));
      // ...and now that earlier request's 200 finally lands. It was admitted,
      // but it was admitted BEFORE the refusal that is standing, so it is not
      // evidence about the bucket as it is now.
      window.close(epoch);

      expect(windows.authenticated.blocked()).toBe(true);
    });

    it('carries the refusal that opened it, and drops it when the window closes', () => {
      // This is what lets a page with no error of its own explain the wait.
      // Before the windows were shared, a 429 could only ever be shown by the
      // page that provoked it; now the countdown can be running because of
      // something the customer did on another tab, and a disabled button with
      // no banner above it is the client knowing and not saying.
      const refusal = rateLimited(30);
      windows.forPartition('authenticated').open(refusal);

      expect(windows.authenticated.refusal()).toBe(refusal);

      vi.advanceTimersByTime(30_000);
      expect(windows.authenticated.refusal()).toBeNull();
    });
  });

  describe('the two partitions', () => {
    it('keeps the catalogue window out of an authenticated refusal', () => {
      // Two policies in `Gateway.Api/appsettings.json`, assigned per route:
      // the public listing takes a fixed window of 100 a minute per IP, and
      // everything else a token bucket of 300 a minute per subject. Different
      // buckets, so emptying one says nothing about the other.
      windows.forPartition('authenticated').open(rateLimited(30));

      expect(windows.catalogue.blocked()).toBe(false);
      expect(windows.catalogue.refusal()).toBeNull();
    });

    it('keeps the authenticated window out of a catalogue refusal', () => {
      windows.forPartition('catalogue').open(rateLimited(30));

      expect(windows.authenticated.blocked()).toBe(false);
    });
  });

  it('stops its interval when the injector that owns it is destroyed', () => {
    // The windows outlive every page, so nothing else will ever stop them.
    // An interval that survives its injector goes on writing to a signal once
    // a second for the length of the window — and this app is zoneless, so
    // nothing would notice it happening.
    // Provided in the child rather than inherited, so the instance under test
    // takes its DestroyRef from the injector this test destroys.
    const injector = createEnvironmentInjector(
      [RateLimitWindows],
      TestBed.inject(EnvironmentInjector),
    );
    const owned = injector.get(RateLimitWindows).forPartition('authenticated');
    owned.open(rateLimited(30));

    injector.destroy();

    vi.advanceTimersByTime(5000);
    expect(owned.remaining()).toBe(0);
    expect(owned.blocked()).toBe(false);
  });
});
