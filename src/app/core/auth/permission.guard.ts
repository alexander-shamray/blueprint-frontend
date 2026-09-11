import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * The guard hides; the backend decides (spec §4.3). It refuses navigation when
 * the claim is absent, and it carries the permission's name forward so the
 * banner can say which one was needed — the 403 response deliberately does not
 * name one, and the route is the only thing that knows.
 */
export function permissionGuard(permission: string): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);

    if (auth.hasPermission(permission)) return true;

    return router.createUrlTree(['/tabs/account'], {
      queryParams: { denied: permission },
    });
  };
}
