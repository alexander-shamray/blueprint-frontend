import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SkeletonListComponent } from './skeleton-list.component';

describe('SkeletonListComponent', () => {
  it('renders the rows it is asked for, marked busy and hidden from a screen reader', async () => {
    const fixture = TestBed.createComponent(SkeletonListComponent);
    fixture.componentRef.setInput('rows', 3);
    fixture.detectChanges();
    await fixture.whenStable();

    const list: HTMLElement = fixture.nativeElement.querySelector('ion-list');
    const rows = fixture.nativeElement.querySelectorAll('ion-item');

    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(rows).toHaveLength(3);
    expect([...rows].every((row) => (row as HTMLElement).getAttribute('aria-hidden') === 'true'))
      .toBe(true);
  });
});
