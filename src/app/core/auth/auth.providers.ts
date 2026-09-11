import { EnvironmentProviders, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { AuthService } from './auth.service';
import { WebAuthStrategy } from './web-auth.strategy';

/**
 * The one place the application asks which platform it is on (spec §4). Every
 * screen, guard and interceptor below this line sees only AuthService.
 *
 * There is no platform test here YET, and its absence is deliberate rather
 * than an oversight: NativeAuthStrategy arrives in plan Task 19, against a
 * `mobile-app` realm client that does not exist either. A branch whose two
 * arms are identical would read as a bug to everyone who met it in between.
 */
export function provideAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideOAuthClient(),
    WebAuthStrategy,
    { provide: AuthService, useExisting: WebAuthStrategy },
    // The initialiser sees only AuthService — no cast — which is what putting
    // initialize() on the interface buys.
    provideAppInitializer(() => inject(AuthService).initialize()),
  ]);
}
