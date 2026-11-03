/**
 * @fileoverview Length-prefixed binary framing encode and decode implementation.
 *
 * Framing Specification:
 * - Header: 4-byte big-endian unsigned 32-bit integer representing payload byte length.
 * - Body: UTF-8 encoded JSON string representing the MessageEnvelope.
 * - Max payload limit: 8 MB (MAX_FRAME_PAYLOAD_BYTES).
 *
 * Handles:
 * - TCP stream fragmentation (partial reads requiring chunk assembly)
 * - Frame coalescing (multiple frames packed into a single received TCP chunk)
 * - Malformed JSON rejection
 * - Oversize packet rejection to prevent memory exhaustion
 */

import { FRAME_HEADER_SIZE_BYTES, MAX_FRAME_PAYLOAD_BYTES } from '../constants.js';
import type { MessageEnvelope } from '../types/messages.js';

/**
 * Base error class for all protocol framing failures.
 */
export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FramingError';
  }
}

/**
 * Thrown when an incoming or outgoing frame exceeds MAX_FRAME_PAYLOAD_BYTES.
 */
export class FramePayloadTooLargeError extends FramingError {
  public readonly actualBytes: number;
  public readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number = MAX_FRAME_PAYLOAD_BYTES) {
    super(
      `Frame payload of ${actualBytes} bytes exceeds maximum permissible limit of ${maxBytes} bytes`,
    );
    this.name = 'FramePayloadTooLargeError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown when a complete frame's body cannot be parsed as valid UTF-8 JSON.
 */
export class MalformedFrameError extends FramingError {
  public readonly rawPayload: string;

  constructor(message: string, rawPayload: string) {
    super(`Malformed frame payload: ${message}`);
    this.name = 'MalformedFrameError';
    this.rawPayload = rawPayload;
  }
}

/**
 * Encodes a message envelope or payload into a 4-byte length-prefixed binary Buffer.
 *
 * @param message The JavaScript object or JSON string to frame.
 * @param maxBytes Maximum allowed byte length (defaults to MAX_FRAME_PAYLOAD_BYTES).
 * @returns A Buffer containing the 4-byte big-endian length prefix followed by UTF-8 bytes.
 * @throws {FramePayloadTooLargeError} If the encoded payload exceeds maxBytes.
 */
export function encodeFrame(
  message: object | string,
  maxBytes: number = MAX_FRAME_PAYLOAD_BYTES,
): Buffer {
  const jsonString = typeof message === 'string' ? message : JSON.stringify(message);
  const payloadBuffer = Buffer.from(jsonString, 'utf-8');

  if (payloadBuffer.length > maxBytes) {
    throw new FramePayloadTooLargeError(payloadBuffer.length, maxBytes);
  }

  const frameBuffer = Buffer.allocUnsafe(FRAME_HEADER_SIZE_BYTES + payloadBuffer.length);
  frameBuffer.writeUInt32BE(payloadBuffer.length, 0);
  payloadBuffer.copy(frameBuffer, FRAME_HEADER_SIZE_BYTES);

  return frameBuffer;
}

/**
 * Event listener types for the FrameDecoder.
 */
export type FrameListener<T = unknown> = (frame: MessageEnvelope<T>) => void;
export type ErrorListener = (error: Error) => void;

/**
 * Stateful stream decoder that ingests raw TCP chunks and reconstructs complete message envelopes.
 *
 * Can be used imperatively by calling `feed(chunk)` which returns an array of completed messages,
 * or via event listeners (`on('frame', ...)` and `on('error', ...)`).
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;
  private frameListeners: Set<FrameListener<unknown>> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();

  /**
   * @param maxBytes Upper limit for a single frame payload in bytes.
   */
  constructor(maxBytes: number = MAX_FRAME_PAYLOAD_BYTES) {
    this.maxBytes = maxBytes;
  }

  /**
   * Registers a listener for successfully decoded frames or errors.
   */
  public on(event: 'frame', listener: FrameListener<unknown>): this;
  public on(event: 'error', listener: ErrorListener): this;
  public on(event: 'frame' | 'error', listener: FrameListener<unknown> | ErrorListener): this {
    if (event === 'frame') {
      this.frameListeners.add(listener as FrameListener<unknown>);
    } else if (event === 'error') {
      this.errorListeners.add(listener as ErrorListener);
    }
    return this;
  }

  /**
   * Removes an existing event listener.
   */
  public off(event: 'frame', listener: FrameListener<unknown>): this;
  public off(event: 'error', listener: ErrorListener): this;
  public off(event: 'frame' | 'error', listener: FrameListener<unknown> | ErrorListener): this {
    if (event === 'frame') {
      this.frameListeners.delete(listener as FrameListener<unknown>);
    } else if (event === 'error') {
      this.errorListeners.delete(listener as ErrorListener);
    }
    return this;
  }

  private emitFrame(frame: MessageEnvelope<unknown>): void {
    for (const listener of this.frameListeners) {
      listener(frame);
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  /**
   * Ingests a raw TCP chunk from a socket and extracts any complete frames.
   *
   * @param chunk The raw Buffer received from socket.on('data')
   * @returns Array of successfully parsed MessageEnvelope objects in this chunk pass
   */
  public feed<T = unknown>(chunk: Buffer): MessageEnvelope<T>[] {
    if (chunk.length === 0) {
      return [];
    }

    // Accumulate incoming bytes
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    const decodedMessages: MessageEnvelope<T>[] = [];

    while (this.buffer.length >= FRAME_HEADER_SIZE_BYTES) {
      // Inspect the 4-byte unsigned big-endian length prefix
      const payloadLength = this.buffer.readUInt32BE(0);

      // Enforce protocol size limits
      if (payloadLength > this.maxBytes) {
        const err = new FramePayloadTooLargeError(payloadLength, this.maxBytes);
        // Clear buffer on oversize violation to prevent unrecoverable state
        this.reset();
        this.emitError(err);
        throw err;
      }

      const totalFrameBytes = FRAME_HEADER_SIZE_BYTES + payloadLength;

      // Check if we have received the full frame payload
      if (this.buffer.length < totalFrameBytes) {
        // Incomplete frame (fragmentation): wait for subsequent TCP chunks
        break;
      }

      // Extract the frame's payload
      const payloadBytes = this.buffer.subarray(FRAME_HEADER_SIZE_BYTES, totalFrameBytes);

      // Advance buffer pointer past the consumed frame
      this.buffer = this.buffer.subarray(totalFrameBytes);

      const rawJson = payloadBytes.toString('utf-8');

      try {
        const parsed = JSON.parse(rawJson) as MessageEnvelope<T>;
        decodedMessages.push(parsed);
        this.emitFrame(parsed as MessageEnvelope<unknown>);
      } catch (parseError) {
        const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
        const malformedErr = new MalformedFrameError(errorMsg, rawJson);
        this.emitError(malformedErr);
      }
    }

    return decodedMessages;
  }

  /**
   * Returns the count of pending, unconsumed bytes currently held in the internal accumulation buffer.
   */
  public getPendingBytes(): number {
    return this.buffer.length;
  }

  /**
   * Resets the internal accumulation buffer, discarding any partial frame data.
   */
  public reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
