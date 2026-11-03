import { describe, expect, it } from 'vitest';
import {
  APP_NAME,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  FRAME_HEADER_SIZE_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from '../src/index.js';

describe('Common constants sanity suite', () => {
  it('exposes valid network defaults and framing limits', () => {
    expect(APP_NAME).toBe('LAN Collaborative Whiteboard');
    expect(DEFAULT_SERVER_PORT).toBe(4000);
    expect(DEFAULT_SERVER_HOST).toBe('0.0.0.0');
    expect(PROTOCOL_VERSION).toBe(1);
    expect(FRAME_HEADER_SIZE_BYTES).toBe(4);
    expect(MAX_FRAME_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
  });
});
