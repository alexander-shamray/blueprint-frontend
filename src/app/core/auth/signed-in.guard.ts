import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * `permissionGuard`'s sibling for a route that needs a principal and no
 * permission. The buyer's order read is one: `Web.Bff/Endpoints/OrderEndpoints.cs`
 * requires an authenticated caller at the group and binds the subject from it,
 * and there is no `orders:read` to hold (`types.ts`, `PERMISSIONS`).
 *
 * The same three layers as the permission it stands beside (spec §4.3): the
 * tab hides, this refuses, the backend decides. A refused navigation goes to
 * Account with `?signIn=required`, a reason stated rather than a blank list —
 * an empty history for a signed-out caller would read as "you have no orders",
 * which is a claim about somebody's account that nobody is signed in to make.
 */
export const signedInGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.user()() !== null) return true;

  return router.createUrlTree(['/tabs/account'], { queryParams: { signIn: 'required' } });
};
