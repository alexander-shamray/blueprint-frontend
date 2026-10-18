import { TestBed } from '@angular/core/testing';
import { CameraErrorCode, MediaResult, MediaType, MediaTypeSelection } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { ActionSheetController } from '@ionic/angular';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAMERA,
  CameraPlugin,
  ImagePickError,
  ImageSource,
  NativeImageSource,
  READ_PHOTO,
  WebImageSource,
} from './image-source';

describe('ImageSource', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is the web strategy in a browser', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    expect(TestBed.inject(ImageSource)).toBeInstanceOf(WebImageSource);
  });

  it('is the native strategy in either shell', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    expect(TestBed.inject(ImageSource)).toBeInstanceOf(NativeImageSource);
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

  describe('NativeImageSource', () => {
    const PATH = 'https://localhost/_capacitor_file_/data/cache/IMG_0001.jpg';
    const photo = (): MediaResult => ({ type: MediaType.Photo, saved: false, webPath: PATH });

    /**
     * The source with the sheet answered by `choice`, the plugin and the read
     * replaced. `choice` is the button's `data`, undefined for a dismissal.
     */
    function source(
      choice: 'camera' | 'library' | undefined,
      camera: Partial<CameraPlugin> = {},
      read: (webPath: string) => Promise<Blob> = async () =>
        new Blob(['jpeg'], { type: 'image/jpeg' }),
    ) {
      const create = vi.fn(async () => ({
        present: async () => undefined,
        onDidDismiss: async () => ({ data: choice }),
      }));
      const plugin = {
        takePhoto: vi.fn(async () => photo()),
        chooseFromGallery: vi.fn(async () => ({ results: [photo()] })),
        ...camera,
      };
      const readPhoto = vi.fn(read);
      TestBed.configureTestingModule({
        providers: [
          { provide: ActionSheetController, useValue: { create } },
          { provide: CAMERA, useValue: plugin },
          { provide: READ_PHOTO, useValue: readPhoto },
        ],
      });
      return { source: TestBed.inject(NativeImageSource), create, plugin, readPhoto };
    }

    /** What the plugin rejects with: a `CapacitorException`'s shape. */
    const rejecting = (code: string) => vi.fn(async () => Promise.reject({ code, message: code }));

    it('asks camera or library first, with a cancel', async () => {
      const { source: native, create } = source(undefined);
      await native.pick();

      const buttons = (
        create.mock.calls[0] as unknown as [{ buttons: { text: string; role?: string }[] }]
      )[0].buttons;
      expect(buttons.map((b) => b.text)).toEqual(['Take a photo', 'Choose from library', 'Cancel']);
      expect(buttons[2].role).toBe('cancel');
    });

    it('answers null, and opens neither, when the sheet is dismissed', async () => {
      const { source: native, plugin } = source(undefined);

      expect(await native.pick()).toBeNull();
      expect(plugin.takePhoto).not.toHaveBeenCalled();
      expect(plugin.chooseFromGallery).not.toHaveBeenCalled();
    });

    it('takes a photo and answers with its bytes, named and typed as the WebView serves them', async () => {
      const { source: native, plugin, readPhoto } = source('camera');
      const file = await native.pick();

      expect(plugin.takePhoto).toHaveBeenCalledWith({ quality: 90 });
      expect(readPhoto).toHaveBeenCalledWith(PATH);
      expect(file).toBeInstanceOf(File);
      expect(file?.name).toBe('IMG_0001.jpg');
      expect(file?.type).toBe('image/jpeg');
      expect(file?.size).toBe(4);
    });

    it('chooses one photo from the library, never a video', async () => {
      const { source: native, plugin } = source('library');
      const file = await native.pick();

      expect(plugin.chooseFromGallery).toHaveBeenCalledWith({
        mediaType: MediaTypeSelection.Photo,
        quality: 90,
      });
      expect(file?.name).toBe('IMG_0001.jpg');
    });

    it('answers null when the library comes back empty or the photo has no path', async () => {
      expect(
        await source('library', {
          chooseFromGallery: vi.fn(async () => ({ results: [] })),
        }).source.pick(),
      ).toBeNull();
      TestBed.resetTestingModule();
      expect(
        await source('camera', {
          takePhoto: vi.fn(async () => ({ ...photo(), webPath: undefined })),
        }).source.pick(),
      ).toBeNull();
    });

    it('reads backing out of the camera or the library as a dismissal', async () => {
      expect(
        await source('camera', {
          takePhoto: rejecting(CameraErrorCode.TakePhotoCancelled),
        }).source.pick(),
      ).toBeNull();
      TestBed.resetTestingModule();
      expect(
        await source('library', {
          chooseFromGallery: rejecting(CameraErrorCode.ChooseMediaCancelled),
        }).source.pick(),
      ).toBeNull();
    });

    it.each([
      [CameraErrorCode.CameraPermissionDenied, 'may not use the camera'],
      [CameraErrorCode.GalleryPermissionDenied, 'may not open your photos'],
      [CameraErrorCode.NoCameraAvailable, 'no camera'],
      [CameraErrorCode.TakePhotoFailed, 'could not be read'],
    ])('rejects %s with a sentence the page can show', async (code, sentence) => {
      const picked = source('camera', { takePhoto: rejecting(code) }).source.pick();

      await expect(picked).rejects.toBeInstanceOf(ImagePickError);
      await expect(picked).rejects.toThrow(sentence);
    });

    it('rejects anything without a code as a failed read too', async () => {
      const picked = source('camera', {
        takePhoto: vi.fn(async () => Promise.reject(new Error('bridge'))),
      }).source.pick();

      await expect(picked).rejects.toThrow(ImagePickError);
    });

    it('hands the injector plain functions, so the plugin proxy is never taken for a service', () => {
      const camera = TestBed.inject(CAMERA);

      expect(Object.keys(camera)).toEqual(['takePhoto', 'chooseFromGallery']);
      expect('ngOnDestroy' in camera).toBe(false);
    });

    it('reads the bytes back from the path the WebView serves', async () => {
      const blob = new Blob(['jpeg'], { type: 'image/jpeg' });
      // A plain answer rather than a `Response`: Node's will not take jsdom's Blob.
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ blob: async () => blob } as unknown as Response);

      const read = await TestBed.inject(READ_PHOTO)(PATH);

      expect(fetch).toHaveBeenCalledWith(PATH);
      expect(read).toBe(blob);
    });

    it('rejects a photo whose bytes cannot be read back', async () => {
      const picked = source('camera', {}, async () =>
        Promise.reject(new TypeError('fetch')),
      ).source.pick();

      await expect(picked).rejects.toThrow('could not be read');
    });
  });
});
