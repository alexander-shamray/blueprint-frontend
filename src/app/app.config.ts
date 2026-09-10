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
    // RETURN the promise — do not fire and forget. Angular waits on a returned
    // promise before bootstrapping, and that wait is what closes a real race:
    // CartStore's persistence effect is scheduled once at construction with the
    // initial EMPTY state. If a slow Preferences.get() — a native bridge round
    // trip, not web localStorage — let that first flush land before restore()
    // resolved, it would persist `[]`, and the pendingRestore guard would then
    // suppress the write that should have corrected it. The cart would come
    // back empty, silently. Blocking bootstrap on the read keeps the empty
    // state from ever being the one that flushes.
    provideAppInitializer(() => inject(CartStore).restore()),
  ],
};
