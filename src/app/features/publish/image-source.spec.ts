import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageSource, WebImageSource } from './image-source';

describe('ImageSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is the web strategy wherever nothing else is provided', () => {
    expect(TestBed.inject(ImageSource)).toBeInstanceOf(WebImageSource);
  });

  describe('WebImageSource', () => {
    /** The input `pick()` attached, caught at its click so the test can answer for the user. */
    function opened(): Promise<HTMLInputElement> {
      return new Promise((resolve) => {
        vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
          this: HTMLInputElement,
        ) {
          resolve(this);
        });
      });
    }

    it('opens an image chooser in the document and answers with the chosen file', async () => {
      const source = TestBed.inject(WebImageSource);
      const input = opened();
      const picked = source.pick();
      const element = await input;

      expect(element.type).toBe('file');
      expect(element.accept).toBe('image/*');
      expect(element.isConnected).toBe(true);

      const file = new File(['abcd'], 'lamp.png', { type: 'image/png' });
      Object.defineProperty(element, 'files', { value: { item: () => file } });
      element.dispatchEvent(new Event('change'));

      expect(await picked).toBe(file);
      expect(element.isConnected).toBe(false);
    });

    it('answers null when the change carries no file', async () => {
      const source = TestBed.inject(WebImageSource);
      const input = opened();
      const picked = source.pick();
      const element = await input;

      Object.defineProperty(element, 'files', { value: { item: () => null } });
      element.dispatchEvent(new Event('change'));

      expect(await picked).toBeNull();
    });

    it('answers null, and removes the input, when the chooser is dismissed', async () => {
      const source = TestBed.inject(WebImageSource);
      const input = opened();
      const picked = source.pick();
      const element = await input;

      element.dispatchEvent(new Event('cancel'));

      expect(await picked).toBeNull();
      expect(element.isConnected).toBe(false);
    });
  });
});
