/**
 * @fileoverview Utility functions for creating and inspecting protocol message envelopes.
 */

import { PROTOCOL_VERSION } from '../constants.js';
import type { MessageEnvelope, MessageType } from '../types/messages.js';

/**
 * Options when constructing a new MessageEnvelope.
 */
export interface EnvelopeOptions {
  msg_id?: string;
  seq?: number;
  ts?: number;
  room?: string;
  user_id?: string;
}

/**
 * Generates a unique RFC 4122 v4 UUID string.
 * Compatible across Node.js and modern Web environments.
 */
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older test environments if needed
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Factory helper that constructs a fully qualified MessageEnvelope with protocol defaults.
 *
 * @param type The MessageType of the envelope.
 * @param payload Strongly typed payload object.
 * @param options Optional overrides for seq, room, user_id, msg_id, or ts.
 * @returns A MessageEnvelope compliant with the system protocol.
 */
export function createEnvelope<T>(
  type: MessageType,
  payload: T,
  options?: EnvelopeOptions,
): MessageEnvelope<T> {
  return {
    v: PROTOCOL_VERSION,
    type,
    msg_id: options?.msg_id ?? generateUuid(),
    seq: options?.seq ?? 0,
    ts: options?.ts ?? Date.now(),
    room: options?.room ?? '',
    user_id: options?.user_id ?? '',
    payload,
  };
}

/**
 * Type guard verifying whether an arbitrary object conforms to the MessageEnvelope structure.
 *
 * @param data Any candidate JavaScript object.
 * @returns True if data matches the envelope shape.
 */
export function isMessageEnvelope(data: unknown): data is MessageEnvelope {
  if (typeof data !== 'object' || data === null) {
    return false;
  }

  const candidate = data as Record<string, unknown>;

  return (
    typeof candidate['v'] === 'number' &&
    typeof candidate['type'] === 'string' &&
    typeof candidate['msg_id'] === 'string' &&
    typeof candidate['seq'] === 'number' &&
    typeof candidate['ts'] === 'number' &&
    typeof candidate['room'] === 'string' &&
    typeof candidate['user_id'] === 'string' &&
    'payload' in candidate
  );
}
