/**
 * @fileoverview Zod schemas for authentication, handshakes, heartbeats, and control messages.
 */

import { z } from 'zod';
import { MAX_USERNAME_LENGTH } from '../constants.js';

export const HelloPayloadSchema = z.object({
  clientVersion: z.string().min(1).max(32),
  suggestedUsername: z.string().min(1).max(MAX_USERNAME_LENGTH).optional(),
});

export const AuthOkPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  userId: z.string().uuid(),
  protocolVersion: z.number().int().positive(),
});

export const AuthFailPayloadSchema = z.object({
  code: z.string().min(1).max(64),
  reason: z.string().min(1).max(512),
});

export const PingPayloadSchema = z.object({
  nonce: z.number().int(),
});

export const PongPayloadSchema = z.object({
  nonce: z.number().int(),
  serverTs: z.number().int().positive(),
});

export const AckPayloadSchema = z.object({
  target_msg_id: z.string().uuid(),
  seq: z.number().int().nonnegative().optional(),
  status: z.enum(['ok', 'rejected']),
  error: z.string().max(512).optional(),
});

export const ErrorPayloadSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1024),
  details: z.unknown().optional(),
});

