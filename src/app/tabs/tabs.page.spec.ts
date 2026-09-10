import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { AuthService } from '@core/auth/auth.service';
import { TabsPage } from './tabs.page';

function mount(permissions: readonly string[]): ComponentFixture<TabsPage> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TabsPage],
    providers: [
      provideRouter([]),
      {
        provide: AuthService,
        useValue: {
          hasPermission: (n: string) => permissions.includes(n),
          user: () => signal(null),
        },
      },
    ],
  });

  const fixture = TestBed.createComponent(TabsPage);
  fixture.detectChanges();
  return fixture;
}

describe('TabsPage', () => {
  it('shows three tabs to a user holding no permissions', () => {
    const tabs = mount([]).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'account',
    ]);
  });

  it('adds the publish tab for a holder of catalog:write', () => {
    const tabs = mount(['catalog:write']).nativeElement.querySelectorAll('ion-tab-button');

    expect([...tabs].map((t: Element) => t.getAttribute('tab'))).toEqual([
      'products',
      'cart',
      'publish',
      'account',
    ]);
  });
});
