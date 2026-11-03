import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  FramePayloadTooLargeError,
  MalformedFrameError,
  MAX_FRAME_PAYLOAD_BYTES,
} from '../src/index.js';

describe('Framing: Length-Prefixed Binary Protocol', () => {
  it('encodes and decodes a single frame correctly', () => {
    const message = { hello: 'world', count: 42 };
    const encoded = encodeFrame(message);

    // Verify 4-byte header indicates correct payload length
    const payloadLength = encoded.readUInt32BE(0);
    const expectedPayload = Buffer.from(JSON.stringify(message), 'utf-8');
    expect(payloadLength).toBe(expectedPayload.length);
    expect(encoded.length).toBe(4 + expectedPayload.length);

    // Decode with FrameDecoder
    const decoder = new FrameDecoder();
    const decoded = decoder.feed(encoded);

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(message);
    expect(decoder.getPendingBytes()).toBe(0);
  });

  it('handles coalesced frames packed into a single chunk', () => {
    const msg1 = { id: 1, action: 'start' };
    const msg2 = { id: 2, action: 'draw' };
    const msg3 = { id: 3, action: 'stop' };

    const chunk = Buffer.concat([encodeFrame(msg1), encodeFrame(msg2), encodeFrame(msg3)]);

    const decoder = new FrameDecoder();
    const decoded = decoder.feed(chunk);

    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toEqual(msg1);
    expect(decoded[1]).toEqual(msg2);
    expect(decoded[2]).toEqual(msg3);
    expect(decoder.getPendingBytes()).toBe(0);
  });

  it('handles fragmented reads split byte-by-byte (extreme network fragmentation)', () => {
    const message = { text: 'A quick brown fox jumps over the lazy dog', timestamp: 123456789 };
    const encoded = encodeFrame(message);

    const decoder = new FrameDecoder();
    const allDecoded: unknown[] = [];

    // Feed one byte at a time
    for (let i = 0; i < encoded.length; i++) {
      const singleByte = encoded.subarray(i, i + 1);
      const frames = decoder.feed(singleByte);
      allDecoded.push(...frames);
    }

    expect(allDecoded).toHaveLength(1);
    expect(allDecoded[0]).toEqual(message);
    expect(decoder.getPendingBytes()).toBe(0);
  });

  it('handles arbitrary chunk fragmentation (split header and body)', () => {
    const message = { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
    const encoded = encodeFrame(message);

    const part1 = encoded.subarray(0, 2); // 2 bytes of the 4-byte header
    const part2 = encoded.subarray(2, 10); // remaining 2 bytes of header + 6 bytes of body
    const part3 = encoded.subarray(10); // remaining body

    const decoder = new FrameDecoder();

    expect(decoder.feed(part1)).toEqual([]);
    expect(decoder.getPendingBytes()).toBe(2);

    expect(decoder.feed(part2)).toEqual([]);
    expect(decoder.getPendingBytes()).toBe(10);

    const finalFrames = decoder.feed(part3);
    expect(finalFrames).toEqual([message]);
    expect(decoder.getPendingBytes()).toBe(0);
  });

  it('rejects oversize frames when encoding and decoding', () => {
    const smallLimit = 100; // 100 bytes limit for test
    const largeMessage = { data: 'X'.repeat(200) };

    // Encoding oversize frame should throw FramePayloadTooLargeError
    expect(() => encodeFrame(largeMessage, smallLimit)).toThrow(FramePayloadTooLargeError);

    // Decoding oversize frame should throw FramePayloadTooLargeError and reset buffer
    const encodedLarge = encodeFrame(largeMessage, MAX_FRAME_PAYLOAD_BYTES);
    const decoder = new FrameDecoder(smallLimit);

    expect(() => decoder.feed(encodedLarge)).toThrow(FramePayloadTooLargeError);
    expect(decoder.getPendingBytes()).toBe(0);
  });

  it('detects and recovers from malformed JSON payloads', () => {
    const invalidJsonString = '{"broken": json without quotes}';
    const payloadBuffer = Buffer.from(invalidJsonString, 'utf-8');
    const corruptedFrame = Buffer.alloc(4 + payloadBuffer.length);
    corruptedFrame.writeUInt32BE(payloadBuffer.length, 0);
    payloadBuffer.copy(corruptedFrame, 4);

    const validMsg = { valid: true };
    const combinedChunk = Buffer.concat([corruptedFrame, encodeFrame(validMsg)]);

    const decoder = new FrameDecoder();
    const errorList: Error[] = [];
    decoder.on('error', (err) => errorList.push(err));

    const decoded = decoder.feed(combinedChunk);

    expect(errorList).toHaveLength(1);
    expect(errorList[0]).toBeInstanceOf(MalformedFrameError);
    expect(decoded).toEqual([validMsg]);
    expect(decoder.getPendingBytes()).toBe(0);
  });
});

