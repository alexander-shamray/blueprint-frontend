import {
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { ClientLog, pathOf } from './client-log';

/**
 * The navigation half of #93: every completed navigation, as the path it
 * landed on. The OAuth return lands on `/?code=…&state=…`, which is why only
 * the path is kept. `core` knows routes as strings and nothing about the
 * screens behind them (spec §3).
 *
 * The request half is `clientLogInterceptor`, which `app.config.ts` lists
 * beside the other interceptors.
 */
export function provideClientLog(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const log = inject(ClientLog);
      inject(Router)
        .events.pipe(filter((event) => event instanceof NavigationEnd))
        .subscribe((event) =>
          log.record({ kind: 'navigation', path: pathOf(event.urlAfterRedirects) }),
        );
    }),
  ]);
}
