/**
 * @fileoverview Zod schemas for room state snapshots, synchronization, and recovery.
 */

import { z } from 'zod';
import { ROOM_CODE_LENGTH } from '../constants.js';
import { MessageTypeSchema } from './envelope.schema.js';
import { ParticipantSchema } from './room.schema.js';
import { ChatMessageSchema } from './chat.schema.js';
import { WhiteboardObjectSchema } from './drawing.schema.js';

export const SequencedOperationSchema = z.object({
  op_id: z.string().uuid(),
  seq: z.number().int().positive(),
  userId: z.string().uuid(),
  type: MessageTypeSchema,
  payload: z.unknown(),
  ts: z.number().int().positive(),
});

export const RoomSnapshotSchema = z.object({
  roomCode: z.string().length(ROOM_CODE_LENGTH),
  roomName: z.string().min(1).max(64),
  seq: z.number().int().nonnegative(),
  objects: z.record(WhiteboardObjectSchema),
  participants: z.array(ParticipantSchema),
  chatHistory: z.array(ChatMessageSchema),
  locked: z.boolean(),
  allowNameChanges: z.boolean().optional().default(false),
  createdAt: z.number().int().positive(),
});

export const RoomStatePayloadSchema = RoomSnapshotSchema;

export const ResyncRequestPayloadSchema = z.object({
  last_seq: z.number().int().nonnegative(),
});

export const ResyncResponsePayloadSchema = z.object({
  from_seq: z.number().int().nonnegative(),
  to_seq: z.number().int().nonnegative(),
  operations: z.array(SequencedOperationSchema).optional(),
  fullSnapshot: RoomSnapshotSchema.optional(),
});

export const SaveStatePayloadSchema = z.object({
  savedAt: z.number().int().positive().optional(),
  filename: z.string().max(256).optional(),
});

export const LoadStatePayloadSchema = z.object({
  loadedAt: z.number().int().positive().optional(),
  filename: z.string().max(256).optional(),
});
