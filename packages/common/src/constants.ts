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
 * Application metadata and branding constants.
 */
export const APP_NAME = 'LAN Collaborative Whiteboard';
export const APP_VERSION = '0.1.0';
