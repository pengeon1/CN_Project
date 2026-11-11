/**
 * @fileoverview Phase 13 client logic: PDF writer structure, image fitting, IMAGE_ADD replay.
 */
import { describe, expect, it } from 'vitest';
import {
  generateUuid,
  MessageType,
  type ImageObject,
  type SequencedOperation,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { buildPdfFromJpeg } from '../src/export/pdf.js';
import { fitWithin } from '../src/components/canvas/imageInsert.js';
import { applySequencedOpToObjects } from '../src/store/useWhiteboardStore.js';
import { hitTest, moveChanges } from '../src/components/canvas/shapes.js';

describe('PDF writer', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const pdf = buildPdfFromJpeg(jpeg, 40, 20, 20, 10);
  const text = Buffer.from(pdf).toString('latin1');

  it('is a well-formed document that embeds the JPEG bytes verbatim', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/MediaBox [0 0 20 10]');
    expect(Buffer.from(pdf).includes(Buffer.from(jpeg))).toBe(true);
  });

  it('has an xref table whose offsets point at each object', () => {
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });
});

describe('images on the client', () => {
  it('fits within a limit without ever upscaling', () => {
    expect(fitWithin(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(100, 50, 1600)).toEqual({ width: 100, height: 50 });
  });

  const img: ImageObject = {
    id: generateUuid(),
    authorId: generateUuid(),
    seq: 1,
    zIndex: 1,
    updatedAt: 1,
    type: 'image',
    assetId: generateUuid(),
    mime: 'image/png',
    bytes: 10,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  };

  it('replays IMAGE_ADD and moves/resizes images through OBJECT_UPDATE', () => {
    const objects: Record<string, WhiteboardObject> = {};
    const op = (type: MessageType, seq: number, payload: unknown): SequencedOperation => ({
      seq,
      type,
      op_id: generateUuid(),
      userId: img.authorId,
      ts: seq,
      payload,
    });
    applySequencedOpToObjects(objects, op(MessageType.IMAGE_ADD, 3, { op_id: 'x', object: img }));
    expect(objects[img.id]?.seq).toBe(3);
    applySequencedOpToObjects(
      objects,
      op(MessageType.OBJECT_UPDATE, 4, { id: img.id, changes: { x: 40, width: 300 } }),
    );
    expect(objects[img.id]).toMatchObject({ x: 40, width: 300, height: 50 });
    expect(moveChanges(img, 5, 5)).toEqual({ x: 5, y: 5 });
    expect(hitTest(img, 50, 25, 2)).toBe(true);
    expect(hitTest(img, 500, 25, 2)).toBe(false);
  });
});
