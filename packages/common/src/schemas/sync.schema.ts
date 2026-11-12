/**
 * @fileoverview Zod schemas for room state snapshots, synchronization, and recovery.
 */

import { z } from 'zod';
import { MAX_VERSION_NAME_LENGTH, ROOM_CODE_LENGTH } from '../constants.js';
import { MessageTypeSchema } from './envelope.schema.js';
import { ParticipantSchema, RemovedParticipantSchema } from './room.schema.js';
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

export const PresentationPayloadSchema = z.object({
  active: z.boolean(),
  viewport: z
    .object({
      x: z.number().finite().min(-10_000_000).max(10_000_000),
      y: z.number().finite().min(-10_000_000).max(10_000_000),
      zoom: z.number().finite().min(0.05).max(10),
    })
    .optional(),
});

export const VersionSavePayloadSchema = z.object({
  name: z.string().trim().min(1).max(MAX_VERSION_NAME_LENGTH),
});

export const VersionMetaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(MAX_VERSION_NAME_LENGTH + 40),
  ts: z.number().int().positive(),
  createdBy: z.string().uuid().nullable(),
  auto: z.boolean(),
  objectCount: z.number().int().nonnegative(),
});

export const VersionListPayloadSchema = z.object({
  versions: z.array(VersionMetaSchema).max(100).optional(),
});

export const VersionRestorePayloadSchema = z.object({ versionId: z.string().uuid() });

export const RoomSnapshotSchema = z.object({
  roomCode: z.string().length(ROOM_CODE_LENGTH),
  roomName: z.string().min(1).max(64),
  seq: z.number().int().nonnegative(),
  objects: z.record(WhiteboardObjectSchema),
  participants: z.array(ParticipantSchema),
  removedParticipants: z.array(RemovedParticipantSchema).optional().default([]),
  chatHistory: z.array(ChatMessageSchema),
  locked: z.boolean(),
  allowNameChanges: z.boolean().optional().default(false),
  defaultViewer: z.boolean().optional().default(false),
  presentation: z.lazy(() => PresentationPayloadSchema).optional(),
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
