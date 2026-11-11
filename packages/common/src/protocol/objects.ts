/**
 * @fileoverview Pure helpers that apply SHAPE_ADD / OBJECT_UPDATE operations to whiteboard
 * objects. Shared by the server (authoritative state) and the client (optimistic state and log
 * replay) so both sides compute identical results from the same sequenced operation.
 *
 * Conflict rule (last-writer-wins per property): the server applies operations one at a time in
 * seq order and every client replays them in the same order. Two edits touching different
 * properties of one object therefore both survive, and two edits of the SAME property resolve to
 * the one with the higher seq. Every change is an absolute value (never a delta), which keeps
 * re-application of an echoed operation idempotent.
 */

import type { ImageObject, Point, ShapeObject, WhiteboardObject } from '../types/whiteboard.js';

/**
 * Properties that may be changed by OBJECT_UPDATE. `null` removes an optional property.
 * Shape-only and stroke-only keys are ignored when they do not apply to the target object.
 */
export interface ObjectChanges {
  zIndex?: number;
  // Shapes, text and sticky notes
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  strokeWidth?: number;
  fillColor?: string | null;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  // Freehand strokes
  color?: string;
  points?: Point[];
}

const SHAPE_KEYS = [
  'x',
  'y',
  'width',
  'height',
  'strokeColor',
  'strokeWidth',
  'text',
  'fontSize',
  'fontFamily',
  'align',
  'bold',
  'italic',
] as const;

/**
 * Returns a copy of `obj` with `changes` applied. The input is never mutated so that callers
 * holding the previous object (React memoization, undo snapshots) keep a stable value.
 *
 * @param seq The seq of the operation, recorded on the object as its last-modified marker.
 */
export function applyObjectChanges(
  obj: WhiteboardObject,
  changes: ObjectChanges,
  seq: number,
  ts: number,
): WhiteboardObject {
  const next: Record<string, unknown> = { ...obj };
  if (changes.zIndex !== undefined) next.zIndex = changes.zIndex;

  if (obj.type === 'shape') {
    for (const key of SHAPE_KEYS) {
      if (changes[key] !== undefined) next[key] = changes[key];
    }
    if (changes.fillColor === null) delete next.fillColor;
    else if (changes.fillColor !== undefined) next.fillColor = changes.fillColor;
  } else if (obj.type === 'image') {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      if (changes[key] !== undefined) next[key] = changes[key];
    }
  } else {
    if (changes.color !== undefined) next.color = changes.color;
    if (changes.strokeWidth !== undefined) next.width = changes.strokeWidth;
    if (changes.points !== undefined && changes.points.length > 0) next.points = changes.points;
  }

  next.seq = seq;
  next.updatedAt = ts;
  return next as unknown as WhiteboardObject;
}

/**
 * Normalizes a newly added shape: the server (not the client) decides authorship, z-order and seq.
 */
export function normalizeNewShape<T extends ShapeObject | ImageObject>(
  object: T,
  authorId: string,
  zIndex: number,
  seq: number,
  ts: number,
): T {
  return { ...object, authorId, zIndex, seq, updatedAt: ts };
}
