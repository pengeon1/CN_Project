/**
 * @fileoverview Data models representing whiteboard canvas entities, participants, and operations.
 */

import type { Role } from './roles.js';

/**
 * 2D coordinate representing a point on the whiteboard canvas.
 */
export interface Point {
  x: number;
  y: number;
  /**
   * Optional pen pressure normalized between 0.0 and 1.0 (defaults to 0.5).
   */
  pressure?: number;
}

/**
 * Supported geometric shapes and semantic canvas elements.
 */
export const ShapeType = {
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  LINE: 'line',
  ARROW: 'arrow',
  CONNECTOR: 'connector',
  TEXT: 'text',
  STICKY_NOTE: 'sticky_note',
} as const;

export type ShapeType = (typeof ShapeType)[keyof typeof ShapeType];

/** Cardinal edge anchor side on a canvas shape/object for smart connector binding. */
export type AnchorSide = 'top' | 'bottom' | 'left' | 'right';

/** Reference linking one end of a connector to an anchor edge on another object. */
export interface AnchorRef {
  objectId: string;
  side: AnchorSide;
}

/**
 * Common properties shared across all whiteboard objects on the canvas.
 */
export interface BaseWhiteboardObject {
  /**
   * Unique client-generated identifier for the object (UUID).
   */
  id: string;
  /**
   * User ID of the participant who authored the object.
   */
  authorId: string;
  /**
   * Server sequence number at which the object was created or last updated.
   */
  seq: number;
  /**
   * Z-index order for layering objects on the 2D canvas.
   */
  zIndex: number;
  /**
   * Timestamp in epoch milliseconds when the object was last modified.
   */
  updatedAt: number;
}

/**
 * Freehand stroke object produced by the pen tool.
 */
export interface StrokeObject extends BaseWhiteboardObject {
  type: 'stroke';
  /**
   * Stroke stroke color in hex format (e.g. #000000).
   */
  color: string;
  /**
   * Stroke stroke width in canvas pixels.
   */
  width: number;
  /**
   * Array of coordinates comprising the freehand path.
   */
  points: Point[];
  /**
   * Whether stroke drawing is finalized (false during live optimistic batching).
   */
  isComplete: boolean;
}

/**
 * Geometric shape or text/sticky note object.
 */
export interface ShapeObject extends BaseWhiteboardObject {
  type: 'shape';
  shapeType: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  startAnchor?: AnchorRef;
  endAnchor?: AnchorRef;
}

/**
 * Raster image. Only metadata lives in the object; the bytes are an asset on the server, fetched
 * by `assetId`, so snapshots and the ops log stay small.
 */
export interface ImageObject extends BaseWhiteboardObject {
  type: 'image';
  assetId: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Decoded size in bytes (informational, checked against the stored asset). */
  bytes: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Discriminated union of all whiteboard canvas objects.
 */
export type WhiteboardObject = StrokeObject | ShapeObject | ImageObject;

/**
 * Represents a connected user in a session room.
 */
export interface Participant {
  id: string;
  username: string;
  role: Role;
  color: string;
  joinedAt: number;
}

/**
 * Ephemeral cursor state broadcast across clients. Not persisted in the operations log.
 */
export interface RemoteCursor {
  userId: string;
  username: string;
  color: string;
  x: number;
  y: number;
  activeTool?: string;
  pressure?: number;
}

/**
 * Text chat message within a session room.
 */
export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  color: string;
  text: string;
  ts: number;
  /**
   * Flag indicating an automated system notification (e.g. participant joined/left).
   */
  isSystem?: boolean;
}

/**
 * Host-driven presentation: followers mirror the host's viewport while `active`.
 * `viewport.x/y` is the world coordinate at the centre of the host's view, so differently
 * sized windows show the same content in the middle.
 */
export interface PresentationState {
  active: boolean;
  viewport?: { x: number; y: number; zoom: number };
}

/** Listing entry for a saved board version (the object data stays on the server). */
export interface VersionMeta {
  id: string;
  name: string;
  ts: number;
  createdBy: string | null;
  /** true for automatic snapshots, false for ones the host named. */
  auto: boolean;
  objectCount: number;
}

/**
 * Fully materialized room snapshot sent during late-join sync or room state export.
 */
export interface RoomSnapshot {
  roomCode: string;
  roomName: string;
  seq: number;
  objects: Record<string, WhiteboardObject>;
  participants: Participant[];
  chatHistory: ChatMessage[];
  locked: boolean;
  allowNameChanges?: boolean;
  presentation?: PresentationState;
  createdAt: number;
}
