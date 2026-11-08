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

export const ParticipantListPayloadSchema = z.object({
  participants: z.array(ParticipantSchema),
});

export const PermissionChangePayloadSchema = z.object({
  targetUserId: z.string().uuid(),
  newRole: RoleSchema.optional(),
  lockRoom: z.boolean().optional(),
});
