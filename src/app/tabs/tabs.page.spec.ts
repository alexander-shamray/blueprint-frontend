import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { CartPersistence } from '@core/cart/cart.persistence';
import { hydrated, ionicHosts } from '@shared/testing/hydrated';
import { TabsPage } from './tabs.page';

// Mounting is not finished when `detectChanges` returns, and treating it as
// finished is what caused #31.
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
// same distinction `src/vitest-setup.ts` draws for `appload`. The wait is the
// shared `hydrated()`, which bounds each host (#261): this file used to have
// none, on the argument that a host that never hydrates should fail on the
// test's timeout, the loud outcome. A host whose component failed to load
// never hydrates, though, and one such failure then took every later test in
// the file to the limit with no word of which host it was. The bound names it,
// and the first test below still fails loudly on it, by asserting that every
// host carries the `hydrated` class.
async function mount(
  permissions: readonly string[],
  signedIn = false,
): Promise<ComponentFixture<TabsPage>> {
  TestBed.resetTestingModule();
  const user = signedIn
    ? signal({ username: 'demo', subject: 's', permissions, expiresAt: 0 })
    : signal(null);
  TestBed.configureTestingModule({
    imports: [TabsPage],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          hasPermission: (n: string) => permissions.includes(n),
          user: () => user,
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
  await hydrated(fixture.nativeElement);
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

  it('shows three tabs to a signed-out visitor', async () => {
    const tabs = (await mount([])).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'account',
    ]);
  });

  it('adds History for anyone signed in, permissions or none — the read asks for a session only', async () => {
    const tabs = (await mount([], true)).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'orders',
      'account',
    ]);
  });

  describe('focus on entering a page (#240)', () => {
    // Dispatched the way Ionic does it: `bubbles: false`, on the page element.
    // The first version of this listened on the document in the bubble phase,
    // passed a spec that called the function directly, and never ran in a browser.
    function enter(page: HTMLElement) {
      page.dispatchEvent(new CustomEvent('ionViewDidEnter', { bubbles: false }));
    }

    function mountPage(): HTMLElement {
      const page = document.createElement('div');
      page.className = 'ion-page';
      const header = document.createElement('ion-header');
      header.append(document.createElement('ion-title'));
      page.append(header);
      document.body.append(page);
      return page;
    }

    afterEach(() => {
      document.body.querySelectorAll('div.ion-page').forEach((page) => page.remove());
    });

    it('focuses the title of the second page entered, and leaves the first alone', async () => {
      await mount([]);
      const first = mountPage();
      const second = mountPage();

      enter(first);
      expect(document.activeElement).not.toBe(first.querySelector('ion-title'));

      enter(second);
      expect(document.activeElement).toBe(second.querySelector('ion-title'));
    });

    it('stops listening once the shell is destroyed', async () => {
      const fixture = await mount([]);
      const page = mountPage();
      enter(page);
      fixture.destroy();

      enter(page);

      expect(document.activeElement).not.toBe(page.querySelector('ion-title'));
    });
  });

  it('adds the publish tab for a holder of catalog:write', async () => {
    const tabs = (await mount(['catalog:write'], true)).nativeElement.querySelectorAll(
      'ion-tab-button',
    );

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'orders',
      'publish',
      'account',
    ]);
  });
});
