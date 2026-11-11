/**
 * @fileoverview Phase 12: shapes, text, sticky notes, property updates, z-order, deletion and
 * their undo/redo, exercised directly on the authoritative Room.
 */

import { describe, expect, it } from 'vitest';
import {
  generateUuid,
  ObjectUpdatePayloadSchema,
  type ShapeObject,
  ShapeType,
} from '@cn-whiteboard/common';
import { Room } from '../src/room.js';

const A = generateUuid();
const B = generateUuid();

function shape(id = generateUuid(), type: ShapeObject['shapeType'] = ShapeType.RECTANGLE) {
  return {
    id,
    authorId: A,
    seq: 0,
    zIndex: 0,
    updatedAt: Date.now(),
    type: 'shape',
    shapeType: type,
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    strokeColor: '#000000',
    strokeWidth: 2,
  } satisfies ShapeObject;
}

describe('Phase 12 shapes (server state)', () => {
  it('assigns authorship, z-order and seq on the server, ignoring client claims', () => {
    const room = new Room('ABC234', 'r', A);
    const s1 = room.applyShapeAdd(generateUuid(), { ...shape(), authorId: B, zIndex: 999 }, A)!;
    const s2 = room.applyShapeAdd(generateUuid(), shape(), A)!;
    expect(s1.authorId).toBe(A);
    expect(s1.zIndex).toBe(1);
    expect(s2.zIndex).toBe(2);
    expect(s2.seq).toBeGreaterThan(s1.seq);
  });

  it('is idempotent on op_id and rejects id reuse', () => {
    const room = new Room('ABC234', 'r', A);
    const op = generateUuid();
    const s = shape();
    room.applyShapeAdd(op, s, A);
    const seq = room.seq;
    room.applyShapeAdd(op, s, A);
    expect(room.seq).toBe(seq);
    expect(room.applyShapeAdd(generateUuid(), s, B)).toBeNull();
  });

  it('merges concurrent edits of different properties and resolves same-property by seq', () => {
    const room = new Room('ABC234', 'r', A);
    const s = room.applyShapeAdd(generateUuid(), shape(), A)!;
    room.applyObjectUpdate(generateUuid(), s.id, { x: 500 }, A);
    room.applyObjectUpdate(generateUuid(), s.id, { strokeColor: '#EF4444' }, B);
    room.applyObjectUpdate(generateUuid(), s.id, { x: 700 }, B); // later seq wins for x
    const out = room.getObject(s.id) as ShapeObject;
    expect(out.x).toBe(700);
    expect(out.strokeColor).toBe('#EF4444');
    expect(out.width).toBe(100);
  });

  it('removes optional fill with null and ignores updates to deleted objects', () => {
    const room = new Room('ABC234', 'r', A);
    const s = room.applyShapeAdd(generateUuid(), { ...shape(), fillColor: '#FFFFFF' }, A)!;
    room.applyObjectUpdate(generateUuid(), s.id, { fillColor: null }, A);
    expect((room.getObject(s.id) as ShapeObject).fillColor).toBeUndefined();
    expect(room.applyObjectDelete(generateUuid(), s.id, B)).not.toBeNull();
    expect(room.applyObjectUpdate(generateUuid(), s.id, { x: 1 }, A)).toBeNull();
    expect(room.applyObjectDelete(generateUuid(), s.id, A)).toBeNull();
  });

  it('undoes and redoes add, update and delete for the owning user', () => {
    const room = new Room('ABC234', 'r', A);
    const addOp = generateUuid();
    const s = room.applyShapeAdd(addOp, shape(), A)!;
    const updOp = generateUuid();
    room.applyObjectUpdate(updOp, s.id, { width: 300 }, A);
    const delOp = generateUuid();
    room.applyObjectDelete(delOp, s.id, A);

    expect(room.applyUndo(generateUuid(), delOp, A).accepted).toBe(true);
    expect((room.getObject(s.id) as ShapeObject).width).toBe(300);

    // delOp is now on the redo stack; redo removes it again
    expect(room.applyRedo(generateUuid(), delOp, A).accepted).toBe(true);
    expect(room.getObject(s.id)).toBeUndefined();
    expect(room.applyUndo(generateUuid(), delOp, A).accepted).toBe(true);

    expect(room.applyUndo(generateUuid(), updOp, A).accepted).toBe(true);
    expect((room.getObject(s.id) as ShapeObject).width).toBe(100);
    expect(room.applyRedo(generateUuid(), updOp, A).accepted).toBe(true);
    expect((room.getObject(s.id) as ShapeObject).width).toBe(300);
    expect(room.applyUndo(generateUuid(), updOp, A).accepted).toBe(true);

    expect(room.applyUndo(generateUuid(), addOp, A).accepted).toBe(true);
    expect(room.getObject(s.id)).toBeUndefined();
  });

  it('validates update payloads strictly', () => {
    const base = { op_id: generateUuid(), id: generateUuid() };
    expect(ObjectUpdatePayloadSchema.safeParse({ ...base, changes: { x: 5 } }).success).toBe(true);
    for (const changes of [
      {},
      { authorId: generateUuid() },
      { type: 'stroke' },
      { strokeColor: 'red' },
      { x: Infinity },
      { fontSize: 1000 },
    ]) {
      expect(ObjectUpdatePayloadSchema.safeParse({ ...base, changes }).success).toBe(false);
    }
  });
});
