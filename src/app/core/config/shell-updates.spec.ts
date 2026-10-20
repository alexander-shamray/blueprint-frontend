import { DOCUMENT } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { OnlineStatus } from '@core/network/online-status';
import { ShellUpdates } from './shell-updates';

function setup(options: { enabled: boolean; online?: boolean }) {
  const versions = new Subject<{ type: string }>();
  const routerEvents = new Subject<unknown>();
  const updates = {
    isEnabled: options.enabled,
    versionUpdates: versions.asObservable(),
    activateUpdate: vi.fn(() => Promise.resolve(true)),
    checkForUpdate: vi.fn(() => Promise.resolve(false)),
  };
  const online = signal(options.online ?? true);
  const assign = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: updates },
      { provide: Router, useValue: { events: routerEvents.asObservable() } },
      { provide: OnlineStatus, useValue: { online: online.asReadonly() } },
      // The service reads `document.location`; a stand-in records the load.
      { provide: DOCUMENT, useValue: { location: { assign } } },
    ],
  });
  const shell = TestBed.inject(ShellUpdates);
  return { shell, versions, routerEvents, updates, online, assign };
}

const navigateTo = (url: string) => new NavigationStart(1, url);

describe('ShellUpdates', () => {
  it('does nothing without a worker', () => {
    const { versions, routerEvents, updates, assign } = setup({ enabled: false });
    versions.next({ type: 'VERSION_READY' });
    routerEvents.next(navigateTo('/tabs/cart'));

    expect(updates.checkForUpdate).not.toHaveBeenCalled();
    expect(updates.activateUpdate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('leaves the running shell alone until a navigation', () => {
    const { versions, updates, assign } = setup({ enabled: true });
    versions.next({ type: 'VERSION_READY' });

    expect(updates.activateUpdate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('activates the newer shell on the next navigation and loads the destination fresh', async () => {
    const { versions, routerEvents, updates, assign } = setup({ enabled: true });
    versions.next({ type: 'VERSION_READY' });
    routerEvents.next(navigateTo('/tabs/cart'));

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/tabs/cart'));
    expect(updates.activateUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores a navigation when no newer shell is waiting', () => {
    const { routerEvents, updates, assign } = setup({ enabled: true });
    routerEvents.next(navigateTo('/tabs/cart'));

    expect(updates.activateUpdate).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('takes a waiting shell once, not at every later navigation', async () => {
    const { versions, routerEvents, updates, assign } = setup({ enabled: true });
    versions.next({ type: 'VERSION_READY' });
    routerEvents.next(navigateTo('/tabs/cart'));
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    routerEvents.next(navigateTo('/tabs/products'));

    expect(updates.activateUpdate).toHaveBeenCalledTimes(1);
  });

  it('ignores a version event that is not a ready one', () => {
    const { versions, routerEvents, updates } = setup({ enabled: true });
    versions.next({ type: 'VERSION_DETECTED' });
    routerEvents.next(navigateTo('/tabs/cart'));

    expect(updates.activateUpdate).not.toHaveBeenCalled();
  });

  it('asks for an update at start and again when the connection returns', async () => {
    const { updates, online } = setup({ enabled: true, online: false });
    TestBed.tick();
    expect(updates.checkForUpdate).not.toHaveBeenCalled();

    online.set(true);
    TestBed.tick();
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);
  });
});
