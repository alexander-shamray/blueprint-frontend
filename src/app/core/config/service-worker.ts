/**
 * Whether the service worker registers (#99, `docs/client-architecture.md`
 * §16). Two refusals, each its own reason:
 *
 * - **A development build.** A worker that serves the previous build's shell
 *   to `ng serve` makes every edit look as if it had not saved.
 * - **A native build.** Capacitor serves the bundle from `https://localhost`
 *   and `capacitor://localhost` (§15), and the app store's update is already
 *   the thing that replaces it. A worker there is a second cache in front of
 *   that update, with its own idea of which build is current.
 *
 * A function of its two inputs rather than an expression in `app.config.ts`,
 * so the second refusal has a test that fails when it is dropped.
 */
export function serviceWorkerEnabled(devMode: boolean, nativePlatform: boolean): boolean {
  return !devMode && !nativePlatform;
}
