import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CONVERSATION } from '@core/assistant/assistant-client';
import { hydrated } from '@shared/testing/hydrated';
import { AssistantStore } from './assistant.store';
import { AssistantEntryComponent } from './assistant-entry.component';

async function mount(available: boolean) {
  TestBed.resetTestingModule();
  const store = {
    available: signal(available),
    navigated: signal(0),
    setVisible: vi.fn(),
    // What the panel reads once the sheet presents it.
    provider: signal('anthropic'),
    noticePending: signal(false),
    state: signal(EMPTY_CONVERSATION),
  };
  TestBed.configureTestingModule({
    imports: [AssistantEntryComponent],
    // The sheet presents its template through Ionic's Angular delegate, as the app does.
    providers: [provideIonicAngular(), { provide: AssistantStore, useValue: store }],
  });
  const fixture = TestBed.createComponent(AssistantEntryComponent);
  fixture.detectChanges();
  await hydrated(fixture.nativeElement);
  return { fixture, store, root: fixture.nativeElement as HTMLElement };
}

const OPEN = '[data-testid="assistant-open"]';

describe('AssistantEntryComponent', () => {
  it('renders nothing while the assistant is unavailable (design §9.1)', async () => {
    const { root } = await mount(false);

    expect(root.querySelector(OPEN)).toBeNull();
    expect(root.querySelector('ion-modal')).toBeNull();
  });

  it('opens its sheet from the button, and a dismissed sheet hides the conversation', async () => {
    const { fixture, store, root } = await mount(true);
    const modal = root.querySelector('ion-modal') as HTMLElement & { isOpen: boolean };

    (root.querySelector('[data-testid="assistant-open"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(modal.isOpen).toBe(true);

    modal.dispatchEvent(new CustomEvent('didDismiss'));
    fixture.detectChanges();
    expect(modal.isOpen).toBe(false);
    expect(store.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('a presented sheet shows the conversation', async () => {
    const { store, root } = await mount(true);

    root.querySelector('ion-modal')?.dispatchEvent(new CustomEvent('didPresent'));

    expect(store.setVisible).toHaveBeenLastCalledWith(true);
  });

  // Not opened first: a sheet removed while it presents has no parent, and
  // Ionic then takes it for a controller's modal with no delegate.
  it('takes the button and the sheet away when the assistant becomes unavailable', async () => {
    const { fixture, store, root } = await mount(true);
    expect(root.querySelector(OPEN)).not.toBeNull();

    store.available.set(false);
    fixture.detectChanges();

    expect(root.querySelector(OPEN)).toBeNull();
    expect(root.querySelector('ion-modal')).toBeNull();
  });
});
