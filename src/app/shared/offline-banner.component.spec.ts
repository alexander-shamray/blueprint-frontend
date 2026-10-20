import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { OnlineStatus } from '@core/network/online-status';
import { OfflineBannerComponent } from './offline-banner.component';

async function render(online: boolean) {
  const state = signal(online);
  TestBed.configureTestingModule({
    providers: [{ provide: OnlineStatus, useValue: { online: state.asReadonly() } }],
  });
  const fixture = TestBed.createComponent(OfflineBannerComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, state };
}

const banner = (fixture: { nativeElement: HTMLElement }) =>
  fixture.nativeElement.querySelector('[data-testid="offline-banner"]');

describe('OfflineBannerComponent', () => {
  it('is absent while online', async () => {
    const { fixture } = await render(true);
    expect(banner(fixture)).toBeNull();
  });

  it('says what is on screen was loaded earlier, as a status, while offline', async () => {
    const { fixture } = await render(false);
    const shown = banner(fixture);

    expect(shown).not.toBeNull();
    expect(shown?.getAttribute('role')).toBe('status');
    expect(shown?.textContent).toContain('offline');
    expect(shown?.textContent).toContain('prices or stock may have changed');
  });

  it('appears and goes away as the connection does', async () => {
    const { fixture, state } = await render(true);

    state.set(false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(banner(fixture)).not.toBeNull();

    state.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(banner(fixture)).toBeNull();
  });
});
