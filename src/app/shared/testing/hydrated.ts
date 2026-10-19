/**
 * Waiting for Ionic's lazily loaded components in a spec, in one place (#261).
 *
 * This lives under `shared/` only because a feature may import `shared/` and
 * may not reach a file outside its own folder by a relative path
 * (`core/boundaries.spec.ts`); nothing in the application imports it.
 */

/** A Stencil host element: resolves once its lazily loaded component has rendered. */
export interface StencilHost extends Element {
  componentOnReady(): Promise<unknown>;
}

/** Every `ion-*` element under `root` that is a lazy Stencil component. */
export function ionicHosts(root: Element): StencilHost[] {
  return [...root.querySelectorAll('*')].filter(
    (el): el is StencilHost => el.tagName.startsWith('ION-') && 'componentOnReady' in el,
  );
}

/**
 * Rejects with `what` named if `work` has not settled in `ms`. For a wait that
 * would otherwise run to Vitest's 10 s limit without saying which one it was.
 */
export async function within<T>(what: string, work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tags whose lazily loaded component failed to load in this process. Stencil
 * logs `Constructor for "ion-x#undefined" was not found` once, does not retry,
 * and that tag's `componentOnReady()` never resolves, in this test and every
 * later one. In the runs that hung it was whichever Ionic component the first
 * test happened to load first (`ion-spinner` in one, `ion-input` in the next),
 * so it is the load that is unreliable and not any one component. A wait with
 * no bound then ran every later test to Vitest's limit, each, which is how one
 * failure became a whole file's worth (#261).
 */
const neverReady = new Set<string>();

/** Long enough for a chunk to load on a loaded host, shorter than Vitest's 10 s test limit. */
export const HOST_WAIT_MS = 5_000;

/** Forgets which tags were given up on. For the helper's own spec only. */
export function forgetNeverReady(): void {
  neverReady.clear();
}

/**
 * Waits for every Ionic host under `root` to hydrate, against a live fixture,
 * so that nothing Stencil started outlives the spec: a chunk that lands after
 * the file finished is the teardown race of #31 and #71.
 *
 * Each host has its own bound. One that misses it is named in a warning and
 * not waited on again in this run, since a host whose component failed to load
 * has no import left in flight to race the teardown, and waiting for it again
 * only costs every later test the bound. The price is that a host that was
 * merely slower than the bound is given up on too, and its chunk may land
 * late: a warning naming it is the signal, and a spec that asserts `hydrated`
 * (`tabs.page.spec.ts`) fails on it by name.
 */
export async function hydrated(root: Element, hostWaitMs = HOST_WAIT_MS): Promise<void> {
  const hosts = ionicHosts(root).filter((host) => !neverReady.has(host.tagName));
  await Promise.all(
    hosts.map(async (host) => {
      try {
        await within(`${host.tagName.toLowerCase()}.componentOnReady()`, host.componentOnReady(), hostWaitMs);
      } catch (failure) {
        neverReady.add(host.tagName);
        console.warn(`${(failure as Error).message}; not waited on again in this run`);
      }
    }),
  );
}
