import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { ClientLog, ClientLogEvent } from './client-log';
import { provideClientLog } from './client-log.providers';

@Component({ template: '' })
class Blank {}

describe('provideClientLog', () => {
  it('records each completed navigation as the path it landed on, never its query', async () => {
    const events: ClientLogEvent[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', redirectTo: 'tabs/products', pathMatch: 'full' },
          { path: 'tabs/products', component: Blank },
        ]),
        provideClientLog(),
        { provide: ClientLog, useValue: { record: (event: ClientLogEvent) => events.push(event) } },
      ],
    });
    await TestBed.inject(Router).navigateByUrl('/?code=auth-code&state=s');

    expect(events).toEqual([{ kind: 'navigation', path: '/tabs/products' }]);
    expect(JSON.stringify(events)).not.toContain('auth-code');
  });
});
