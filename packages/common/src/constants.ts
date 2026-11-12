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
 * Maximum number of operations retained in the server-side operations log before triggering compaction.
 */
export const MAX_OPS_LOG_SIZE = 1000;

/**
 * Number of recent operations retained in the operations log after compaction.
 */
export const COMPACT_RETAIN_OPS = 500;

/**
 * Most named/automatic board versions a room keeps (oldest automatic ones are evicted first).
 */
export const MAX_VERSIONS = 20;

/**
 * Minimum time between automatic version snapshots, and only taken when the board changed.
 */
export const VERSION_AUTO_INTERVAL_MS = 5 * 60 * 1000;

export const MAX_VERSION_NAME_LENGTH = 60;

/**
 * Presentation viewport re-send interval while presenting, and how long a follower waits
 * without an update before concluding the presentation ended (covers a lost "stop" message).
 */
export const PRESENTATION_HEARTBEAT_MS = 2000;
export const PRESENTATION_STALE_MS = 8000;

/**
 * Largest accepted image after client-side downscaling/re-encoding (decoded bytes).
 * Clients shrink to fit; the server enforces it again because it never trusts the client.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Raw bytes carried per IMAGE_UPLOAD / IMAGE_DATA chunk (base64 inflates it by ~4/3), far below
 * the 8 MB frame limit so chunks interleave with drawing traffic instead of blocking it.
 */
export const IMAGE_CHUNK_BYTES = 48 * 1024;

/**
 * Total decoded image bytes one room may hold, bounding server memory and the save file.
 */
export const MAX_ROOM_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Longest side, in pixels, that clients downscale inserted images to.
 */
export const MAX_IMAGE_DIMENSION = 1600;

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
export const APP_VERSION = '1.0.3';
