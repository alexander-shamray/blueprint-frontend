import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { App } from './app';

describe('App', () => {
  it('is the ion-app shell and nothing else — one outlet, no chrome of its own', async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    }).compileComponents();

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const shell: HTMLElement | null = fixture.nativeElement.querySelector('ion-app');
    expect(shell).not.toBeNull();

    // The outlet, asserted rather than assumed. `toBeTruthy()` on the
    // component instance — which is what the CLI scaffold left here — passes
    // with `<router-outlet />` deleted from app.html, and an App that renders
    // no outlet renders no application at all: every screen in this client is
    // reached through a route (app.routes.ts), so this one element is the
    // whole of what this component contributes.
    expect(shell!.querySelector('router-outlet')).not.toBeNull();

    // And it is INSIDE ion-app rather than beside it: Ionic's page transitions,
    // the tab stack and the back button all read the shell as their host, so an
    // outlet outside it renders pages that Ionic never animates or caches.
    expect(fixture.nativeElement.children).toHaveLength(1);
  });
});
