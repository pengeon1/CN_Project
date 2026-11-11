/**
 * @fileoverview Decoded-image cache and drawing for image objects.
 *
 * Image bytes arrive separately from the object (IMAGE_DATA chunks) so the board can render the
 * layout immediately with a placeholder and swap the picture in once it is decoded.
 */

import type { ImageObject } from '@cn-whiteboard/common';

const elements = new Map<string, HTMLImageElement>();

/**
 * Returns the decoded element for an asset if it is ready, otherwise starts decoding (once)
 * and returns null. `onReady` fires after decode so the caller can schedule a repaint.
 */
export function getImageElement(
  assetId: string,
  dataUrl: string | undefined,
  onReady: () => void,
): HTMLImageElement | null {
  if (!dataUrl) return null;
  let el = elements.get(assetId);
  if (!el) {
    el = new Image();
    el.onload = onReady;
    el.src = dataUrl;
    elements.set(assetId, el);
  }
  return el.complete && el.naturalWidth > 0 ? el : null;
}

/** Draws an image object, or a neutral placeholder while its bytes are still loading. */
export function renderImage(
  ctx: CanvasRenderingContext2D,
  obj: ImageObject,
  el: HTMLImageElement | null,
): void {
  ctx.save();
  if (el) {
    ctx.drawImage(el, obj.x, obj.y, obj.width, obj.height);
  } else {
    ctx.fillStyle = 'rgba(148,163,184,0.25)';
    ctx.strokeStyle = 'rgba(100,116,139,0.6)';
    ctx.setLineDash([6, 4]);
    ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
    ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
    ctx.setLineDash([]);
    ctx.fillStyle = '#64748B';
    ctx.font = '13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading image…', obj.x + obj.width / 2, obj.y + obj.height / 2);
  }
  ctx.restore();
}
