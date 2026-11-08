/**
 * @fileoverview Zod schemas for drawing operations, strokes, shapes, and canvas mutations.
 */

import { z } from 'zod';
import { ShapeType } from '../types/whiteboard.js';

export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  pressure: z.number().min(0).max(1).optional(),
});

export const ShapeTypeSchema = z.nativeEnum(ShapeType);

export const StrokeBeginPayloadSchema = z.object({
  op_id: z.string().uuid(),
  strokeId: z.string().uuid(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color'),
  width: z.number().min(1).max(100),
  startPoint: PointSchema,
});

export const StrokePointsPayloadSchema = z.object({
  op_id: z.string().uuid(),
  strokeId: z.string().uuid(),
  points: z.array(PointSchema).min(1).max(2000),
  startIndex: z.number().int().nonnegative().optional(),
});

export const StrokeEndPayloadSchema = z.object({
  op_id: z.string().uuid(),
  strokeId: z.string().uuid(),
  finalPoint: PointSchema.optional(),
  startIndex: z.number().int().nonnegative().optional(),
});

export const BaseWhiteboardObjectSchema = z.object({
  id: z.string().uuid(),
  authorId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  zIndex: z.number().int(),
  updatedAt: z.number().int().positive(),
});

export const StrokeObjectSchema = BaseWhiteboardObjectSchema.extend({
  type: z.literal('stroke'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  width: z.number().min(1).max(100),
  points: z.array(PointSchema),
  isComplete: z.boolean(),
});

export const ShapeObjectSchema = BaseWhiteboardObjectSchema.extend({
  type: z.literal('shape'),
  shapeType: ShapeTypeSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  strokeColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  strokeWidth: z.number().min(0).max(100),
  fillColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  text: z.string().max(5000).optional(),
  fontSize: z.number().min(8).max(144).optional(),
  fontFamily: z.string().max(64).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

export const WhiteboardObjectSchema = z.discriminatedUnion('type', [
  StrokeObjectSchema,
  ShapeObjectSchema,
]);

export const ShapeAddPayloadSchema = z.object({
  op_id: z.string().uuid(),
  object: ShapeObjectSchema,
});

export const ObjectUpdatePayloadSchema = z.object({
  op_id: z.string().uuid(),
  id: z.string().uuid(),
  changes: z.record(z.unknown()),
});

export const ObjectDeletePayloadSchema = z.object({
  op_id: z.string().uuid(),
  id: z.string().uuid(),
});

export const ErasePayloadSchema = z.object({
  op_id: z.string().uuid(),
  objectIds: z.array(z.string().uuid()).min(1).max(500),
});

export const ClearCanvasPayloadSchema = z.object({
  op_id: z.string().uuid(),
});

export const UndoPayloadSchema = z.object({
  op_id: z.string().uuid(),
  target_op_id: z.string().uuid(),
});

export const RedoPayloadSchema = z.object({
  op_id: z.string().uuid(),
  target_op_id: z.string().uuid(),
});

export const CursorMovePayloadSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  activeTool: z.string().max(32).optional(),
  pressure: z.number().min(0).max(1).optional(),
});
