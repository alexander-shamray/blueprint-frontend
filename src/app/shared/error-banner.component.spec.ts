import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ErrorBannerComponent } from './error-banner.component';

const rateLimited = {
  kind: 'rateLimited' as const,
  title: 'Too many requests',
  detail: null,
  retryAfterSeconds: 60,
};

/**
 * `error` is a required input typed `DisplayError | null`, so `null` is a
 * legal value the component must survive on its own — not only because the
 * current template happens to gate every read behind `@if (error(); as e)`.
 * This is the one component test worth having ahead of a later task driving
 * the banner through real pages: it pins `heading()` against a runtime throw
 * that the compiler's non-null assertion would otherwise hide.
 */
describe('ErrorBannerComponent', () => {
  it('heading() does not throw when error is null', () => {
    const fixture = TestBed.createComponent(ErrorBannerComponent);
    fixture.componentRef.setInput('error', null);

    expect(() => (fixture.componentInstance as unknown as { heading: () => string }).heading()).not.toThrow();
    expect((fixture.componentInstance as unknown as { heading: () => string }).heading()).toBe(
      'Something went wrong.',
    );
  });

  it('renders the seconds the page is counting, not the number the response carried', () => {
    const fixture = TestBed.createComponent(ErrorBannerComponent);
    fixture.componentRef.setInput('error', rateLimited);
    // What the shared RateLimitWindow has ticked down to. The response said 60;
    // 43 seconds of it have passed. The banner used to render the mapped
    // number once and never touch it again, so it went on saying 60.
    fixture.componentRef.setInput('retryInSeconds', 17);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Retry in 17s.');
    expect(fixture.nativeElement.textContent).not.toContain('Retry in 60s.');
  });

  it('says the window has closed rather than counting down to zero', () => {
    const fixture = TestBed.createComponent(ErrorBannerComponent);
    fixture.componentRef.setInput('error', rateLimited);
    fixture.componentRef.setInput('retryInSeconds', 0);
    fixture.detectChanges();

    // "Retry in 0s." is a finished countdown still pretending to be one. The
    // banner stays on screen — the request really was refused — but it now
    // says the thing the disabled button has just stopped saying.
    expect(fixture.nativeElement.textContent).toContain('You can try again now.');
    expect(fixture.nativeElement.textContent).not.toContain('Retry in 0s.');
  });

  it('falls back to the mapped value when no page is counting', () => {
    const fixture = TestBed.createComponent(ErrorBannerComponent);
    fixture.componentRef.setInput('error', rateLimited);
    fixture.detectChanges();

    // A caller that passes no countdown gets the platform's figure stated
    // once — wrong as a countdown, but not a false statement about what the
    // gateway said.
    expect(fixture.nativeElement.textContent).toContain('Retry in 60s.');
  });
});
