import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetNeverReady, hydrated, ionicHosts, within } from './hydrated';

/** A stand-in for a Stencil host whose readiness the test controls. */
function host(tag: string, ready: Promise<unknown>): HTMLElement {
  const element = document.createElement(tag);
  Object.assign(element, { componentOnReady: () => ready });
  return element;
}

describe('ionicHosts', () => {
  it('finds ion-* elements that are Stencil components, at any depth, and nothing else', () => {
    const root = document.createElement('div');
    const inner = document.createElement('div');
    inner.append(host('ion-button', Promise.resolve()));
    // `ion-` by name but no Stencil component behind it, so no `componentOnReady`.
    root.append(host('ion-item', Promise.resolve()), inner, document.createElement('ion-not-ionic'));
    root.append(document.createElement('span'));

    expect(ionicHosts(root).map((el) => el.tagName)).toEqual(['ION-ITEM', 'ION-BUTTON']);
  });
});

describe('within', () => {
  it('passes a settled value through', async () => {
    await expect(within('a wait', Promise.resolve(3), 50)).resolves.toBe(3);
  });

  it('passes a rejection through unchanged', async () => {
    await expect(within('a wait', Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });

  it('names the wait and the bound when the work never settles', async () => {
    await expect(within('ion-x.componentOnReady()', new Promise(() => undefined), 10)).rejects.toThrow(
      'ion-x.componentOnReady() did not settle within 10 ms',
    );
  });
});

describe('hydrated', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    forgetNeverReady();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    forgetNeverReady();
  });

  it('waits for every host, however many, and says nothing when they all arrive', async () => {
    let later!: () => void;
    const pending = new Promise<void>((resolve) => (later = resolve));
    const root = document.createElement('div');
    root.append(host('ion-a', Promise.resolve()), host('ion-b', pending));
    let done = false;

    const waiting = hydrated(root, 1_000).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);

    later();
    await waiting;
    expect(done).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives up on a host that never hydrates, names it, and still waits for the others', async () => {
    const root = document.createElement('div');
    root.append(host('ion-never', new Promise(() => undefined)), host('ion-fine', Promise.resolve()));

    await hydrated(root, 20);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('ion-never.componentOnReady() did not settle within 20 ms');
    expect(warn.mock.calls[0][0]).not.toContain('ion-fine');
  });

  it('does not wait on that tag again, so one failed load costs one bound and not one per test', async () => {
    const first = document.createElement('div');
    first.append(host('ion-never', new Promise(() => undefined)));
    await hydrated(first, 20);

    const second = document.createElement('div');
    second.append(host('ion-never', new Promise(() => undefined)));
    const started = Date.now();
    await hydrated(second, 5_000);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('still waits on a tag that was fine, after another was given up on', async () => {
    const first = document.createElement('div');
    first.append(host('ion-never', new Promise(() => undefined)));
    await hydrated(first, 20);

    let later!: () => void;
    const pending = new Promise<void>((resolve) => (later = resolve));
    const second = document.createElement('div');
    second.append(host('ion-fine', pending));
    let done = false;
    const waiting = hydrated(second, 1_000).then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);

    later();
    await waiting;
  });

  it('is not tripped by a host whose readiness rejects: it is given up on the same way', async () => {
    const root = document.createElement('div');
    root.append(host('ion-broken', Promise.reject(new Error('load failed'))));

    await expect(hydrated(root, 20)).resolves.toBeUndefined();

    expect(warn.mock.calls[0][0]).toContain('load failed');
  });
});
