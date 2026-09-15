import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { CartPersistence } from '@core/cart/cart.persistence';
import { TabsPage } from './tabs.page';

/** A Stencil host element: resolves once its lazily loaded component has rendered. */
interface StencilHost extends Element {
  componentOnReady(): Promise<unknown>;
}

function ionicHosts(root: Element): StencilHost[] {
  return [...root.querySelectorAll('*')].filter(
    (el): el is StencilHost => el.tagName.startsWith('ION-') && 'componentOnReady' in el,
  );
}

// Mounting is not finished when `detectChanges` returns, and this file is
// where that bit (#31).
//
// Every `ion-*` element here is a lazy Stencil component: connecting it
// starts a dynamic `import()` of its entry chunk, and the component is built
// and rendered when that resolves — about 110ms after mount under jsdom,
// measured locally, where the whole file takes about 30ms. So the file used to
// end with hydration still in flight. The fixture is destroyed, the worker
// begins closing its RPC channel, and the chunk then lands on the detached
// hosts; on CI Ionic's `consoleError` logs a `DOMException` for each, that log
// is still pending when the channel closes, and Vitest reports
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
// as an unhandled error — exit 1, with every test passing.
//
// Awaiting `componentOnReady()` on every host moves hydration inside the test,
// against a live fixture, so nothing Stencil started outlives the file. It
// waits on the component's own readiness rather than on a guessed delay — the
// same distinction `src/vitest-setup.ts` draws for `appload` — and it has no
// bound of its own: a host that never hydrates fails on the test's timeout,
// which is the loud outcome, where a bound would quietly hand the race back.
async function mount(permissions: readonly string[]): Promise<ComponentFixture<TabsPage>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TabsPage],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          hasPermission: (n: string) => permissions.includes(n),
          user: () => signal(null),
        },
      },
      // Stubbed like every other page spec. TabsPage injects the root
      // CartStore for its badge count, and CartStore's constructor hydrates
      // itself from CartPersistence — which is Capacitor Preferences, i.e.
      // real localStorage under jsdom. It happens to work, because nothing
      // here writes, but a spec that reads the machine's storage is one
      // leftover key away from depending on the order the suite ran in.
      { provide: CartPersistence, useValue: { read: async () => [], write: async () => undefined } },
    ],
  });

  const fixture = TestBed.createComponent(TabsPage);
  fixture.detectChanges();
  await Promise.all(ionicHosts(fixture.nativeElement).map((host) => host.componentOnReady()));
  return fixture;
}

describe('TabsPage', () => {
  // The subject of this test is `mount` itself, not the page: without it, a
  // later edit that drops the await passes both tests below and reopens #31 in
  // CI only, where nobody runs it on purpose.
  it('finishes hydrating every Ionic host before a test asserts', async () => {
    const hosts = ionicHosts((await mount([])).nativeElement);

    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.filter((host) => !host.classList.contains('hydrated'))).toEqual([]);
  });

  it('shows three tabs to a user holding no permissions', async () => {
    const tabs = (await mount([])).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'account',
    ]);
  });

  it('adds the publish tab for a holder of catalog:write', async () => {
    const tabs = (await mount(['catalog:write'])).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'publish',
      'account',
    ]);
  });
});
