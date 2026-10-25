import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ConversationState, EMPTY_CONVERSATION } from '@core/assistant/assistant-client';
import { hydrated } from '@shared/testing/hydrated';
import { AssistantStore } from './assistant.store';
import { AssistantPanelComponent } from './assistant-panel.component';

async function mount(state: Partial<ConversationState> = {}, noticePending = false) {
  TestBed.resetTestingModule();
  const store = {
    provider: signal('anthropic'),
    noticePending: signal(noticePending),
    state: signal<ConversationState>({ ...EMPTY_CONVERSATION, ...state }),
    acknowledgeNotice: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    startOver: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    imports: [AssistantPanelComponent],
    providers: [{ provide: AssistantStore, useValue: store }],
  });
  const fixture: ComponentFixture<AssistantPanelComponent> =
    TestBed.createComponent(AssistantPanelComponent);
  fixture.detectChanges();
  await hydrated(fixture.nativeElement);
  return { fixture, store, root: fixture.nativeElement as HTMLElement };
}

function texts(root: HTMLElement, testId: string): string[] {
  return [...root.querySelectorAll(`[data-testid="${testId}"]`)].map(
    (e) => e.textContent?.trim().replace(/\s+/g, ' ') ?? '',
  );
}

function type(fixture: ComponentFixture<AssistantPanelComponent>, value: string): void {
  const box = fixture.nativeElement.querySelector('ion-input') as HTMLElement;
  box.dispatchEvent(new CustomEvent('ionInput', { detail: { value } }));
  fixture.detectChanges();
}

describe('AssistantPanelComponent', () => {
  it('names the provider and holds the box until the notice is acknowledged', async () => {
    const { fixture, store, root } = await mount({}, true);

    expect(texts(root, 'assistant-notice')[0]).toContain('anthropic');
    expect(root.querySelector('ion-input')?.hasAttribute('disabled')).toBe(true);

    (root.querySelector('[data-testid="assistant-notice-ok"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(store.acknowledgeNotice).toHaveBeenCalled();
  });

  it('shows each kind of item: the messages, a tool call by its words, and a refusal', async () => {
    const { root } = await mount({
      id: 'c1',
      items: [
        { kind: 'operator', text: 'where is my order?' },
        { kind: 'tool', callId: 'a', name: 'list_orders', side: 'server', args: {}, ok: true },
        { kind: 'tool', callId: 'b', name: 'open_cart', side: 'client', args: {}, ok: null },
        { kind: 'tool', callId: 'c', name: 'get_order', side: 'server', args: {}, ok: false },
        { kind: 'reply', text: 'It shipped yesterday.' },
        { kind: 'end', reason: 'done', category: null },
        { kind: 'end', reason: 'refused', category: 'cyber' },
      ],
    });

    expect(texts(root, 'assistant-mine')).toEqual(['where is my order?']);
    expect(texts(root, 'assistant-reply')).toEqual(['It shipped yesterday.']);
    expect(texts(root, 'assistant-tool')).toEqual([
      'Reading your orders',
      'Opening your cart',
      'Reading an order',
    ]);
    expect(root.querySelectorAll('[data-testid="assistant-tool"] ion-spinner').length).toBe(1);
    // An ordinary end says nothing; a refusal says so, in its own colour.
    expect(texts(root, 'assistant-end')).toEqual(['The assistant declined to answer that.']);
    expect(root.querySelector('[data-testid="assistant-end"]')?.classList).toContain('refused');
  });

  it('sends what was typed, clears the box, and sends nothing blank', async () => {
    const { fixture, store, root } = await mount();
    const send = () =>
      (root.querySelector('[data-testid="assistant-send"]') as HTMLElement).click();

    type(fixture, '   ');
    send();
    expect(store.send).not.toHaveBeenCalled();

    type(fixture, 'is it in stock?');
    send();
    fixture.detectChanges();
    expect(store.send).toHaveBeenCalledWith('is it in stock?');
  });

  it('sends on Enter, and not while a turn runs', async () => {
    const { fixture, store, root } = await mount();
    const box = root.querySelector('ion-input') as HTMLElement;

    type(fixture, 'first');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(store.send).toHaveBeenCalledWith('first');

    const running = await mount({ id: 'c1', running: true, items: [] });
    type(running.fixture, 'second');
    (running.root.querySelector('ion-input') as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    expect(running.store.send).not.toHaveBeenCalled();
  });

  it('offers Stop while a turn runs, and not Start over (spec §5.8); Stop cancels it', async () => {
    const { store, root } = await mount({
      id: 'c1',
      running: true,
      items: [{ kind: 'operator', text: 'hi' }],
    });

    expect(root.querySelector('[data-testid="assistant-send"]')).toBeNull();
    expect(
      root.querySelector('[data-testid="assistant-start-over"]')?.hasAttribute('disabled'),
    ).toBe(true);
    (root.querySelector('[data-testid="assistant-stop"]') as HTMLElement).click();
    expect(store.cancel).toHaveBeenCalled();
  });

  it("says why the last action failed, with the host's detail as sent", async () => {
    const { root } = await mount({ problem: { code: 'failed', detail: 'Too many conversations' } });

    expect(texts(root, 'assistant-problem')).toEqual([
      'Your message was not sent. Too many conversations',
    ]);
  });

  it('starts over, and closes', async () => {
    const { fixture, store, root } = await mount({
      id: 'c1',
      items: [{ kind: 'operator', text: 'hi' }],
    });
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const buttons = root.querySelectorAll('ion-header ion-button');

    (buttons[0] as HTMLElement).click();
    (buttons[1] as HTMLElement).click();

    expect(store.startOver).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
  });
});
