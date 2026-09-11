import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayError } from './error-mapper';
import { RetryCountdown } from './retry-countdown';

const rateLimited = (seconds: number): DisplayError => ({
  kind: 'rateLimited',
  title: 'Too many requests',
  detail: null,
  retryAfterSeconds: seconds,
});

/**
 * A host component rather than `TestBed.runInInjectionContext`, because the
 * construction site is the thing under test as much as the counting is:
 * `RetryCountdown` is built in a component field initialiser, and it depends
 * on that for the `effect()` it registers and the `DestroyRef` that stops its
 * interval. Constructing it any other way would test a shape no page uses.
 */
@Component({
  selector: 'app-retry-countdown-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class HostComponent {
  readonly error = signal<DisplayError | null>(null);
  readonly countdown = new RetryCountdown(this.error);
}

describe('RetryCountdown', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks down once a second and blocks the action until the window closes', () => {
    fixture.componentInstance.error.set(rateLimited(3));
    fixture.detectChanges();

    expect(fixture.componentInstance.countdown.remaining()).toBe(3);
    expect(fixture.componentInstance.countdown.blocked()).toBe(true);

    // The defect this class exists to fix: the banner used to render the
    // mapped number once and never touch it again, so "Retry in 60s" still
    // said 60 a minute later. A second of wall clock must move it.
    vi.advanceTimersByTime(1000);
    expect(fixture.componentInstance.countdown.remaining()).toBe(2);

    vi.advanceTimersByTime(2000);
    expect(fixture.componentInstance.countdown.remaining()).toBe(0);
    // The other half of spec §6's 429 row: the action is disabled for the
    // length of the window and released at the end of it, rather than staying
    // dead until something else happens to re-render.
    expect(fixture.componentInstance.countdown.blocked()).toBe(false);

    // And nothing keeps counting past zero into negative seconds.
    vi.advanceTimersByTime(5000);
    expect(fixture.componentInstance.countdown.remaining()).toBe(0);
  });

  it('opens no window for a failure that is not a 429', () => {
    fixture.componentInstance.error.set({
      kind: 'unavailable', title: 'Service unavailable', detail: null,
    });
    fixture.detectChanges();

    expect(fixture.componentInstance.countdown.blocked()).toBe(false);
  });

  it('ends the window when the error clears, without waiting for the clock', () => {
    fixture.componentInstance.error.set(rateLimited(30));
    fixture.detectChanges();
    expect(fixture.componentInstance.countdown.blocked()).toBe(true);

    // A success clears the banner. The action must come back immediately —
    // the gateway's window was about THIS refusal, and there is no refusal
    // left.
    fixture.componentInstance.error.set(null);
    fixture.detectChanges();

    expect(fixture.componentInstance.countdown.remaining()).toBe(0);
    expect(fixture.componentInstance.countdown.blocked()).toBe(false);
  });

  it('restarts the window when a second 429 arrives', () => {
    fixture.componentInstance.error.set(rateLimited(10));
    fixture.detectChanges();
    vi.advanceTimersByTime(4000);
    expect(fixture.componentInstance.countdown.remaining()).toBe(6);

    // mapError builds a fresh object per response, so this is a different
    // refusal with a different budget — the platform's latest word, not a
    // remainder of the first one.
    fixture.componentInstance.error.set(rateLimited(20));
    fixture.detectChanges();

    expect(fixture.componentInstance.countdown.remaining()).toBe(20);
  });

  it('stops its interval when the page is destroyed', () => {
    fixture.componentInstance.error.set(rateLimited(30));
    fixture.detectChanges();

    const countdown = fixture.componentInstance.countdown;
    fixture.destroy();

    // A leaked interval is its own defect: it would go on writing to a signal
    // for a page that no longer exists, once a second, for half a minute —
    // and this app is zoneless, so nothing else would ever notice it.
    vi.advanceTimersByTime(5000);
    expect(countdown.remaining()).toBe(30);
  });
});
