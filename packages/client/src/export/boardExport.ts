/**
 * @fileoverview Exports the whole board (not just the visible viewport) as PNG or PDF by
 * re-rendering every object onto an offscreen canvas with the same renderers the live canvas uses.
 */

import type { WhiteboardObject } from '@cn-whiteboard/common';
import { renderStroke } from '../components/canvas/WhiteboardCanvas.js';
import { renderImage } from '../components/canvas/images.js';
import { getBounds, renderShape } from '../components/canvas/shapes.js';
import { useWhiteboardStore } from '../store/useWhiteboardStore.js';
import { buildPdfFromJpeg } from './pdf.js';

const PADDING = 40;
const MAX_EXPORT_PIXELS = 8192;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
}

/**
 * Renders all objects, cropped to their combined bounds plus padding, on a white background.
 * Returns null for an empty board.
 */
export async function renderBoardToCanvas(
  objects: Record<string, WhiteboardObject>,
  imageData: Record<string, string>,
): Promise<HTMLCanvasElement | null> {
  const list = Object.values(objects).sort((a, b) => a.zIndex - b.zIndex);
  if (list.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const obj of list) {
    const b = getBounds(obj);
    const grow = obj.type === 'stroke' ? obj.width : obj.type === 'shape' ? obj.strokeWidth : 0;
    minX = Math.min(minX, b.x - grow);
    minY = Math.min(minY, b.y - grow);
    maxX = Math.max(maxX, b.x + b.w + grow);
    maxY = Math.max(maxY, b.y + b.h + grow);
  }
  const w = maxX - minX + PADDING * 2;
  const h = maxY - minY + PADDING * 2;
  const scale = Math.min(2, MAX_EXPORT_PIXELS / Math.max(w, h));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(PADDING - minX, PADDING - minY);

  for (const obj of list) {
    if (obj.type === 'stroke') renderStroke(ctx, obj);
    else if (obj.type === 'shape') renderShape(ctx, obj);
    else {
      const url = imageData[obj.assetId];
      renderImage(ctx, obj, url ? await loadImage(url) : null);
    }
  }
  return canvas;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function fileBase(): string {
  const room = useWhiteboardStore.getState().roomInfo;
  return `whiteboard-${room?.code ?? 'board'}`;
}

function notify(message: string): void {
  useWhiteboardStore.setState({ persistenceStatus: message });
}

/** Saves the board as a PNG file (Electron shows its save dialog for downloads). */
export async function exportBoardPng(): Promise<void> {
  const { objects, imageData } = useWhiteboardStore.getState();
  const canvas = await renderBoardToCanvas(objects, imageData);
  if (!canvas) return notify('Nothing to export: the board is empty.');
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return notify('Could not render the board.');
  download(blob, `${fileBase()}.png`);
  notify('Exported board as PNG.');
}

/** Saves the board as a one-page PDF sized to the board's content. */
export async function exportBoardPdf(): Promise<void> {
  const { objects, imageData } = useWhiteboardStore.getState();
  const canvas = await renderBoardToCanvas(objects, imageData);
  if (!canvas) return notify('Nothing to export: the board is empty.');
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) return notify('Could not render the board.');
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  // 1 canvas px = 0.5 pt (canvas is rendered at 2x), giving ~1 pt per board unit.
  const pdf = buildPdfFromJpeg(
    jpeg,
    canvas.width,
    canvas.height,
    Math.round(canvas.width / 2),
    Math.round(canvas.height / 2),
  );
  download(new Blob([pdf as BlobPart], { type: 'application/pdf' }), `${fileBase()}.pdf`);
  notify('Exported board as PDF.');
}
