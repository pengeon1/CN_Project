/**
 * @fileoverview Room lifecycle manager, 6-character room code generator,
 * password hashing, and active room registry.
 */

import * as crypto from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import { Room, type PersistedRoomState } from './room.js';
import type { ClientSession } from './session.js';

const JOIN_FAILURE_LIMIT = 5;
const JOIN_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_EMPTY_ROOM_TTL_MS = 60_000;

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private emptyRoomTimers: Map<string, NodeJS.Timeout> = new Map();
  private failedJoinAttempts = new Map<string, number[]>();
  private logger = new Logger('RoomManager');
  private readonly onRoomChange: (room: Room) => void;
  private readonly emptyRoomTtlMs: number;

  /**
   * Creates the room registry and installs its durable-change callback.
   */
  constructor(onRoomChange: (room: Room) => void, emptyRoomTtlMs = DEFAULT_EMPTY_ROOM_TTL_MS) {
    this.onRoomChange = onRoomChange;
    this.emptyRoomTtlMs = emptyRoomTtlMs;
  }

  /**
   * Generates a collision-free 6-character room code using the unambiguous alphabet.
   */
  public generateRoomCode(): string {
    const alphabetLength = ROOM_CODE_ALPHABET.length;
    let code: string;
    let attempts = 0;

    do {
      let candidate = '';
      const randomBytes = crypto.randomBytes(ROOM_CODE_LENGTH);
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        const byte = randomBytes[i]!;
        candidate += ROOM_CODE_ALPHABET[byte % alphabetLength];
      }
      code = candidate;
      attempts++;
      if (attempts > 1000) {
        throw new Error('Failed to allocate unique room code after 1000 attempts');
      }
    } while (this.rooms.has(code));

    return code;
  }

  /**
   * Cryptographically hashes a password using Node.js scrypt with a random salt.
   */
  public async hashPassword(password: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const salt = crypto.randomBytes(16).toString('hex');
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`${salt}:${derivedKey.toString('hex')}`);
      });
    });
  }

  /**
   * Verifies a candidate plaintext password against an existing scrypt salt:hash string.
   */
  public async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const [salt, key, extra] = storedHash.split(':');
    if (
      !salt ||
      !/^[0-9a-f]{32}$/i.test(salt) ||
      !key ||
      !/^[0-9a-f]{128}$/i.test(key) ||
      extra !== undefined
    ) {
      return false;
    }

    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        const keyBuffer = Buffer.from(key, 'hex');
        resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
      });
    });
  }

  private checkJoinRateLimit(remoteIp: string): void {
    const now = Date.now();
    for (const [ip, attempts] of this.failedJoinAttempts) {
      const recentAttempts = attempts.filter(
        (timestamp) => now - timestamp < JOIN_FAILURE_WINDOW_MS,
      );
      if (recentAttempts.length > 0) {
        this.failedJoinAttempts.set(ip, recentAttempts);
      } else {
        this.failedJoinAttempts.delete(ip);
      }
    }

    const attempts = this.failedJoinAttempts.get(remoteIp) ?? [];
    if (attempts.length >= JOIN_FAILURE_LIMIT) {
      const retryAfterSeconds = Math.ceil((attempts[0]! + JOIN_FAILURE_WINDOW_MS - now) / 1000);
      throw new Error(
        `Too many failed room join attempts. Try again in ${retryAfterSeconds} seconds.`,
      );
    }
  }

  private recordFailedJoin(remoteIp: string): void {
    const attempts = this.failedJoinAttempts.get(remoteIp) ?? [];
    attempts.push(Date.now());
    this.failedJoinAttempts.set(remoteIp, attempts);
  }

  /**
   * Creates a new collaborative whiteboard room with the specified host.
   */
  public async createRoom(
    session: ClientSession,
    roomName: string,
    username: string,
    password?: string,
    allowNameChanges = false,
  ): Promise<Room> {
    const code = this.generateRoomCode();
    let passwordHash: string | null = null;

    if (password && password.trim().length > 0) {
      passwordHash = await this.hashPassword(password.trim());
    }

    const room = new Room(
      code,
      roomName,
      session.userId,
      passwordHash,
      Date.now(),
      allowNameChanges,
    );
    room.setOnChange(this.onRoomChange);
    this.rooms.set(code, room);

    room.addParticipant(session, username);
    this.logger.info(`Created new room "${roomName}" [Code: ${code}] hosted by ${username}`);

    return room;
  }

  /**
   * Registers validated persisted rooms before clients can connect.
   */
  public restoreRooms(states: PersistedRoomState[]): void {
    for (const state of states) {
      if (this.rooms.has(state.roomCode)) {
        throw new Error(`Duplicate persisted room code: ${state.roomCode}`);
      }

      const room = new Room(
        state.roomCode,
        state.roomName,
        state.hostUserId,
        state.passwordHash,
        state.createdAt,
        state.allowNameChanges ?? false,
      );
      room.restorePersistedState(state, { restoredFromDisk: true });
      room.setOnChange(this.onRoomChange);
      this.rooms.set(room.code, room);
      this.logger.info(`Restored room "${room.name}" [Code: ${room.code}]`);
    }
  }

  /**
   * Admits a participant to an existing room after validating access codes and credentials.
   * If sessionToken is provided, attempts to resume a previously disconnected participant identity.
   *
   * @returns The room, and whether the participant resumed an existing identity (as opposed to
   *   joining as a new participant). A resumed participant that supplies the sequence number it
   *   last applied can be caught up with an incremental resync instead of a full snapshot.
   */
  public async joinRoom(
    session: ClientSession,
    roomCode: string,
    username: string,
    password?: string,
    sessionToken?: string,
  ): Promise<{ room: Room; resumed: boolean }> {
    this.checkJoinRateLimit(session.remoteIp);
    try {
      const normalizedCode = roomCode.trim().toUpperCase();
      const room = this.rooms.get(normalizedCode);

      if (!room) {
        throw new Error(`Room with code "${normalizedCode}" not found`);
      }

      const token = sessionToken ?? session.sessionId;
      if (room.wasKicked(token)) {
        throw new Error('You have been removed from this room');
      }
      const resumed = room.canResume(token);

      // A lock only keeps *new* participants out; people who were already in may always come back.
      if (room.locked && !resumed && !room.isAwaitingRestoredHost) {
        throw new Error(`Room "${normalizedCode}" is currently locked by the host`);
      }

      if (room.passwordHash) {
        if (!password) {
          throw new Error('This room requires a password');
        }
        const isValid = await this.verifyPassword(password, room.passwordHash);
        if (!isValid) {
          throw new Error('Incorrect room password');
        }
      }

      // If participant is already in this or another room, leave it first
      if (session.roomCode && session.roomCode !== normalizedCode) {
        this.leaveRoom(session, 'Switching rooms');
      }

      // Cancel pending auto-close timer if participant rejoins
      const pendingTimer = this.emptyRoomTimers.get(normalizedCode);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.emptyRoomTimers.delete(normalizedCode);
      }

      room.addParticipant(session, username, undefined, sessionToken);
      return { room, resumed };
    } catch (error) {
      this.recordFailedJoin(session.remoteIp);
      throw error;
    }
  }

  /**
   * Handles client departure from their active room.
   */
  public leaveRoom(session: ClientSession, reason?: string): void {
    if (!session.roomCode) return;

    const room = this.rooms.get(session.roomCode);
    if (room) {
      // Passing the session guarantees that a stale connection closing late cannot evict a
      // participant who has already resumed on a newer connection.
      room.removeParticipant(session.userId, reason, session);
      if (room.participantCount === 0) {
        this.scheduleEmptyRoomCleanup(room.code);
      }
    }

    session.roomCode = null;
  }

  /**
   * Schedules automatic closure and memory release for a room that has zero active participants.
   */
  private scheduleEmptyRoomCleanup(code: string): void {
    if (this.emptyRoomTimers.has(code)) return;
    this.logger.info(
      `Room [${code}] is now empty; scheduling auto-closure in ${Math.round(this.emptyRoomTtlMs / 1000)}s if not resumed.`,
    );
    const timer = setTimeout(() => {
      this.emptyRoomTimers.delete(code);
      const room = this.rooms.get(code);
      if (room && room.participantCount === 0) {
        this.closeRoom(code, 'Inactivity timeout');
      }
    }, this.emptyRoomTtlMs);
    timer.unref?.();
    this.emptyRoomTimers.set(code, timer);
  }

  /**
   * Manually or automatically closes and deletes a room from the active registry.
   */
  public closeRoom(code: string, reason = 'Room closed'): boolean {
    const normalizedCode = code.trim().toUpperCase();
    const pendingTimer = this.emptyRoomTimers.get(normalizedCode);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.emptyRoomTimers.delete(normalizedCode);
    }
    const room = this.rooms.get(normalizedCode);
    if (!room) return false;
    this.rooms.delete(normalizedCode);
    this.logger.info(`Closed and removed room [${normalizedCode}]: ${reason}`);
    return true;
  }

  /**
   * Retrieves a room by its 6-character code.
   */
  public getRoom(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  /**
   * Returns the total count of rooms in memory.
   */
  public get roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Returns the count of rooms that currently have active connected participants.
   */
  public get activeRoomCount(): number {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.participantCount > 0) count++;
    }
    return count;
  }
}
