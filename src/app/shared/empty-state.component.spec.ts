import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { EmptyStateComponent } from './empty-state.component';

@Component({
  standalone: true,
  imports: [EmptyStateComponent],
  template: `
    <app-empty-state heading="Nothing here" message="Try later.">
      <a href="/elsewhere">Go</a>
    </app-empty-state>
  `,
})
class HostComponent {}

describe('EmptyStateComponent', () => {
  it('says what is empty and projects the way out', async () => {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Nothing here');
    expect(text).toContain('Try later.');
    expect(fixture.nativeElement.querySelector('a[href="/elsewhere"]')).not.toBeNull();
  });

  it('leaves the message out when none was given', async () => {
    const fixture = TestBed.createComponent(EmptyStateComponent);
    fixture.componentRef.setInput('heading', 'Nothing here');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('p')).toBeNull();
  });
});
