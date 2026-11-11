/**
 * @fileoverview Phase 12 client logic: log replay of shape operations and geometry helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  generateUuid,
  MessageType,
  type SequencedOperation,
  type ShapeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { applySequencedOpToObjects } from '../src/store/useWhiteboardStore.js';
import {
  colorChanges,
  getBounds,
  hitTest,
  lighten,
  moveChanges,
  pickHandle,
  pickTopmost,
  resizeChanges,
  stickyFill,
} from '../src/components/canvas/shapes.js';

const uid = generateUuid();
const mk = (over: Partial<ShapeObject> = {}): ShapeObject => ({
  id: generateUuid(),
  authorId: uid,
  seq: 1,
  zIndex: 1,
  updatedAt: 1,
  type: 'shape',
  shapeType: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  strokeColor: '#000000',
  strokeWidth: 2,
  ...over,
});
const op = (type: MessageType, seq: number, payload: unknown): SequencedOperation => ({
  seq,
  type,
  op_id: generateUuid(),
  userId: uid,
  ts: seq,
  payload,
});

describe('Phase 12 client', () => {
  it('replays add, update and delete deterministically in seq order', () => {
    const s = mk();
    const objects: Record<string, WhiteboardObject> = {};
    applySequencedOpToObjects(objects, op(MessageType.SHAPE_ADD, 5, { op_id: 'a', object: s }));
    applySequencedOpToObjects(
      objects,
      op(MessageType.OBJECT_UPDATE, 6, { id: s.id, changes: { x: 50, fillColor: '#FFFFFF' } }),
    );
    applySequencedOpToObjects(
      objects,
      op(MessageType.OBJECT_UPDATE, 7, { id: s.id, changes: { x: 90, fillColor: null } }),
    );
    const out = objects[s.id] as ShapeObject;
    expect(out.x).toBe(90);
    expect(out.fillColor).toBeUndefined();
    expect(out.seq).toBe(7);
    applySequencedOpToObjects(objects, op(MessageType.OBJECT_DELETE, 8, { id: s.id }));
    expect(objects[s.id]).toBeUndefined();
    // update of a missing object is a harmless no-op
    applySequencedOpToObjects(
      objects,
      op(MessageType.OBJECT_UPDATE, 9, { id: s.id, changes: { x: 1 } }),
    );
    expect(objects[s.id]).toBeUndefined();
  });

  it('hit-tests outlines for unfilled boxes and bodies for filled/sticky ones', () => {
    const hollow = mk();
    expect(hitTest(hollow, 50, 30, 4)).toBe(false);
    expect(hitTest(hollow, 0, 30, 4)).toBe(true);
    expect(hitTest({ ...hollow, fillColor: '#FFFFFF' }, 50, 30, 4)).toBe(true);
    expect(hitTest(mk({ shapeType: 'sticky_note' }), 50, 30, 4)).toBe(true);
    const line = mk({ shapeType: 'arrow', width: 100, height: 100 });
    expect(hitTest(line, 50, 50, 4)).toBe(true);
    expect(hitTest(line, 50, 80, 4)).toBe(false);
  });

  it('picks the topmost object and normalizes bounds of reversed lines', () => {
    const low = mk({ zIndex: 1, fillColor: '#FFFFFF' });
    const high = mk({ zIndex: 2, fillColor: '#FFFFFF' });
    expect(pickTopmost({ [low.id]: low, [high.id]: high }, 10, 10, 2)?.id).toBe(high.id);
    expect(getBounds(mk({ shapeType: 'line', x: 100, y: 100, width: -40, height: -20 }))).toEqual({
      x: 60,
      y: 80,
      w: 40,
      h: 20,
    });
  });

  it('computes move/resize/color changes as absolute values', () => {
    const s = mk();
    expect(moveChanges(s, 10, 5)).toEqual({ x: 10, y: 5 });
    expect(resizeChanges(s, 'se', 200, 150)).toEqual({ x: 0, y: 0, width: 200, height: 150 });
    expect(resizeChanges(s, 'nw', 500, 500)).toMatchObject({ width: 12, height: 12 }); // min size
    expect(pickHandle(s, 100, 60, 1)).toBe('se');
    expect(pickHandle(s, 50, 30, 1)).toBeNull();
    expect(colorChanges(mk({ shapeType: 'sticky_note' }), '#EF4444')).toEqual({
      strokeColor: '#EF4444',
      fillColor: stickyFill('#EF4444'),
    });
    expect(stickyFill('#000000')).toBe('#FDE68A');
    expect(lighten('#000000', 1)).toBe('#FFFFFF');
  });
});
