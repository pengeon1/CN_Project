/**
 * @fileoverview Zod schema for validating the universal protocol message envelope.
 */

import { z } from 'zod';
import { PROTOCOL_VERSION } from '../constants.js';
import { MessageType } from '../types/messages.js';

export const MessageTypeSchema = z.nativeEnum(MessageType);

export const MessageEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: MessageTypeSchema,
  msg_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().positive(),
  room: z.string().max(16),
  user_id: z.string().max(64),
  payload: z.unknown(),
});

export type ValidatedEnvelope = z.infer<typeof MessageEnvelopeSchema>;

