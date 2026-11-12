/**
 * @fileoverview Client-side image preparation: validates, downscales and re-encodes a picked,
 * dropped or pasted file so it fits the protocol limits before any byte is sent.
 */

import { generateUuid, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../../store/useWhiteboardStore.js';

/** Scales (w, h) down, never up, so the longer side is at most `max`. */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export interface PreparedImage {
  mime: 'image/png' | 'image/jpeg';
  base64: string;
  bytes: number;
  width: number;
  height: number;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mime, quality));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Decodes the file, downscales it to MAX_IMAGE_DIMENSION and encodes it under MAX_IMAGE_BYTES:
 * PNG when the source is PNG and small enough (keeps transparency), otherwise JPEG with
 * progressively lower quality and, as a last resort, smaller dimensions.
 *
 * @throws Error with a user-presentable message when the file is not a usable image.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!/^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.type)) {
    throw new Error('Only PNG, JPEG, WebP, GIF and BMP images can be inserted.');
  }
  if (file.size > 25 * 1024 * 1024) throw new Error('That image is too large (25 MB limit).');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image.');
  }

  let { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_IMAGE_DIMENSION);
  const canvas = document.createElement('canvas');
  for (let attempt = 0; attempt < 6; attempt++) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable.');
    ctx.clearRect(0, 0, width, height);

    if (file.type === 'image/png') {
      ctx.drawImage(bitmap, 0, 0, width, height);
      const png = await toBlob(canvas, 'image/png');
      if (png && png.size <= MAX_IMAGE_BYTES) {
        return {
          mime: 'image/png',
          base64: await blobToBase64(png),
          bytes: png.size,
          width,
          height,
        };
      }
    }
    // JPEG has no alpha, so flatten onto white first.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const q of [0.88, 0.72, 0.55]) {
      const jpg = await toBlob(canvas, 'image/jpeg', q);
      if (jpg && jpg.size <= MAX_IMAGE_BYTES) {
        return {
          mime: 'image/jpeg',
          base64: await blobToBase64(jpg),
          bytes: jpg.size,
          width,
          height,
        };
      }
    }
    ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.75)));
  }
  throw new Error('Could not shrink that image enough to share it.');
}

/**
 * Prepares and inserts an image centred at world point `at` (default: the middle of the view).
 * Failures are surfaced through the store's notice dialog.
 */
export async function insertImageFile(file: File, at?: { x: number; y: number }): Promise<void> {
  const store = useWhiteboardStore.getState();
  try {
    const img = await prepareImage(file);
    const { zoom, panX, panY } = useWhiteboardStore.getState();
    const center = at ?? {
      x: window.innerWidth / 2 / zoom - panX,
      y: window.innerHeight / 2 / zoom - panY,
    };
    const ok = store.addImage({
      assetId: generateUuid(),
      mime: img.mime,
      base64: img.base64,
      bytes: img.bytes,
      width: img.width,
      height: img.height,
      centerX: center.x,
      centerY: center.y,
    });
    if (ok) {
      useWhiteboardStore.setState({ activeTool: 'select' });
    } else {
      useWhiteboardStore.setState({
        accessNotice: {
          title: 'Cannot insert image',
          message: 'Join a room with edit access to insert images.',
        },
      });
    }
  } catch (error) {
    useWhiteboardStore.setState({
      accessNotice: {
        title: 'Cannot insert image',
        message: error instanceof Error ? error.message : 'Unknown error.',
      },
    });
  }
}
