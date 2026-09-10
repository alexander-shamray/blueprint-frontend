import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ErrorBannerComponent } from './error-banner.component';

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
});
