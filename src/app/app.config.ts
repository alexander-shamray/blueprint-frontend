import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  inject,
  provideAppInitializer,
} from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';
import { routes } from './app.routes';
import { authInterceptor } from '@core/auth/auth.interceptor';
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
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
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
