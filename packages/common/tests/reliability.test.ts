import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  isReliableClientOp,
  isSequencedType,
  mergeStrokePoints,
  MessageType,
  type Point,
  reliableOpKey,
  validatePayload,
} from '../src/index.js';

describe('Reliability primitives (Phase 8)', () => {
  describe('message classification', () => {
    it('treats state-changing events as sequenced and ephemeral traffic as unsequenced', () => {
      for (const type of [
        MessageType.STROKE_BEGIN,
        MessageType.STROKE_POINTS,
        MessageType.STROKE_END,
        MessageType.ERASE,
        MessageType.CLEAR_CANVAS,
        MessageType.CHAT_MESSAGE,
        MessageType.PARTICIPANT_JOINED,
        MessageType.PARTICIPANT_LEFT,
        MessageType.PERMISSION_CHANGE,
      ]) {
        expect(isSequencedType(type), type).toBe(true);
      }

      for (const type of [
        MessageType.CURSOR_MOVE,
        MessageType.PING,
        MessageType.PONG,
        MessageType.ACK,
        MessageType.ERROR,
        MessageType.ROOM_STATE,
        MessageType.RESYNC_REQUEST,
        MessageType.RESYNC_RESPONSE,
      ]) {
        expect(isSequencedType(type), type).toBe(false);
      }
    });

    it('only queues client operations that mutate shared state for retransmission', () => {
      expect(isReliableClientOp(MessageType.STROKE_POINTS)).toBe(true);
      expect(isReliableClientOp(MessageType.ERASE)).toBe(true);
      expect(isReliableClientOp(MessageType.CHAT_MESSAGE)).toBe(true);
      expect(isReliableClientOp(MessageType.CURSOR_MOVE)).toBe(false);
      expect(isReliableClientOp(MessageType.PING)).toBe(false);
      expect(isReliableClientOp(MessageType.RESYNC_REQUEST)).toBe(false);
    });
  });

  describe('reliableOpKey', () => {
    it('keys drawing operations by op_id and chat messages by id', () => {
      const opId = generateUuid();
      const chatId = generateUuid();

      const stroke = createEnvelope(MessageType.STROKE_POINTS, {
        op_id: opId,
        strokeId: generateUuid(),
        points: [{ x: 1, y: 1 }],
      });
      const chat = createEnvelope(MessageType.CHAT_MESSAGE, { id: chatId, text: 'hi' });

      expect(reliableOpKey(stroke)).toBe(opId);
      expect(reliableOpKey(chat)).toBe(chatId);
    });

    it('falls back to msg_id and is stable across the echoed form of an operation', () => {
      const plain = createEnvelope(MessageType.CLEAR_CANVAS, {});
      expect(reliableOpKey(plain)).toBe(plain.msg_id);

      const opId = generateUuid();
      const sent = createEnvelope(MessageType.ERASE, { op_id: opId, objectIds: [] });
      const echoed = createEnvelope(
        MessageType.ERASE,
        { op_id: opId, objectIds: [] },
        { seq: 9, user_id: generateUuid() },
      );
      expect(reliableOpKey(echoed)).toBe(reliableOpKey(sent));
    });
  });

  describe('mergeStrokePoints', () => {
    const p = (n: number): Point => ({ x: n, y: n });

    it('appends when no index is supplied', () => {
      const points = [p(0)];
      mergeStrokePoints(points, [p(1), p(2)]);
      expect(points).toEqual([p(0), p(1), p(2)]);
    });

    it('appends a batch that starts exactly at the end of the stroke', () => {
      const points = [p(0), p(1)];
      mergeStrokePoints(points, [p(2), p(3)], 2);
      expect(points).toEqual([p(0), p(1), p(2), p(3)]);
    });

    it('ignores a batch that was already applied (duplicate delivery or optimistic local copy)', () => {
      const points = [p(0), p(1), p(2), p(3)];
      mergeStrokePoints(points, [p(2), p(3)], 2);
      mergeStrokePoints(points, [p(2), p(3)], 2);
      expect(points).toEqual([p(0), p(1), p(2), p(3)]);
    });

    it('applies only the unseen tail of a partially overlapping batch', () => {
      const points = [p(0), p(1), p(2)];
      mergeStrokePoints(points, [p(1), p(2), p(3), p(4)], 1);
      expect(points).toEqual([p(0), p(1), p(2), p(3), p(4)]);
    });

    it('does nothing for an empty batch', () => {
      const points = [p(0)];
      mergeStrokePoints(points, [], 1);
      expect(points).toEqual([p(0)]);
    });
  });

  describe('Phase 8 payload schemas', () => {
    it('accepts lastSeq on JOIN_ROOM and rejects a negative or fractional value', () => {
      const base = { roomCode: 'ABC234', username: 'Alice', sessionToken: generateUuid() };
      expect(() => validatePayload(MessageType.JOIN_ROOM, { ...base, lastSeq: 12 })).not.toThrow();
      expect(() => validatePayload(MessageType.JOIN_ROOM, base)).not.toThrow();
      expect(() => validatePayload(MessageType.JOIN_ROOM, { ...base, lastSeq: -1 })).toThrow();
      expect(() => validatePayload(MessageType.JOIN_ROOM, { ...base, lastSeq: 1.5 })).toThrow();
    });

    it('accepts roomSeq on PONG', () => {
      expect(() =>
        validatePayload(MessageType.PONG, { nonce: 1, serverTs: Date.now(), roomSeq: 42 }),
      ).not.toThrow();
      expect(() =>
        validatePayload(MessageType.PONG, { nonce: 1, serverTs: Date.now() }),
      ).not.toThrow();
    });

    it('accepts an optional startIndex on STROKE_POINTS and STROKE_END', () => {
      const ids = { op_id: generateUuid(), strokeId: generateUuid() };
      expect(() =>
        validatePayload(MessageType.STROKE_POINTS, {
          ...ids,
          points: [{ x: 1, y: 2 }],
          startIndex: 3,
        }),
      ).not.toThrow();
      expect(() =>
        validatePayload(MessageType.STROKE_END, {
          ...ids,
          finalPoint: { x: 1, y: 2 },
          startIndex: 4,
        }),
      ).not.toThrow();
    });
  });
});
