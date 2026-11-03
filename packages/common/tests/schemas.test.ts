import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  isMessageEnvelope,
  MessageEnvelopeSchema,
  MessageType,
  PointSchema,
  StrokeBeginPayloadSchema,
  StrokePointsPayloadSchema,
  validatePayload,
} from '../src/index.js';

describe('Zod Schema Validation & Envelope Utilities', () => {
  it('generates a valid UUID v4', () => {
    const id = generateUuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('constructs and validates a protocol MessageEnvelope', () => {
    const envelope = createEnvelope(MessageType.PING, { nonce: 12345 }, { room: 'AB23CD' });

    expect(isMessageEnvelope(envelope)).toBe(true);
    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe('PING');
    expect(envelope.room).toBe('AB23CD');

    const parsed = MessageEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });

  it('validates 2D Points and bounds check pressure', () => {
    const validPoint = { x: 150.5, y: 320.0, pressure: 0.75 };
    expect(PointSchema.safeParse(validPoint).success).toBe(true);

    const invalidPressure = { x: 100, y: 100, pressure: 1.5 }; // pressure > 1.0
    expect(PointSchema.safeParse(invalidPressure).success).toBe(false);

    const nonFiniteCoord = { x: Infinity, y: 50 };
    expect(PointSchema.safeParse(nonFiniteCoord).success).toBe(false);
  });

  it('validates StrokeBeginPayload constraints (colors and stroke width)', () => {
    const validStroke = {
      op_id: generateUuid(),
      strokeId: generateUuid(),
      color: '#3B82F6',
      width: 4,
      startPoint: { x: 10, y: 20 },
    };
    expect(StrokeBeginPayloadSchema.safeParse(validStroke).success).toBe(true);

    // Invalid hex color name
    const invalidColor = { ...validStroke, color: 'blue' };
    expect(StrokeBeginPayloadSchema.safeParse(invalidColor).success).toBe(false);

    // Width exceeding maximum
    const invalidWidth = { ...validStroke, width: 250 };
    expect(StrokeBeginPayloadSchema.safeParse(invalidWidth).success).toBe(false);

    // Width below minimum
    const zeroWidth = { ...validStroke, width: 0 };
    expect(StrokeBeginPayloadSchema.safeParse(zeroWidth).success).toBe(false);
  });

  it('validates batched points in StrokePointsPayload', () => {
    const batch = {
      op_id: generateUuid(),
      strokeId: generateUuid(),
      points: [
        { x: 10, y: 20 },
        { x: 12, y: 22 },
        { x: 15, y: 25 },
      ],
    };
    expect(StrokePointsPayloadSchema.safeParse(batch).success).toBe(true);

    // Empty point array should fail
    const emptyBatch = { ...batch, points: [] };
    expect(StrokePointsPayloadSchema.safeParse(emptyBatch).success).toBe(false);
  });

  it('dispatches validation through validatePayload helper', () => {
    const validChat = { text: 'Hello, collaborative whiteboard!' };
    const validated = validatePayload(MessageType.CHAT_MESSAGE, validChat);
    expect(validated).toEqual(validChat);

    // Invalid text (empty string)
    expect(() => validatePayload(MessageType.CHAT_MESSAGE, { text: '' })).toThrow();
  });
});

