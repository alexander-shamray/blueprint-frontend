import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provideAuth } from './auth.providers';
import { AuthService } from './auth.service';
import { NativeAuthStrategy } from './native-auth.strategy';
import { WebAuthStrategy } from './web-auth.strategy';

/**
 * The platform branch is the only line in the application that asks which
 * platform it is on (spec §4), and it is a line that cannot be reached by
 * running the web build — `isNativePlatform()` is false there forever. Left
 * untested it would break only on a device, which is the one place a failure
 * is least visible and slowest to find.
 *
 * Both strategies are replaced with stand-ins so that resolving AuthService
 * neither configures an OAuth library nor opens the Keychain: the question
 * here is which one the factory picks, not what either of them then does.
 */
describe('provideAuth', () => {
  // `initialize` is not decoration: TestBed runs app initializers when the
  // testing module is finalized, so provideAuth's own
  // `provideAppInitializer(() => inject(AuthService).initialize())` calls it
  // on whichever stand-in the factory picked. That makes each test below
  // cover the initialiser's no-cast property too.
  const web = { name: 'web', initialize: vi.fn(async () => undefined) };
  const native = { name: 'native', initialize: vi.fn(async () => undefined) };

  function resolve(): unknown {
    TestBed.configureTestingModule({
      providers: [
        provideAuth(),
        // After provideAuth(), so these win: the factory's `inject()` calls
        // resolve to these objects rather than constructing the real
        // strategies.
        { provide: WebAuthStrategy, useValue: web },
        { provide: NativeAuthStrategy, useValue: native },
      ],
    });

    return TestBed.inject(AuthService);
  }

  beforeEach(() => {
    web.initialize.mockClear();
    native.initialize.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('picks the native strategy on a device, and initialises that one', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);

    expect(resolve()).toBe(native);
    expect(native.initialize).toHaveBeenCalledOnce();
    expect(web.initialize).not.toHaveBeenCalled();
  });

  it('picks the web strategy in a browser, and initialises that one', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);

    expect(resolve()).toBe(web);
    expect(web.initialize).toHaveBeenCalledOnce();
    expect(native.initialize).not.toHaveBeenCalled();
  });
});
