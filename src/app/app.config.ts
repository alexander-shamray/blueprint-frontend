import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  isDevMode,
  provideAppInitializer,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { provideAuth } from '@core/auth/auth.providers';
import { CartStore } from '@core/cart/cart.store';
import { AppearanceStore } from '@core/theme/appearance.store';
import { serviceWorkerEnabled } from '@core/config/service-worker';
import { ShellUpdates } from '@core/config/shell-updates';
import { clientLogInterceptor } from '@core/log/client-log.interceptor';
import { provideClientLog } from '@core/log/client-log.providers';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Funnels window.onerror / unhandledrejection into Angular's
    // ErrorHandler. Present in the CLI scaffold's original app.config.ts;
    // Task 9's brief omitted it from its app.config.ts snippet without
    // recording that as deliberate, so it is restored here rather than
    // treated as superseded.
    provideBrowserGlobalErrorListeners(),
    provideIonicAngular(),
    // Angular's default RouteReuseStrategy compares only `routeConfig`
    // identity, ignoring params — so `placed/:id` navigating A -> B keeps
    // the SAME ActivatedRoute and component instance, and a page that reads
    // `route.snapshot` once (rather than subscribing to `paramMap`) shows
    // stale data forever after. IonicRouteStrategy is Ionic's own fix for
    // exactly this (it compares params too); provideIonicAngular() does not
    // install it, so it must be provided here. Task 13's review caught the
    // absence via order-placed.page.ts; this line is the app-wide fix, not
    // a page-local workaround.
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideRouter(routes),
    // Order between these three does not matter, and that is deliberate rather
    // than lucky: `rateLimitInterceptor` picks its bucket from the route and
    // the method, which is how the gateway picks its limiter policy, so it
    // reads nothing off the request that `authInterceptor` has to have
    // written first. `clientLogInterceptor` reads the URL, the method and the
    // body's `commandId`, and none of those is written by the other two.
    provideHttpClient(
      withInterceptors([authInterceptor, rateLimitInterceptor, clientLogInterceptor]),
    ),
    provideAuth(),
    provideClientLog(),
    // The cart survives a restart on every platform (spec §3). Restoring it
    // before the first render keeps the tab badge from flashing zero.
    //
    // RETURN the promise — do not fire and forget. Angular waits on a
    // returned promise before bootstrapping, so the first render sees the
    // restored cart instead of one that starts at zero and jumps a moment
    // later. That is the actual reason to return it here.
    //
    // It does NOT, on its own, close the race with CartStore's persistence
    // effect. That effect is scheduled once at construction, not run
    // synchronously, so under zoneless change detection its first flush can
    // land while `restore()` below is still awaiting `persistence.read()` —
    // Angular blocking bootstrap on this initializer's promise does not stop
    // the effect scheduler from flushing during that await, because the
    // scheduler is not gated on bootstrap at all. A flush that lands there
    // would see the signal still holding the exact array it was constructed
    // with and, without a guard against that, would persist `[]` over
    // whatever the real cart was — silently, since the in-memory state gets
    // corrected a moment later when `restore()` resolves and the screen ends
    // up right even though storage does not. That race is closed inside
    // CartStore itself, by refusing to ever persist the array the store was
    // born with (see `CartStore.INITIAL`), not by anything here.
    provideAppInitializer(() => inject(CartStore).restore()),
    // The appearance the user chose, put on the root before the first screen is
    // built. `index.html` has already set it from localStorage on the web; on
    // native this is the first place the stored choice is read (#92).
    provideAppInitializer(() => inject(AppearanceStore).restore()),
    // The web build is installable and keeps its shell — the code and the
    // manifest, and nothing the platform answers — for offline (#99,
    // docs/client-architecture.md §16). `src/ngsw-config.json` is the whole
    // cache boundary. Registered once the app is stable, so the worker's
    // install does not compete with the first screen, and never in a
    // development or a native build.
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled(isDevMode(), Capacitor.isNativePlatform()),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    // A newer shell is taken at the next navigation; see ShellUpdates.
    provideAppInitializer(() => void inject(ShellUpdates)),
  ],
};
