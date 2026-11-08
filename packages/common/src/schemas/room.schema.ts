/**
 * @fileoverview Zod schemas for room management, joining, permissions, and participants.
 */

import { z } from 'zod';
import { MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH, ROOM_CODE_LENGTH } from '../constants.js';
import { Role } from '../types/roles.js';

export const RoleSchema = z.nativeEnum(Role);

export const ParticipantSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
  role: RoleSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color'),
  joinedAt: z.number().int().positive(),
});

export const CreateRoomPayloadSchema = z.object({
  roomName: z.string().min(1).max(64),
  username: z.string().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
  password: z.string().min(1).max(64).optional(),
  allowNameChanges: z.boolean().optional().default(false),
});

export const JoinRoomPayloadSchema = z.object({
  roomCode: z.string().length(ROOM_CODE_LENGTH),
  username: z.string().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
  password: z.string().min(1).max(64).optional(),
  sessionToken: z.string().uuid().optional(),
  lastSeq: z.number().int().nonnegative().optional(),
});

export const LeaveRoomPayloadSchema = z.object({
  reason: z.string().max(256).optional(),
});

export const ParticipantJoinedPayloadSchema = z.object({
  participant: ParticipantSchema,
});

export const ParticipantLeftPayloadSchema = z.object({
  userId: z.string().uuid(),
  username: z.string().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
  reason: z.string().max(256).optional(),
});

export const ParticipantRenamedPayloadSchema = z.object({
  userId: z.string().uuid(),
  username: z.string().trim().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
});

export const UpdateUsernamePayloadSchema = z.object({
  username: z.string().trim().min(MIN_USERNAME_LENGTH).max(MAX_USERNAME_LENGTH),
});

export const ParticipantListPayloadSchema = z.object({
  participants: z.array(ParticipantSchema),
});

export const PermissionChangePayloadSchema = z
  .object({
    targetUserId: z.string().uuid().optional(),
    newRole: RoleSchema.optional(),
    lockRoom: z.boolean().optional(),
    kick: z.boolean().optional(),
    reason: z.string().max(256).optional(),
  })
  .superRefine((payload, context) => {
    const changesParticipant =
      payload.targetUserId !== undefined &&
      (payload.newRole !== undefined || payload.kick === true);
    const changesLock = payload.lockRoom !== undefined;
    if (!changesParticipant && !changesLock) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A role change, kick, or room lock change is required',
      });
    }
    if (payload.kick && payload.newRole !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A participant cannot be kicked and role-changed in the same request',
      });
    }
    if (changesParticipant && changesLock) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Participant changes and room lock changes must be separate requests',
      });
    }
    if (payload.reason !== undefined && payload.kick !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A reason is only valid when kicking a participant',
      });
    }
  });
