/**
 * @fileoverview Shared reliability primitives used by both the server and the client.
 *
 * Delivery model (see docs/protocol.md, "Ordering & Reliability"):
 *
 * - Every state-changing event in a room is stamped by the server with a strictly increasing,
 *   gap-free `seq`. Events and their `seq` values are also written to the room's operations log,
 *   so any missed range can be re-sent on request.
 * - Clients deliver those events to the UI exactly once and strictly in `seq` order
 *   (duplicates are dropped, early arrivals are buffered, missing ranges are re-requested).
 * - Client -> server operations carry a client-generated id (`op_id`, or `id` for chat) that the
 *   server uses for idempotency, so a retried operation is never applied twice.
 */

import { MessageType } from '../types/messages.js';
import type { MessageEnvelope } from '../types/messages.js';
import type { Point } from '../types/whiteboard.js';

/**
 * Message types that consume a room sequence number when broadcast by the server.
 * Everything else (cursors, heartbeats, acks, snapshots, errors) is unsequenced.
 */
export const SEQUENCED_MESSAGE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  MessageType.PARTICIPANT_JOINED,
  MessageType.PARTICIPANT_LEFT,
  MessageType.PARTICIPANT_RENAMED,
  MessageType.PERMISSION_CHANGE,
  MessageType.STROKE_BEGIN,
  MessageType.STROKE_POINTS,
  MessageType.STROKE_END,
  MessageType.SHAPE_ADD,
  MessageType.IMAGE_ADD,
  MessageType.OBJECT_UPDATE,
  MessageType.OBJECT_DELETE,
  MessageType.ERASE,
  MessageType.CLEAR_CANVAS,
  MessageType.UNDO,
  MessageType.REDO,
  MessageType.CHAT_MESSAGE,
]);

/**
 * Client -> server message types that must survive disconnections.
 * The client keeps them in an outbox until the server acknowledges (echoes) them.
 */
export const RELIABLE_CLIENT_OP_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  MessageType.STROKE_BEGIN,
  MessageType.STROKE_POINTS,
  MessageType.STROKE_END,
  MessageType.SHAPE_ADD,
  MessageType.IMAGE_ADD,
  MessageType.OBJECT_UPDATE,
  MessageType.OBJECT_DELETE,
  MessageType.ERASE,
  MessageType.CLEAR_CANVAS,
  MessageType.UNDO,
  MessageType.REDO,
  MessageType.CHAT_MESSAGE,
]);

/**
 * @returns true if the server assigns a room sequence number to messages of this type.
 */
export function isSequencedType(type: MessageType): boolean {
  return SEQUENCED_MESSAGE_TYPES.has(type);
}

/**
 * @returns true if a client must retain and retransmit messages of this type until acknowledged.
 */
export function isReliableClientOp(type: MessageType): boolean {
  return RELIABLE_CLIENT_OP_TYPES.has(type);
}

/**
 * Derives the idempotency key of a client operation.
 *
 * The key is the payload's `op_id` (drawing operations), else its `id` (chat messages),
 * else the envelope `msg_id`. The server echoes the same payload back, so the same key
 * identifies an operation in its outbound, echoed, and replayed forms.
 */
export function reliableOpKey(envelope: MessageEnvelope): string {
  const payload = envelope.payload;
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    const opId = record['op_id'];
    if (typeof opId === 'string') return opId;
    const id = record['id'];
    if (typeof id === 'string') return id;
  }
  return envelope.msg_id;
}

/**
 * Idempotently merges a batch of stroke points into an existing point list.
 *
 * `startIndex` is the index the first incoming point occupies in the authoritative stroke
 * (assigned by the server). Points the local copy already holds (for example, because they were
 * drawn locally and optimistically) are skipped, so a point is never applied twice no matter how
 * many times the batch is delivered or replayed. Without `startIndex` the points are appended.
 *
 * @param existing The mutable point list to merge into.
 * @param incoming The batch of points to merge.
 * @param startIndex Authoritative index of `incoming[0]`, when known.
 */
export function mergeStrokePoints(existing: Point[], incoming: Point[], startIndex?: number): void {
  if (incoming.length === 0) return;
  if (startIndex === undefined) {
    existing.push(...incoming);
    return;
  }
  const alreadyHave = Math.max(0, existing.length - startIndex);
  if (alreadyHave >= incoming.length) return;
  existing.push(...incoming.slice(alreadyHave));
}
