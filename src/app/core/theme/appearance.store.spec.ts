import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_KEY, AppearanceStore, DARK_CLASS } from './appearance.store';

/** A stand-in for the device's colour-scheme media query that a test can flip. */
function fakeMediaQuery(initiallyDark: boolean) {
  let listener: ((event: { matches: boolean }) => void) | null = null;
  const query = {
    matches: initiallyDark,
    addEventListener: (_type: string, handler: (event: { matches: boolean }) => void) => {
      listener = handler;
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    flip: (dark: boolean) => {
      query.matches = dark;
      listener?.({ matches: dark });
    },
  };
}

const onRoot = () => document.documentElement.classList.contains(DARK_CLASS);

describe('AppearanceStore', () => {
  beforeEach(async () => {
    document.documentElement.classList.remove(DARK_CLASS);
    await Preferences.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove(DARK_CLASS);
  });

  function start(initiallyDark = false) {
    const media = fakeMediaQuery(initiallyDark);
    const store = TestBed.inject(AppearanceStore);
    TestBed.tick();
    return { store, media };
  }

  it('starts on system, and follows the device while it is', () => {
    const { store, media } = start(false);
    expect(store.choice()).toBe('system');
    expect(onRoot()).toBe(false);

    media.flip(true);
    TestBed.tick();
    expect(onRoot()).toBe(true);

    media.flip(false);
    TestBed.tick();
    expect(onRoot()).toBe(false);
  });

  it('puts the dark sheet on from a dark device without being asked', () => {
    start(true);
    expect(onRoot()).toBe(true);
  });

  it('holds light against a dark device, because the stylesheet does not ask the media query', async () => {
    const { store } = start(true);

    await store.choose('light');
    TestBed.tick();

    expect(onRoot()).toBe(false);
  });

  it('holds dark against a light device', async () => {
    const { store } = start(false);

    await store.choose('dark');
    TestBed.tick();

    expect(onRoot()).toBe(true);
  });

  it('stops following the device once a sheet is chosen, and follows it again on system', async () => {
    const { store, media } = start(false);
    await store.choose('light');
    media.flip(true);
    TestBed.tick();
    expect(onRoot()).toBe(false);

    await store.choose('system');
    TestBed.tick();
    expect(onRoot()).toBe(true);
  });

  it('keeps the choice in Preferences under its key', async () => {
    const { store } = start();

    await store.choose('dark');

    expect((await Preferences.get({ key: APPEARANCE_KEY })).value).toBe('dark');
  });

  it('restores a stored choice at start-up', async () => {
    await Preferences.set({ key: APPEARANCE_KEY, value: 'dark' });
    const { store } = start(false);

    await store.restore();
    TestBed.tick();

    expect(store.choice()).toBe('dark');
    expect(onRoot()).toBe(true);
  });

  it.each([null, 'purple', '', '"dark"'])('ignores a stored value of %j', async (stored) => {
    if (stored !== null) await Preferences.set({ key: APPEARANCE_KEY, value: stored });
    const { store } = start(false);

    await store.restore();

    expect(store.choice()).toBe('system');
  });

  it('starts on system when Preferences cannot be read, rather than failing the start', async () => {
    const { store } = start(false);
    // On the web Preferences is localStorage, so a storage that refuses is how it fails.
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });

    await expect(store.restore()).resolves.toBeUndefined();
    getItem.mockRestore();

    expect(store.choice()).toBe('system');
  });

  it('applies a choice for this session even when it cannot be kept', async () => {
    const { store } = start(false);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });

    await expect(store.choose('dark')).resolves.toBeUndefined();
    setItem.mockRestore();
    TestBed.tick();

    expect(onRoot()).toBe(true);
  });
});

describe('the first-paint script in index.html', () => {
  const script = (() => {
    const html = readFileSync('src/index.html', 'utf8');
    const match = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!match) throw new Error('index.html carries no inline script');
    return match[1];
  })();

  function runWith(stored: string | null, deviceDark: boolean): boolean {
    document.documentElement.classList.remove(DARK_CLASS);
    vi.stubGlobal('matchMedia', () => ({ matches: deviceDark }));
    if (stored === null) localStorage.removeItem('CapacitorStorage.appearance');
    else localStorage.setItem('CapacitorStorage.appearance', stored);
    new Function(script)();
    return onRoot();
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove(DARK_CLASS);
  });

  it('reads the key Preferences writes, so the two agree', async () => {
    await Preferences.set({ key: APPEARANCE_KEY, value: 'dark' });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));

    new Function(script)();

    expect(onRoot()).toBe(true);
  });

  it.each([
    ['dark', false, true],
    ['dark', true, true],
    ['light', true, false],
    ['light', false, false],
    [null, true, true],
    [null, false, false],
    ['purple', true, true],
    ['purple', false, false],
  ])('stored %j on a device that is dark: %j gives dark sheet %j', (stored, deviceDark, expected) => {
    expect(runWith(stored, deviceDark)).toBe(expected);
  });

  it('leaves the light sheet and does not throw when storage is unavailable', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => new Function(script)()).not.toThrow();
    expect(onRoot()).toBe(false);
    getItem.mockRestore();
  });
});
