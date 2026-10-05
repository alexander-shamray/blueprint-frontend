import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AuthService, CurrentUser } from './auth.service';
import { signedInGuard } from './signed-in.guard';

function guardWith(user: CurrentUser | null): boolean | UrlTree {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideRouter([]), { provide: AuthService, useValue: { user: () => signal(user) } }],
  });

  return TestBed.runInInjectionContext(
    () => signedInGuard(null as never, null as never) as boolean | UrlTree,
  );
}

describe('signedInGuard', () => {
  it('admits a signed-in caller whatever permissions they hold, including none', () => {
    expect(
      guardWith({ username: 'browser', subject: 's', permissions: [], expiresAt: 0 }),
    ).toBe(true);
  });

  it('redirects a signed-out caller to Account, saying why, rather than showing an empty list', () => {
    const result = guardWith(null);

    expect(result).toBeInstanceOf(UrlTree);
    const url = TestBed.inject(Router).serializeUrl(result as UrlTree);
    expect(url).toBe('/tabs/account?signIn=required');
  });
});
