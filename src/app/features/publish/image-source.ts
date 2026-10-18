import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Camera, CameraErrorCode, MediaResult, MediaTypeSelection } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { ActionSheetController } from '@ionic/angular';

/**
 * Where Publish gets an image from: one interface, in the way `AuthService`
 * has two strategies behind one. The page asks for a file and does not know
 * whether a file input, a camera or a photo library answered.
 *
 * `WebImageSource` serves the web build and `NativeImageSource` both native
 * shells, chosen by the same `isNativePlatform()` that chooses the auth
 * strategy. A file input would also answer on Android, where the WebView
 * offers the system picker; the native one is used there too so that both
 * shells take a photo the same way, and so that a refused permission reaches
 * the seller as a sentence rather than as a chooser that does nothing.
 */
@Injectable({
  providedIn: 'root',
  useFactory: () =>
    Capacitor.isNativePlatform() ? inject(NativeImageSource) : inject(WebImageSource),
})
export abstract class ImageSource {
  /**
   * The file the user chose, or null when they dismissed the chooser. Rejects
   * with an `ImagePickError` when the device refused or failed to give an
   * image, which a strategy says as a sentence; any other rejection is a
   * defect in the strategy, which the page lets through rather than showing.
   */
  abstract pick(): Promise<File | null>;
}

/**
 * The device refused or failed to give an image (a denied permission, no
 * camera, a photo that could not be read), said in a sentence the page shows
 * as it is.
 */
export class ImagePickError extends Error {
  override readonly name = 'ImagePickError';
}

/**
 * A file input that is never rendered. Attached for the length of the choice,
 * because a WebView may not open a chooser for an input outside the document,
 * and removed when a file is chosen or the choice is cancelled.
 *
 * `accept` is `image/*` and not the BFF's closed list: the list is the
 * server's, which answers anything outside it with a 400 keyed `ContentType`
 * that the form shows under the image (#82). A second copy here would be the
 * copy that drifts.
 *
 * A browser with no `cancel` event leaves a dismissed chooser's promise
 * pending, and its hidden input in the document. Nothing waits on the
 * promise: the page shows no state for a choice in progress, so an unanswered
 * pick is a pick that did nothing, at the cost of one empty input per
 * dismissal until the page is reloaded.
 */
@Injectable({ providedIn: 'root' })
export class WebImageSource extends ImageSource {
  private readonly document = inject(DOCUMENT);

  pick(): Promise<File | null> {
    const input = this.document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    this.document.body.append(input);

    return new Promise<File | null>((resolve) => {
      const settle = (file: File | null) => {
        input.remove();
        resolve(file);
      };
      input.addEventListener('change', () => settle(input.files?.item(0) ?? null), { once: true });
      input.addEventListener('cancel', () => settle(null), { once: true });
      input.click();
    });
  }
}

/** The two members of `@capacitor/camera` the native strategy drives. */
export type CameraPlugin = Pick<typeof Camera, 'takePhoto' | 'chooseFromGallery'>;

/**
 * The plugin behind a token and inside a plain object, as `SECURE_STORAGE`
 * is. A registered plugin is a proxy that answers every property name with a
 * method, `ngOnDestroy` included, so handed to the injector bare it reads as a
 * service with a destroy hook, and the call at teardown is refused as
 * `UNIMPLEMENTED`.
 */
export const CAMERA = new InjectionToken<CameraPlugin>('CAMERA', {
  factory: (): CameraPlugin => ({
    takePhoto: (options) => Camera.takePhoto(options),
    chooseFromGallery: (options) => Camera.chooseFromGallery(options),
  }),
});

/** How the image's bytes are read back from the path the plugin answers with. */
export const READ_PHOTO = new InjectionToken<(webPath: string) => Promise<Blob>>('READ_PHOTO', {
  factory: () => async (webPath) => (await fetch(webPath)).blob(),
});

/** Every refusal the plugin names, as the sentence the seller reads. */
const REFUSALS: Partial<Record<string, string>> = {
  [CameraErrorCode.CameraPermissionDenied]:
    'Blueprint may not use the camera. Allow it in Settings, or choose from the library.',
  [CameraErrorCode.GalleryPermissionDenied]:
    'Blueprint may not open your photos. Allow it in Settings, or take a photo.',
  [CameraErrorCode.NoCameraAvailable]: 'This device has no camera. Choose from the library.',
};

/** The seller backing out, which is a dismissal and not a refusal. */
const CANCELLED: readonly string[] = [
  CameraErrorCode.TakePhotoCancelled,
  CameraErrorCode.ChooseMediaCancelled,
];

/**
 * The camera or the photo library, asked in an action sheet and answered by
 * `@capacitor/camera`. The plugin's own prompt is `getPhoto`, deprecated in
 * 8.1 in favour of `takePhoto` and `chooseFromGallery` with the choice left to
 * the app, so the sheet is that choice.
 *
 * The plugin answers with a path the WebView serves (`webPath`), not with
 * bytes, so the photo is read back from it into the `File` the upload sends;
 * its type is whatever the WebView serves it as, and the BFF's closed list
 * judges it (#82). Nothing is saved to the gallery, which is why Android
 * declares no permission for this (the plugin's README asks for storage ones
 * only with `saveToGallery`), and why `Info.plist` holds no
 * `NSPhotoLibraryAddUsageDescription`.
 */
@Injectable({ providedIn: 'root' })
export class NativeImageSource extends ImageSource {
  private readonly sheets = inject(ActionSheetController);
  private readonly camera = inject(CAMERA);
  private readonly readPhoto = inject(READ_PHOTO);

  async pick(): Promise<File | null> {
    const sheet = await this.sheets.create({
      header: 'Add an image',
      buttons: [
        { text: 'Take a photo', data: 'camera' },
        { text: 'Choose from library', data: 'library' },
        { text: 'Cancel', role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data: from } = await sheet.onDidDismiss<'camera' | 'library'>();
    if (from !== 'camera' && from !== 'library') return null;

    let photo: MediaResult | undefined;
    try {
      photo =
        from === 'camera'
          ? await this.camera.takePhoto({ quality: 90 })
          : (
              await this.camera.chooseFromGallery({
                mediaType: MediaTypeSelection.Photo,
                quality: 90,
              })
            ).results[0];
    } catch (error) {
      const code = errorCode(error);
      if (code !== null && CANCELLED.includes(code)) return null;
      throw new ImagePickError(
        (code !== null && REFUSALS[code]) || 'The image could not be read. Try again.',
      );
    }
    if (photo?.webPath === undefined) return null;

    let bytes: Blob;
    try {
      bytes = await this.readPhoto(photo.webPath);
    } catch {
      throw new ImagePickError('The image could not be read. Try again.');
    }
    const name = photo.webPath.split('/').pop() || 'photo';
    return new File([bytes], name, { type: bytes.type });
  }
}

/** The plugin rejects with a `CapacitorException`, whose `code` names the refusal. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
