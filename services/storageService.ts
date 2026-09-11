import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { supabase } from './supabase';
import { Logger } from './logger';

/**
 * Ceiling enforced by the bucket itself (`file_size_limit`, 5 MB). Checked here
 * too so an oversized photo is a sentence the user can act on rather than an
 * opaque 413 from storage.
 */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Long edge, in pixels, that a photo is resized to before upload.
 *
 * 1600px is comfortably enough for a reviewer to read a menu board off, and for
 * Gemini to read one. It also keeps the upload — which is buffered three times
 * over on the JS heap (base64 string, decoded binary string, Uint8Array) — well
 * clear of the multi-megabyte originals a modern phone camera produces, which
 * is what made this path an out-of-memory risk on low-end Android.
 */
const MAX_IMAGE_EDGE = 1600;

export class ImageTooLargeError extends Error {
  constructor() {
    super('Image is larger than 5MB');
    this.name = 'ImageTooLargeError';
  }
}

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
};

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Shrink the long edge to MAX_IMAGE_EDGE and re-encode as JPEG.
 *
 * Resizing is skipped when the photo is already small enough, and when its
 * dimensions are unknown. Passing a bare `width` to `manipulateAsync` scales to
 * that width whichever way the aspect ratio runs, so resizing unconditionally
 * would *enlarge* an already-modest portrait shot — producing a bigger upload
 * than the original, which is the opposite of the point.
 *
 * A failure here is not fatal: fall back to the original file and let the size
 * check decide. Losing the photo is a worse outcome than uploading a larger one.
 */
const downscale = async (
  localUri: string,
  dimensions?: ImageDimensions,
): Promise<{ uri: string; isJpeg: boolean }> => {
  const longEdge = dimensions ? Math.max(dimensions.width, dimensions.height) : 0;
  if (!dimensions || longEdge <= MAX_IMAGE_EDGE) {
    return { uri: localUri, isJpeg: false };
  }

  const isLandscape = dimensions.width >= dimensions.height;

  try {
    const result = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: isLandscape ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
    );
    return { uri: result.uri, isJpeg: true };
  } catch {
    Logger.warn('[storageService] Could not downscale image; uploading as-is');
    return { uri: localUri, isJpeg: false };
  }
};

/**
 * The bucket's MIME allowlist is checked against the declared content type, so
 * declaring `image/jpeg` for every upload would store a PNG under a lie. Only
 * the three types the bucket accepts are possible here; anything else is sent
 * as JPEG, which is what the picker produces by default.
 */
const typeForExtension = (uri: string): { extension: string; contentType: string } => {
  const extension = uri.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'png') return { extension: 'png', contentType: 'image/png' };
  if (extension === 'webp') return { extension: 'webp', contentType: 'image/webp' };
  return { extension: 'jpg', contentType: 'image/jpeg' };
};

export const storageService = {
  /**
   * Upload an image to the venue-images bucket
   * @param fileName The name of the file
   * @param fileData The file content/blob to upload
   * @param contentType The mime type of the file
   */
  async uploadVenueImage(fileName: string, fileData: any, contentType: string = 'image/jpeg') {
    const { data, error } = await supabase.storage
      .from('venue-images')
      .upload(fileName, fileData, {
        contentType,
        upsert: false
      });

    if (error) {
      Logger.error('Error uploading image', error);
      throw error;
    }

    return data;
  },

  /**
   * Get the public URL for an image in the venue-images bucket
   * @param path The path/filename in the bucket
   */
  getVenueImageUrl(path: string): string {
    const { data } = supabase.storage
      .from('venue-images')
      .getPublicUrl(path);

    return data.publicUrl;
  },

  /**
   * Helper to upload a local file URI (from image picker) to Supabase Storage.
   * Reads the file as base64 and uploads an ArrayBuffer because Supabase
   * Storage FormData uploads do not work reliably in React Native.
   *
   * Objects are written to `<uid>/<file>`. The bucket's INSERT policy requires
   * the first path segment to be the uploader's own id — which is also what
   * makes the owner-scoped DELETE policy expressible, so a photo can be taken
   * back. The previous shared `user-submitted/` prefix belonged to nobody and
   * could therefore never be cleaned up by anyone.
   */
  async uploadLocalImage(localUri: string, dimensions?: ImageDimensions): Promise<string> {
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData?.user) {
        throw new Error('Cannot upload an image without a signed-in user');
      }

      const downscaled = await downscale(localUri, dimensions);
      const { extension, contentType } = downscaled.isJpeg
        ? { extension: 'jpg', contentType: 'image/jpeg' }
        : typeForExtension(downscaled.uri);

      const fileName = `${Math.random().toString(36).substring(2)}-${Date.now()}.${extension}`;
      const filePath = `${authData.user.id}/${fileName}`;

      const base64Data = await FileSystem.readAsStringAsync(downscaled.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      // base64 carries 3 bytes per 4 characters; padding costs at most 2 bytes.
      const approximateBytes = Math.floor((base64Data.length * 3) / 4);
      if (approximateBytes > MAX_UPLOAD_BYTES) {
        throw new ImageTooLargeError();
      }

      const imageBuffer = base64ToArrayBuffer(base64Data);

      const { error } = await supabase.storage
        .from('venue-images')
        .upload(filePath, imageBuffer, {
          contentType,
          upsert: false,
        });

      if (error) throw error;

      return this.getVenueImageUrl(filePath);
    } catch (e) {
      Logger.error('Error in uploadLocalImage', e);
      throw e;
    }
  },

  /**
   * Remove a previously uploaded photo, given the public URL returned by
   * `uploadLocalImage`.
   *
   * Best-effort: a failure is logged and swallowed. The caller is discarding
   * the photo either way, and an orphaned object is a tidiness problem, not a
   * reason to block the user. Only the uploader's own objects can be removed —
   * the bucket's DELETE policy scopes on the `<uid>/` prefix.
   */
  async deleteVenueImage(publicUrl: string): Promise<void> {
    try {
      const marker = '/venue-images/';
      const index = publicUrl.indexOf(marker);
      if (index < 0) return;

      const path = publicUrl.slice(index + marker.length).split('?')[0];
      if (!path) return;

      const { error } = await supabase.storage.from('venue-images').remove([path]);
      if (error) throw error;
    } catch {
      Logger.warn('[storageService] Could not delete venue image; leaving it in place');
    }
  }
};
