/**
 * @fileoverview Role-based access control definitions for room participants.
 */

/**
 * Access levels for participants in a whiteboard room.
 * - HOST: Creator or designated owner. Can draw, edit, clear canvas, kick users, change roles, lock room.
 * - EDITOR: Active collaborator. Can draw, edit objects, create shapes, and chat.
 * - VIEWER: Read-only observer. Can observe canvas updates and chat, but cannot alter the board.
 */
export const Role = {
  HOST: 'HOST',
  EDITOR: 'EDITOR',
  VIEWER: 'VIEWER',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

/**
 * Helper to determine whether a role has authorization to mutate the canvas state
 * (drawing strokes, adding/updating/deleting shapes, clearing canvas, erasing).
 *
 * @param role The participant's role
 * @returns true if role is HOST or EDITOR, false if VIEWER
 */
export function canMutateCanvas(role: Role): boolean {
  return role === Role.HOST || role === Role.EDITOR;
}

/**
 * Helper to determine whether a role has administrative authority in the room
 * (clearing canvas, kicking participants, locking the room, changing participant roles).
 *
 * @param role The participant's role
 * @returns true if role is HOST
 */
export function isHost(role: Role): boolean {
  return role === Role.HOST;
}

