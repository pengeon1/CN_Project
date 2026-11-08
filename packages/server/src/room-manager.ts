/**
 * @fileoverview Room lifecycle manager, 6-character room code generator,
 * password hashing, and active room registry.
 */

import * as crypto from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import { Room } from './room.js';
import type { ClientSession } from './session.js';

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private logger = new Logger('RoomManager');

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
    return new Promise((resolve, reject) => {
      const [salt, key] = storedHash.split(':');
      if (!salt || !key) return resolve(false);

      crypto.scrypt(password, salt, 64, (err, derivedKey) => {
        if (err) return reject(err);
        const keyBuffer = Buffer.from(key, 'hex');
        resolve(crypto.timingSafeEqual(keyBuffer, derivedKey));
      });
    });
  }

  /**
   * Creates a new collaborative whiteboard room with the specified host.
   */
  public async createRoom(
    session: ClientSession,
    roomName: string,
    username: string,
    password?: string,
  ): Promise<Room> {
    const code = this.generateRoomCode();
    let passwordHash: string | null = null;

    if (password && password.trim().length > 0) {
      passwordHash = await this.hashPassword(password.trim());
    }

    const room = new Room(code, roomName, session.userId, passwordHash);
    this.rooms.set(code, room);

    room.addParticipant(session, username);
    this.logger.info(`Created new room "${roomName}" [Code: ${code}] hosted by ${username}`);

    return room;
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
    const normalizedCode = roomCode.trim().toUpperCase();
    const room = this.rooms.get(normalizedCode);

    if (!room) {
      throw new Error(`Room with code "${normalizedCode}" not found`);
    }

    const resumed = room.canResume(sessionToken ?? session.sessionId);

    // A lock only keeps *new* participants out; people who were already in may always come back.
    if (room.locked && !resumed) {
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

    room.addParticipant(session, username, undefined, sessionToken);
    return { room, resumed };
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
        this.logger.info(
          `Room [${room.code}] is now empty; retaining room in memory for reconnects.`,
        );
      }
    }

    session.roomCode = null;
  }

  /**
   * Retrieves a room by its 6-character code.
   */
  public getRoom(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  /**
   * Returns the count of active rooms.
   */
  public get roomCount(): number {
    return this.rooms.size;
  }
}
