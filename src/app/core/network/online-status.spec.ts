import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnlineStatus } from './online-status';

describe('OnlineStatus', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts from what the browser reports', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    expect(TestBed.inject(OnlineStatus).online()).toBe(false);
  });

  it('follows the browser going offline and coming back', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    const status = TestBed.inject(OnlineStatus);
    expect(status.online()).toBe(true);

    window.dispatchEvent(new Event('offline'));
    expect(status.online()).toBe(false);

    window.dispatchEvent(new Event('online'));
    expect(status.online()).toBe(true);
  });

  it('stops listening when its injector is destroyed', () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    const status = TestBed.inject(OnlineStatus);
    TestBed.resetTestingModule();

    window.dispatchEvent(new Event('offline'));
    expect(status.online()).toBe(true);
  });
});
