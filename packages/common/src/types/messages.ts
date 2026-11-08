/**
 * @fileoverview Exhaustive protocol message type definitions and envelope structures.
 */

import type { Role } from './roles.js';
import type {
  ChatMessage,
  Participant,
  Point,
  RoomSnapshot,
  ShapeObject,
  WhiteboardObject,
} from './whiteboard.js';

/**
 * Enumeration of all protocol message types supported across the system.
 */
export const MessageType = {
  // Authentication & Handshake
  HELLO: 'HELLO',
  AUTH_OK: 'AUTH_OK',
  AUTH_FAIL: 'AUTH_FAIL',

  // Room Lifecycle & Management
  CREATE_ROOM: 'CREATE_ROOM',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  ROOM_STATE: 'ROOM_STATE',
  PARTICIPANT_JOINED: 'PARTICIPANT_JOINED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  PARTICIPANT_LIST: 'PARTICIPANT_LIST',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',

  // Real-time Drawing & Whiteboard Operations
  STROKE_BEGIN: 'STROKE_BEGIN',
  STROKE_POINTS: 'STROKE_POINTS',
  STROKE_END: 'STROKE_END',
  SHAPE_ADD: 'SHAPE_ADD',
  OBJECT_UPDATE: 'OBJECT_UPDATE',
  OBJECT_DELETE: 'OBJECT_DELETE',
  ERASE: 'ERASE',
  CLEAR_CANVAS: 'CLEAR_CANVAS',
  UNDO: 'UNDO',
  REDO: 'REDO',

  // Ephemeral Presence
  CURSOR_MOVE: 'CURSOR_MOVE',

  // Chat
  CHAT_MESSAGE: 'CHAT_MESSAGE',
  CHAT_HISTORY: 'CHAT_HISTORY',

  // Heartbeat & Reliability
  PING: 'PING',
  PONG: 'PONG',
  ACK: 'ACK',
  RESYNC_REQUEST: 'RESYNC_REQUEST',
  RESYNC_RESPONSE: 'RESYNC_RESPONSE',

  // State Persistence
  SAVE_STATE: 'SAVE_STATE',
  LOAD_STATE: 'LOAD_STATE',

  // Error Feedback
  ERROR: 'ERROR',
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/**
 * Universal application envelope wrapping every framed network message.
 */
export interface MessageEnvelope<T = unknown> {
  /**
   * Protocol version (must match PROTOCOL_VERSION).
   */
  v: number;
  /**
   * The type of message represented by this envelope.
   */
  type: MessageType;
  /**
   * Unique message identifier (UUID v4) for tracing and acknowledgments.
   */
  msg_id: string;
  /**
   * Monotonically increasing sequence number assigned by the server.
   * Client-sent messages specify 0 until stamped and sequenced by the server.
   */
  seq: number;
  /**
   * Timestamp in epoch milliseconds (server-assigned for sequenced messages).
   */
  ts: number;
  /**
   * 6-character room code or empty string during pre-room handshake.
   */
  room: string;
  /**
   * User identifier of the sender or empty string prior to authentication.
   */
  user_id: string;
  /**
   * Strongly-typed message payload data.
   */
  payload: T;
}

// ============================================================================
// Payload Type Interfaces
// ============================================================================

export interface HelloPayload {
  clientVersion: string;
  suggestedUsername?: string;
  sessionToken?: string;
}

export interface AuthOkPayload {
  sessionId: string;
  userId: string;
  protocolVersion: number;
}

export interface AuthFailPayload {
  code: string;
  reason: string;
}

export interface CreateRoomPayload {
  roomName: string;
  username: string;
  password?: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  username: string;
  password?: string;
  sessionToken?: string;
  /**
   * Highest contiguous room seq the client has applied. Sent when resuming after a disconnect so
   * the server can reply with only the missed operations instead of a full snapshot.
   */
  lastSeq?: number;
}

export interface LeaveRoomPayload {
  reason?: string;
}

export type RoomStatePayload = RoomSnapshot;

export interface ParticipantJoinedPayload {
  participant: Participant;
}

export interface ParticipantLeftPayload {
  userId: string;
  username: string;
  reason?: string;
}

export interface ParticipantListPayload {
  participants: Participant[];
}

export interface PermissionChangePayload {
  targetUserId: string;
  newRole?: Role;
  lockRoom?: boolean;
}

export interface StrokeBeginPayload {
  op_id: string;
  strokeId: string;
  color: string;
  width: number;
  startPoint: Point;
}

export interface StrokePointsPayload {
  op_id: string;
  strokeId: string;
  points: Point[];
  /**
   * Index of `points[0]` within the authoritative stroke. Assigned by the server on broadcast
   * (ignored on client input) so clients can apply a batch idempotently.
   */
  startIndex?: number;
}

export interface StrokeEndPayload {
  op_id: string;
  strokeId: string;
  finalPoint?: Point;
  /**
   * Index of `finalPoint` within the authoritative stroke. Assigned by the server on broadcast.
   */
  startIndex?: number;
}

export interface ShapeAddPayload {
  op_id: string;
  object: ShapeObject;
}

export interface ObjectUpdatePayload {
  op_id: string;
  id: string;
  changes: Partial<WhiteboardObject>;
}

export interface ObjectDeletePayload {
  op_id: string;
  id: string;
}

export interface ErasePayload {
  op_id: string;
  objectIds: string[];
}

export interface ClearCanvasPayload {
  op_id: string;
}

export interface UndoPayload {
  op_id: string;
  target_op_id: string;
  removeIds?: string[];
  restoreObjects?: WhiteboardObject[];
}

export interface RedoPayload {
  op_id: string;
  target_op_id: string;
  removeIds?: string[];
  restoreObjects?: WhiteboardObject[];
}

export interface CursorMovePayload {
  x: number;
  y: number;
  activeTool?: string;
  pressure?: number;
}

export interface ChatMessagePayload {
  id?: string;
  text: string;
  ts?: number;
  username?: string;
  color?: string;
  isSystem?: boolean;
}

export interface ChatHistoryPayload {
  messages: ChatMessage[];
}

export interface PingPayload {
  nonce: number;
}

export interface PongPayload {
  nonce: number;
  serverTs: number;
  /**
   * Current sequence number of the sender's room. Lets a client notice that it is missing the
   * tail of the event stream even when no later event arrives to expose the gap.
   */
  roomSeq?: number;
}

export interface AckPayload {
  target_msg_id: string;
  seq?: number;
  status: 'ok' | 'rejected';
  error?: string;
}

export interface ResyncRequestPayload {
  last_seq: number;
}

export interface SequencedOperation {
  op_id: string;
  seq: number;
  userId: string;
  type: MessageType;
  payload: unknown;
  ts: number;
}

export interface ResyncResponsePayload {
  from_seq: number;
  to_seq: number;
  operations?: SequencedOperation[];
  fullSnapshot?: RoomSnapshot;
}

export interface SaveStatePayload {
  savedAt?: number;
  filename?: string;
}

export interface LoadStatePayload {
  loadedAt?: number;
  filename?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}
