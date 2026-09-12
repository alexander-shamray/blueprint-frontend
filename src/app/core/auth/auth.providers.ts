import { EnvironmentProviders, inject, makeEnvironmentProviders, provideAppInitializer } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { provideOAuthClient } from 'angular-oauth2-oidc';
import { AuthService } from './auth.service';
import { NativeAuthStrategy } from './native-auth.strategy';
import { WebAuthStrategy } from './web-auth.strategy';

/**
 * The one place the application asks which platform it is on (spec §4). Every
 * screen, guard and interceptor below this line sees only AuthService.
 *
 * Both strategies are registered, and only the one the factory picks is ever
 * constructed: `inject()` inside a factory is lazy, so the web build never
 * instantiates the native strategy and never reaches for the Keychain, while
 * a device never configures an OAuth library it has no use for.
 */
export function provideAuth(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideOAuthClient(),
    WebAuthStrategy,
    NativeAuthStrategy,
    {
      provide: AuthService,
      useFactory: () =>
        Capacitor.isNativePlatform() ? inject(NativeAuthStrategy) : inject(WebAuthStrategy),
    },
    // The initialiser sees only AuthService — no cast — which is what putting
    // initialize() on the interface buys. It completes a pending code flow on
    // the web and restores a stored refresh token on native, and the caller
    // here cannot tell which.
    provideAppInitializer(() => inject(AuthService).initialize()),
  ]);
}
