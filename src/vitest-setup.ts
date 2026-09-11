// Ionic's web components are custom elements; registering them once here keeps
// every component test from doing it, and keeps a page test from silently
// rendering an empty <ion-content> that asserts nothing.
import { defineCustomElements } from '@ionic/core/loader';

// Loaded eagerly, and the import is the whole point rather than the binding.
//
// `ion-tabs` and `ion-router-outlet` lazily `import()` Ionic's swipe-back
// gesture, which imports the gesture controller. Those imports are still in
// flight when a spec's assertions finish, and Vitest tears the environment
// down as soon as the file does — so the module lands on a dead environment
// and reports `EnvironmentTeardownError: Cannot load
// '.../gesture-controller-*.js' ... after the environment was torn down`.
// Vitest counts that as an unhandled rejection and exits 1 even though every
// test passed, which is exactly how it reached CI: 151 passed, 2 errors,
// exit 1, and nothing reproduced locally because the race turns on how fast
// the module resolves.
//
// `@ionic/core`'s entry point statically imports that same gesture-controller
// chunk (dist/esm/index.js), so pulling it in here puts the module in the
// registry before any test runs. Ionic's later dynamic import then resolves
// from cache instead of racing teardown. A timing hack — awaiting a macrotask
// or two in an afterEach — would paper over the same race without removing
// it, and would come back the next time a runner was slow.
import '@ionic/core';

defineCustomElements(window);
