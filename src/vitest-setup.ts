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

// Awaited, which it was not before: `defineCustomElements` returns a promise
// and Stencil's bootstrap runs inside it, so an un-awaited call left bootstrap
// in flight while the first test was already running.
await defineCustomElements(window);

// Then drain Stencil's app-load fallback before any test starts.
//
// `bootstrapLazy` schedules `setTimeout(appDidLoad, 30)` when no component is
// connected yet — which is exactly the state a spec file is in — and
// `appDidLoad` emits `appload` on the window it captured at module load
// (@ionic/core 9.0.3, dist/esm/index-C23AVPx9.js: the emit at :3031, the
// fallback at :3643). There is NO once-guard on appDidLoad; :2997 calls it
// again for every root-level component that loads.
//
// A fast spec file finishes well inside those 30ms — `types.spec.ts` is two
// tests in about a millisecond — so its environment is torn down before the
// timer fires, and the emit lands on a window whose `dispatchEvent` no longer
// exists: `TypeError: elm.dispatchEvent is not a function`. Vitest counts that
// as an unhandled error and exits 1 with every test passing, which is how it
// reached CI: 233 passed, 1 error, exit 1, on ONE of two runs of the same
// commit and never locally. A 30ms race against teardown looks exactly like
// that.
//
// This is not the "await a macrotask or two in an afterEach" hack the comment
// above rejects, and the difference is the point: that would have been an
// unbounded guess in teardown, papering over a race whose duration nobody
// knew. This waits for a NAMED event, before any test runs, with a bound that
// exists only so a future Ionic which stops emitting `appload` cannot hang the
// suite instead of failing it.
await new Promise<void>((resolve) => {
  window.addEventListener('appload', () => resolve(), { once: true });
  setTimeout(resolve, 500);
});
