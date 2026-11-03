/**
 * @fileoverview Room state container, participant coordinator, sequence sequencing,
 * whiteboard object store, and operation serial queue implementation.
 */

import {
  createEnvelope,
  type MessageEnvelope,
  MessageType,
  type Participant,
  PARTICIPANT_COLORS,
  type Point,
  Role,
  type RoomSnapshot,
  type StrokeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import type { ClientSession } from './session.js';

export interface RoomParticipantEntry {
  session: ClientSession;
  participant: Participant;
}

/**
 * Represents an active whiteboard room on the server.
 */
export class Room {
  public readonly code: string;
  public readonly name: string;
  public readonly createdAt: number;
  public hostUserId: string;
  public locked: boolean = false;
  public passwordHash: string | null = null;

  /**
   * Monotonically increasing sequence counter for all sequenced actions in this room.
   */
  public seq: number = 0;

  private participants: Map<string, RoomParticipantEntry> = new Map();
  private objects: Map<string, WhiteboardObject> = new Map();
  private processedOpIds: Set<string> = new Set();
  private colorIndex: number = 0;
  private serialQueue: Promise<void> = Promise.resolve();
  private logger: Logger;

  constructor(code: string, name: string, hostUserId: string, passwordHash?: string | null) {
    this.code = code;
    this.name = name;
    this.hostUserId = hostUserId;
    this.passwordHash = passwordHash ?? null;
    this.createdAt = Date.now();
    this.logger = new Logger(`Room ${code}`);
  }

  /**
   * Serializes operations through a promise chain so state mutations occur strictly in FIFO order.
   * Prevents race conditions across the Node.js event loop.
   */
  public enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.serialQueue = this.serialQueue
        .then(async () => {
          const result = await task();
          resolve(result);
        })
        .catch((err) => {
          this.logger.error('Error executing queued room task:', err);
          reject(err);
        });
    });
  }

  /**
   * Increments and returns the next monotonic sequence number for this room.
   */
  public nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Checks whether an operation with op_id has already been processed (idempotency check).
   */
  public hasProcessedOp(opId: string): boolean {
    return this.processedOpIds.has(opId);
  }

  /**
   * Records an op_id as processed, bounding the retention set to the most recent 10,000 ops.
   */
  public markOpProcessed(opId: string): void {
    if (this.processedOpIds.size > 10000) {
      const first = this.processedOpIds.values().next().value;
      if (first) this.processedOpIds.delete(first);
    }
    this.processedOpIds.add(opId);
  }

  /**
   * Creates a new StrokeObject and registers it into the room's canvas state.
   */
  public applyStrokeBegin(
    opId: string,
    strokeId: string,
    authorId: string,
    color: string,
    width: number,
    startPoint: Point,
  ): StrokeObject {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      if (existing && existing.type === 'stroke') {
        return existing;
      }
    }
    this.markOpProcessed(opId);
    const seq = this.nextSeq();
    const stroke: StrokeObject = {
      id: strokeId,
      authorId,
      seq,
      zIndex: this.objects.size + 1,
      updatedAt: Date.now(),
      type: 'stroke',
      color,
      width,
      points: [startPoint],
      isComplete: false,
    };
    this.objects.set(strokeId, stroke);
    return stroke;
  }

  /**
   * Appends batched points to an active freehand stroke.
   */
  public applyStrokePoints(opId: string, strokeId: string, points: Point[]): StrokeObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      return existing && existing.type === 'stroke' ? existing : null;
    }
    this.markOpProcessed(opId);
    const obj = this.objects.get(strokeId);
    if (!obj || obj.type !== 'stroke') {
      return null;
    }
    const seq = this.nextSeq();
    obj.seq = seq;
    obj.updatedAt = Date.now();
    obj.points.push(...points);
    return obj;
  }

  /**
   * Finalizes a freehand stroke and marks it complete.
   */
  public applyStrokeEnd(opId: string, strokeId: string, finalPoint?: Point): StrokeObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      return existing && existing.type === 'stroke' ? existing : null;
    }
    this.markOpProcessed(opId);
    const obj = this.objects.get(strokeId);
    if (!obj || obj.type !== 'stroke') {
      return null;
    }
    const seq = this.nextSeq();
    obj.seq = seq;
    obj.updatedAt = Date.now();
    if (finalPoint) {
      obj.points.push(finalPoint);
    }
    obj.isComplete = true;
    return obj;
  }

  public getObject(id: string): WhiteboardObject | undefined {
    return this.objects.get(id);
  }

  /**
   * Selects an accent color for a new participant from the predefined palette.
   */
  private pickColor(): string {
    const color = PARTICIPANT_COLORS[this.colorIndex % PARTICIPANT_COLORS.length]!;
    this.colorIndex += 1;
    return color;
  }

  /**
   * Registers a connected client as a room participant.
   */
  public addParticipant(session: ClientSession, username: string, role?: Role): Participant {
    const assignedRole = role ?? (this.participants.size === 0 ? Role.HOST : Role.EDITOR);
    const assignedColor = session.color ?? this.pickColor();

    const participant: Participant = {
      id: session.userId,
      username,
      role: assignedRole,
      color: assignedColor,
      joinedAt: Date.now(),
    };

    session.username = username;
    session.role = assignedRole;
    session.color = assignedColor;
    session.roomCode = this.code;

    // Broadcast PARTICIPANT_JOINED to existing peers
    const joinedSeq = this.nextSeq();
    const joinedEnvelope = createEnvelope(
      MessageType.PARTICIPANT_JOINED,
      { participant },
      {
        room: this.code,
        user_id: session.userId,
        seq: joinedSeq,
      },
    );

    this.broadcast(joinedEnvelope);

    this.participants.set(session.userId, { session, participant });
    this.logger.info(
      `Participant joined: ${username} (${session.userId}) as ${assignedRole}. Total: ${this.participants.size}`,
    );

    return participant;
  }

  /**
   * Removes a participant from the room and broadcasts PARTICIPANT_LEFT.
   */
  public removeParticipant(userId: string, reason?: string): Participant | null {
    const entry = this.participants.get(userId);
    if (!entry) return null;

    this.participants.delete(userId);
    entry.session.roomCode = null;

    const leftSeq = this.nextSeq();
    const leftEnvelope = createEnvelope(
      MessageType.PARTICIPANT_LEFT,
      {
        userId,
        username: entry.participant.username,
        reason,
      },
      {
        room: this.code,
        user_id: userId,
        seq: leftSeq,
      },
    );

    this.broadcast(leftEnvelope);
    this.logger.info(
      `Participant left: ${entry.participant.username} (${userId}). Total remaining: ${this.participants.size}`,
    );

    // If the host departed, promote the oldest active participant to HOST
    if (this.hostUserId === userId && this.participants.size > 0) {
      const nextHostEntry = Array.from(this.participants.values())[0]!;
      nextHostEntry.participant.role = Role.HOST;
      nextHostEntry.session.role = Role.HOST;
      this.hostUserId = nextHostEntry.participant.id;

      const promoSeq = this.nextSeq();
      const promoEnvelope = createEnvelope(
        MessageType.PERMISSION_CHANGE,
        {
          targetUserId: nextHostEntry.participant.id,
          newRole: Role.HOST,
        },
        {
          room: this.code,
          user_id: this.hostUserId,
          seq: promoSeq,
        },
      );
      this.broadcast(promoEnvelope);
      this.logger.info(`Transferred room host ownership to: ${nextHostEntry.participant.username}`);
    }

    return entry.participant;
  }

  /**
   * Retrieves participant details by user ID.
   */
  public getParticipant(userId: string): Participant | undefined {
    return this.participants.get(userId)?.participant;
  }

  /**
   * Retrieves the client session for a given user ID.
   */
  public getSession(userId: string): ClientSession | undefined {
    return this.participants.get(userId)?.session;
  }

  /**
   * Returns a snapshot array of all active participants.
   */
  public getParticipants(): Participant[] {
    return Array.from(this.participants.values()).map((e) => e.participant);
  }

  /**
   * Returns the count of connected participants.
   */
  public get participantCount(): number {
    return this.participants.size;
  }

  /**
   * Broadcasts a MessageEnvelope to all participants in this room.
   *
   * @param envelope The MessageEnvelope to distribute.
   * @param excludeUserId Optional user ID to exclude from broadcast (e.g. sender of an optimistic action).
   */
  public broadcast(envelope: MessageEnvelope, excludeUserId?: string): void {
    for (const [userId, entry] of this.participants.entries()) {
      if (excludeUserId && userId === excludeUserId) {
        continue;
      }
      entry.session.send(envelope);
    }
  }

  /**
   * Generates a complete snapshot of the room state for late-join synchronization or export.
   */
  public getSnapshot(): RoomSnapshot {
    const objectsRecord: Record<string, WhiteboardObject> = {};
    for (const [id, obj] of this.objects.entries()) {
      objectsRecord[id] = obj;
    }

    return {
      roomCode: this.code,
      roomName: this.name,
      seq: this.seq,
      objects: objectsRecord,
      participants: this.getParticipants(),
      chatHistory: [],
      locked: this.locked,
      createdAt: this.createdAt,
    };
  }
}
