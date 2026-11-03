/**
 * @fileoverview Zod schemas for text chat and message history.
 */

import { z } from 'zod';
import {
  MAX_CHAT_HISTORY_SIZE,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_USERNAME_LENGTH,
} from '../constants.js';

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  text: z.string().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
  ts: z.number().int().positive(),
  isSystem: z.boolean().optional(),
});

export const ChatMessagePayloadSchema = z.object({
  id: z.string().uuid().optional(),
  text: z.string().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
  ts: z.number().int().positive().optional(),
  username: z.string().max(MAX_USERNAME_LENGTH).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  isSystem: z.boolean().optional(),
});

export const ChatHistoryPayloadSchema = z.object({
  messages: z.array(ChatMessageSchema).max(MAX_CHAT_HISTORY_SIZE),
});
