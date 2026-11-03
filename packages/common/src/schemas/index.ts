/**
 * @fileoverview Re-exports all Zod schemas and provides message payload validation dispatchers.
 */

import type { z } from 'zod';
import { MessageType } from '../types/messages.js';
import {
  AckPayloadSchema,
  AuthFailPayloadSchema,
  AuthOkPayloadSchema,
  ErrorPayloadSchema,
  HelloPayloadSchema,
  PingPayloadSchema,
  PongPayloadSchema,
} from './auth.schema.js';
import { ChatHistoryPayloadSchema, ChatMessagePayloadSchema } from './chat.schema.js';
import {
  ClearCanvasPayloadSchema,
  CursorMovePayloadSchema,
  ErasePayloadSchema,
  ObjectDeletePayloadSchema,
  ObjectUpdatePayloadSchema,
  RedoPayloadSchema,
  ShapeAddPayloadSchema,
  StrokeBeginPayloadSchema,
  StrokeEndPayloadSchema,
  StrokePointsPayloadSchema,
  UndoPayloadSchema,
} from './drawing.schema.js';
import {
  CreateRoomPayloadSchema,
  JoinRoomPayloadSchema,
  LeaveRoomPayloadSchema,
  ParticipantJoinedPayloadSchema,
  ParticipantLeftPayloadSchema,
  ParticipantListPayloadSchema,
  PermissionChangePayloadSchema,
} from './room.schema.js';
import {
  LoadStatePayloadSchema,
  ResyncRequestPayloadSchema,
  ResyncResponsePayloadSchema,
  RoomStatePayloadSchema,
  SaveStatePayloadSchema,
} from './sync.schema.js';

export * from './envelope.schema.js';
export * from './auth.schema.js';
export * from './room.schema.js';
export * from './drawing.schema.js';
export * from './chat.schema.js';
export * from './sync.schema.js';

/**
 * Mapping of MessageType to its respective Zod validation schema.
 */
export const PayloadSchemaMap: Record<MessageType, z.ZodTypeAny> = {
  [MessageType.HELLO]: HelloPayloadSchema,
  [MessageType.AUTH_OK]: AuthOkPayloadSchema,
  [MessageType.AUTH_FAIL]: AuthFailPayloadSchema,
  [MessageType.CREATE_ROOM]: CreateRoomPayloadSchema,
  [MessageType.JOIN_ROOM]: JoinRoomPayloadSchema,
  [MessageType.LEAVE_ROOM]: LeaveRoomPayloadSchema,
  [MessageType.ROOM_STATE]: RoomStatePayloadSchema,
  [MessageType.PARTICIPANT_JOINED]: ParticipantJoinedPayloadSchema,
  [MessageType.PARTICIPANT_LEFT]: ParticipantLeftPayloadSchema,
  [MessageType.PARTICIPANT_LIST]: ParticipantListPayloadSchema,
  [MessageType.PERMISSION_CHANGE]: PermissionChangePayloadSchema,
  [MessageType.STROKE_BEGIN]: StrokeBeginPayloadSchema,
  [MessageType.STROKE_POINTS]: StrokePointsPayloadSchema,
  [MessageType.STROKE_END]: StrokeEndPayloadSchema,
  [MessageType.SHAPE_ADD]: ShapeAddPayloadSchema,
  [MessageType.OBJECT_UPDATE]: ObjectUpdatePayloadSchema,
  [MessageType.OBJECT_DELETE]: ObjectDeletePayloadSchema,
  [MessageType.ERASE]: ErasePayloadSchema,
  [MessageType.CLEAR_CANVAS]: ClearCanvasPayloadSchema,
  [MessageType.UNDO]: UndoPayloadSchema,
  [MessageType.REDO]: RedoPayloadSchema,
  [MessageType.CURSOR_MOVE]: CursorMovePayloadSchema,
  [MessageType.CHAT_MESSAGE]: ChatMessagePayloadSchema,
  [MessageType.CHAT_HISTORY]: ChatHistoryPayloadSchema,
  [MessageType.PING]: PingPayloadSchema,
  [MessageType.PONG]: PongPayloadSchema,
  [MessageType.ACK]: AckPayloadSchema,
  [MessageType.RESYNC_REQUEST]: ResyncRequestPayloadSchema,
  [MessageType.RESYNC_RESPONSE]: ResyncResponsePayloadSchema,
  [MessageType.SAVE_STATE]: SaveStatePayloadSchema,
  [MessageType.LOAD_STATE]: LoadStatePayloadSchema,
  [MessageType.ERROR]: ErrorPayloadSchema,
};

/**
 * Validates an arbitrary message payload against the official Zod schema for its message type.
 *
 * @param type The MessageType of the envelope.
 * @param payload The raw payload data to validate.
 * @returns The parsed and typed payload data if valid.
 * @throws {z.ZodError} If validation fails.
 */
export function validatePayload<T = unknown>(type: MessageType, payload: unknown): T {
  const schema = PayloadSchemaMap[type];
  if (!schema) {
    throw new Error(`No validation schema registered for message type: ${type}`);
  }
  return schema.parse(payload) as T;
}
