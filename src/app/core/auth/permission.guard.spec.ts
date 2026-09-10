import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { permissionGuard } from './permission.guard';

function guardWith(permissions: readonly string[]): boolean | UrlTree {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: { hasPermission: (n: string) => permissions.includes(n) } },
    ],
  });

  return TestBed.runInInjectionContext(
    () => permissionGuard('catalog:write')(null as never, null as never) as boolean | UrlTree,
  );
}

describe('permissionGuard', () => {
  it('admits a holder of the permission', () => {
    expect(guardWith(['catalog:write'])).toBe(true);
  });

  it('redirects a caller without it, naming the permission that was needed', () => {
    const result = guardWith(['orders:write']);

    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toContain('denied=catalog:write');
  });
});
