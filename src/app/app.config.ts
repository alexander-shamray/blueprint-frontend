import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, RouteReuseStrategy } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
import { rateLimitInterceptor } from '@core/errors/rate-limit.interceptor';
import { provideAuth } from '@core/auth/auth.providers';
import { CartStore } from '@core/cart/cart.store';

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
    // Order between these two does not matter, and that is deliberate rather
    // than lucky: `rateLimitInterceptor` picks its bucket from the route and
    // the method, which is how the gateway picks its limiter policy, so it
    // reads nothing off the request that `authInterceptor` has to have
    // written first.
    provideHttpClient(withInterceptors([authInterceptor, rateLimitInterceptor])),
    provideAuth(),
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
  ],
};
