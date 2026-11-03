/**
 * @fileoverview System-wide constants shared across client and server.
 * Defines networking ports, protocol limits, timing thresholds, and defaults.
 */

/**
 * Default TCP port for whiteboard server operations.
 * Port 4000 is chosen as an unprivileged, standard port commonly accessible on local LANs.
 */
export const DEFAULT_SERVER_PORT = 4000;

/**
 * Default host binding to listen on all IPv4 network interfaces.
 */
export const DEFAULT_SERVER_HOST = '0.0.0.0';

/**
 * Protocol version identifier.
 * Clients and servers verify protocol compatibility during initial handshake.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Maximum transmission frame length in bytes (8 MB).
 * Enforces a strict upper boundary on frame sizes to protect the TCP server
 * from memory exhaustion attacks or oversized malformed packets.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Length in bytes of the big-endian unsigned length prefix prepending every message frame.
 */
export const FRAME_HEADER_SIZE_BYTES = 4;

/**
 * Interval in milliseconds between PING heartbeat transmissions.
 */
export const HEARTBEAT_INTERVAL_MS = 5000; // 5 seconds

/**
 * Maximum elapsed time in milliseconds of silence from a client before the server drops the socket.
 */
export const HEARTBEAT_TIMEOUT_MS = 15000; // 15 seconds

/**
 * Client-side interval in milliseconds for batching drawn stroke points before sending.
 * Balances smooth visual representation with network transmission overhead.
 */
export const STROKE_BATCH_INTERVAL_MS = 20; // 50 Hz

/**
 * Minimum interval in milliseconds between broadcast cursor movement events.
 * High-frequency cursor tracking without congesting the TCP socket stream.
 */
export const CURSOR_THROTTLE_MS = 33; // ~30 Hz

/**
 * Required length of a session room code.
 */
export const ROOM_CODE_LENGTH = 6;

/**
 * Unambiguous alphanumeric alphabet for generating room codes.
 * Omits easily confused glyphs (0, O, 1, I, L) to eliminate user transcription errors.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Maximum allowed length for a participant's display username.
 */
export const MAX_USERNAME_LENGTH = 32;

/**
 * Minimum allowed length for a participant's display username.
 */
export const MIN_USERNAME_LENGTH = 1;

/**
 * Maximum characters permitted per chat message.
 */
export const MAX_CHAT_MESSAGE_LENGTH = 2000;

/**
 * Maximum count of past chat messages retained in memory and sent during initial room state synchronization.
 */
export const MAX_CHAT_HISTORY_SIZE = 200;

/**
 * Maximum number of incremental operations returned in a RESYNC_RESPONSE.
 * If a client has fallen further behind, the server supplies a full ROOM_STATE snapshot instead.
 */
export const MAX_RESYNC_OPS_WINDOW = 500;

/**
 * Standard palette of distinct participant cursor and avatar colors.
 */
export const PARTICIPANT_COLORS = [
  '#EF4444', // Red
  '#F97316', // Orange
  '#F59E0B', // Amber
  '#10B981', // Emerald
  '#06B6D4', // Cyan
  '#3B82F6', // Blue
  '#6366F1', // Indigo
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#14B8A6', // Teal
] as const;

/**
 * Application metadata and branding constants.
 */
export const APP_NAME = 'LAN Collaborative Whiteboard';
export const APP_VERSION = '0.1.0';
